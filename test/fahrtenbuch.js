// End-to-End-Test für fahrtenbuch/index.html (Playwright, Chromium).
// Aufruf: node test/fahrtenbuch.js
// Alle Angaben hier sind erfunden (das Repo ist öffentlich).
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".png": "image/png" };
let failed = 0;
function ok(cond, name) { console.log((cond ? "  ok   " : "  FAIL ") + name); if (!cond) failed++; }
function b64u(obj) { return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url"); }
function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port + "/fahrtenbuch/";
  const browser = await chromium.launch();
  const year = new Date().getFullYear();
  const today = iso(new Date());

  // ---- 1. Leerer Start ohne Einrichtung
  let ctx = await browser.newContext({ locale: "de-CH", acceptDownloads: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  let page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base);
  ok(await page.locator("#t-other").isVisible(), "leerer Start zeigt «Andere Geschäftsfahrt»");
  ok(await page.locator("#t-setup").isVisible(), "leerer Start bietet «Ziele anlegen» an");
  ok((await page.locator("#sub").textContent()) === "Geschäftsfahrten", "Kopfzeile ohne Personendaten");
  await ctx.close();

  // ---- 2. Einrichtungslink
  const setup = { v: "Testwagen ZH 1", c: "Muster AG", s: "Musterdorf", h: "Nur Fahrten für die Muster AG.",
    p: [["Lager Nord", "Liegenschaft", 220], ["Bank", "Finanzen", null]], o: [[(year - 1) + "-02", 10, (year - 1) + "-02-19", "Übernahme"]] };
  ctx = await browser.newContext({ locale: "de-CH", acceptDownloads: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "#einrichten=" + b64u(setup));
  ok((await page.locator("#sub").textContent()) === "Testwagen ZH 1 · Geschäftsfahrten Muster AG", "Einrichtungslink setzt Fahrzeug und Firma");
  ok((await page.locator(".tile[data-p]").count()) === 2, "Einrichtungslink legt zwei Ziele an");
  ok((await page.locator("#hint").textContent()).includes("Muster AG"), "Hinweis aus dem Einrichtungslink");

  // ---- 3. Ein Tipp erfasst eine Fahrt
  await page.locator(".tile[data-p='0']").click();
  ok((await page.locator(".trip").count()) === 1, "Tipp auf Ziel erfasst eine Fahrt");
  ok((await page.locator(".trip .k").first().textContent()) === "220 km", "Fahrt hat 220 km");
  let stats = await page.locator(".stat .v").allTextContents();
  const rate = year <= 2025 ? 0.7 : 0.75;
  ok(stats[1] === "220" && stats[2] === (220 * rate).toFixed(2), "Jahressumme: 220 km und Kilometergeld à " + rate.toFixed(2));

  // ---- 4. Ziel ohne km fragt einmal nach
  await page.waitForTimeout(1600);
  await page.locator(".tile[data-p='1']").click();
  await page.locator("#km-input").fill("48");
  await page.locator("#f-km button[type=submit]").click();
  ok((await page.locator(".trip").count()) === 2, "Ziel ohne km: Fahrt nach Eingabe erfasst");
  ok((await page.locator(".tile[data-p='1'] .km").textContent()) === "48 km", "km am Ziel gemerkt");

  // ---- 5. Rückgängig
  await page.waitForTimeout(1600);
  await page.locator(".tile[data-p='1']").click();
  await page.locator("#toast-undo").click();
  ok((await page.locator(".trip").count()) === 2, "Rückgängig entfernt die letzte Fahrt");

  // ---- 6. Andere Fahrt mit Pflichtfeldern und Formel-Text
  await page.locator("#t-other").click();
  await page.locator("#f-trip button[type=submit]").click();
  ok(await page.locator("#t-err").isVisible(), "leere Fahrt wird abgelehnt");
  await page.locator("#t-dest").fill("=Notariat <b>x</b>");
  await page.locator("#t-purpose").fill("Unterschrift");
  await page.locator("#t-km").fill("30");
  await page.locator("#f-trip button[type=submit]").click();
  ok((await page.locator(".trip").count()) === 3, "andere Fahrt erfasst");
  ok((await page.locator(".trip b b").count()) === 0, "HTML im Ziel wird nicht ausgeführt");

  // ---- 7. Ändern und Löschen
  await page.locator(".trip").first().click();
  await page.locator("#t-km").fill("32");
  await page.locator("#f-trip button[type=submit]").click();
  stats = await page.locator(".stat .v").allTextContents();
  ok(stats[1] === "300", "Ändern: Summe 220 + 48 + 32 = 300 km");

  // ---- 8. Kilometerstand, Geschäftsanteil, km pro Jahr
  await page.locator("#b-odo").click();
  await page.locator("#o-month").fill(year + "-01");
  await page.locator("#o-km").fill("12000");
  await page.locator("#f-odo button[type=submit]").click();
  await page.locator("#b-odo").click();
  await page.locator("#o-km").fill("13200");
  await page.locator("#f-odo button[type=submit]").click();
  const odoTxt = await page.locator("#summary .odoline").allTextContents();
  ok(/Geschäftsanteil rund \d+ %/.test(odoTxt[0] || ""), "Geschäftsanteil wird gezeigt: " + (odoTxt[0] || "").slice(0, 70));
  ok(/pro Jahr/.test(odoTxt[1] || ""), "km pro Jahr seit erstem Stand wird gezeigt");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("fahrtenbuch:v1")));
  ok(stored.odo[year + "-01"].date === year + "-01-31", "Stand für vergangenen Monat bekommt das Monatsende als Datum");

  // ---- 9. Ansatz pro Jahr
  ok(await page.evaluate(() => true), "Seite läuft");
  await page.locator("#b-settings").click();
  ok((await page.locator("#s-rate").inputValue()) === rate.toFixed(2), "Standardansatz des Jahres " + rate.toFixed(2));
  await page.locator("#s-rate").fill("0.60");
  await page.locator("#f-set button[type=submit]").click();
  stats = await page.locator(".stat .v").allTextContents();
  ok(stats[2] === "180.00", "eigener Ansatz 0.60: 300 km = 180.00");

  // ---- 10. Jahresliste und CSV
  await page.locator("#b-copy").click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  ok(clip.startsWith("Fahrtenbuch Testwagen ZH 1 – Geschäftsfahrten Muster AG " + year), "Jahresliste: Titel");
  ok(clip.includes("Alle Fahrten ab Musterdorf, hin und zurück.") && clip.includes("Total km\t300"), "Jahresliste: Startort und Total");
  let [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#b-csv").click()]);
  const csv = fs.readFileSync(await dl.path(), "utf8");
  ok(dl.suggestedFilename() === "Fahrtenbuch_" + year + ".csv" && csv.includes("\"'=Notariat"), "CSV: Dateiname und Formel-Schutz");

  // ---- 11. Sicherung speichern, neues Gerät, einlesen
  ok((await page.locator("#status").textContent()) === "Nur auf diesem Gerät", "frische Fahrten: noch kein Sicherungshinweis");
  await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("fahrtenbuch:v1"));
    d.trips.forEach((t) => { t.createdAt -= 40 * 86400000; });
    localStorage.setItem("fahrtenbuch:v1", JSON.stringify(d));
  });
  await page.reload();
  ok((await page.locator("#status").textContent()) === "Sicherung fällig", "nach einem Monat ohne Sicherung: Hinweis «Sicherung fällig»");
  [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#b-backup").click()]);
  const backupFile = path.join(os.tmpdir(), "fb-backup-" + Date.now() + ".json");
  await dl.saveAs(backupFile);
  ok((await page.locator("#status").textContent()) === "Nur auf diesem Gerät", "nach Sicherung: Hinweis weg");
  await page.reload();
  ok((await page.locator(".trip").count()) === 3, "Fahrten überleben das Neuladen");
  await ctx.close();

  ctx = await browser.newContext({ locale: "de-CH" });
  page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base);
  await page.locator("#f-restore").setInputFiles(backupFile);
  await page.waitForFunction(() => document.querySelectorAll(".trip").length === 3);
  ok(true, "Sicherung auf neuem Gerät eingelesen: 3 Fahrten");
  ok((await page.locator("#sub").textContent()).includes("Muster AG"), "Sicherung bringt die Einstellungen mit");
  await page.locator("#f-restore").setInputFiles(backupFile);
  await page.waitForTimeout(300);
  ok((await page.locator(".trip").count()) === 3, "zweimal einlesen verdoppelt nichts");
  const bad = path.join(os.tmpdir(), "fb-bad-" + Date.now() + ".json");
  fs.writeFileSync(bad, '{"app":"etwas anderes","trips":[{"date":"x"}]}');
  await page.locator("#f-restore").setInputFiles(bad);
  await page.waitForTimeout(300);
  ok((await page.locator("#toast-msg").textContent()).includes("keine Sicherung"), "fremde Datei wird abgelehnt");

  // ---- 12. Einrichtungslink überschreibt keine vorhandenen Daten
  await page.goto(base + "#einrichten=" + b64u({ v: "Anderes Auto", p: [] }));
  await page.reload();
  ok((await page.locator("#sub").textContent()).includes("Testwagen ZH 1"), "Einrichtungslink lässt vorhandene Daten in Ruhe");

  // ---- 13. Ohne Netz starten
  await page.goto(base);
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
  await page.waitForTimeout(500);
  await ctx.setOffline(true);
  await page.reload();
  ok((await page.locator("h1").textContent()) === "Fahrtenbuch" && (await page.locator(".trip").count()) === 3, "startet ohne Netz und zeigt die Fahrten");
  await ctx.close();

  // ---- 14. Keine Personendaten in den ausgelieferten Dateien
  const src = fs.readFileSync(path.join(ROOT, "fahrtenbuch", "index.html"), "utf8");
  ok(!/[A-Z]{2}\s?\d{4,6}/.test(src.replace(/#[0-9a-fA-F]{6}/g, "")) && !/@[a-z0-9-]+\.[a-z]{2,}/i.test(src), "kein Kontrollschild und keine E-Mail im Quelltext");

  ok(errors.length === 0, "keine Skriptfehler" + (errors.length ? ": " + errors.join(" | ") : ""));
  await browser.close();
  server.close();
  console.log(failed ? "\n" + failed + " Prüfung(en) fehlgeschlagen" : "\nAlle Prüfungen bestanden");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
