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

  // ================= Firmenablage (Apps-Script-Nachbau aus mock-gas.js) =================
  console.log("\n  Firmenablage");
  const { createGas, startServers } = require("./mock-gas");
  const gas = createGas();
  gas.ctx.einrichten();
  const PIN = gas.props.PIN;
  const srv = await startServers(gas);
  const app = srv.appUrl + "fahrtenbuch/index.html";
  const invite = (pin = PIN) => "https://beispiel.invalid/app/#verbinden=" + b64u({ u: srv.apiUrl, p: pin });
  const sheetRows = (n) => (gas.sheet(n) ? gas.sheet(n)._rows.slice(1) : []);
  const logs = () => gas.sheet("Protokoll")._rows.slice(1).map((r) => r[1]);
  const statusIs = (pg, txt) => pg.waitForFunction((t) => document.querySelector("#status").textContent === t, txt, { timeout: 8000 }).then(() => true, () => false);
  const waitRows = async (n, count) => { const t0 = Date.now(); while (Date.now() - t0 < 8000) { if (sheetRows(n).length === count) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  async function device(url) {
    const c = await browser.newContext({ locale: "de-CH" });
    const pg = await c.newPage();
    pg.on("pageerror", (e) => errors.push(String(e)));
    await pg.goto(url);
    return { c, pg };
  }

  // ---- A: zuerst nur lokal, dann verbinden
  const A = await device(app + "#einrichten=" + b64u(setup));
  await A.pg.locator(".tile[data-p='0']").click();
  await A.pg.locator("#t-other").click();
  await A.pg.locator("#t-dest").fill("=Notariat");
  await A.pg.locator("#t-purpose").fill("Unterschrift");
  await A.pg.locator("#t-km").fill("30");
  await A.pg.locator("#f-trip button[type=submit]").click();
  ok(sheetRows("Fahrten").length === 0, "ohne Verbindung geht nichts an die Ablage");

  await A.pg.locator("#b-settings").click();
  await A.pg.locator("#c-link").fill("https://beispiel.invalid/irgendwas");
  await A.pg.locator("#c-on").click();
  ok((await A.pg.locator("#c-msg").textContent()).includes("kein Link"), "falscher Link wird abgelehnt");
  await A.pg.locator("#c-link").fill(invite("falsch"));
  await A.pg.locator("#c-on").click();
  await A.pg.waitForFunction(() => !document.querySelector("#c-msg").hidden);
  ok((await A.pg.locator("#c-msg").textContent()).includes("Zugangscode"), "falscher Zugangscode wird gemeldet");
  ok(sheetRows("Fahrten").length === 0, "falscher Zugangscode schreibt nichts");

  await A.pg.locator("#c-link").fill(invite());
  await A.pg.locator("#c-on").click();
  ok(await statusIs(A.pg, "In der Ablage gespeichert"), "verbunden: «In der Ablage gespeichert»");
  ok(sheetRows("Fahrten").length === 2, "lokale Fahrten wurden hochgeladen (2 Zeilen)");
  ok(sheetRows("Fahrten").some((r) => r[2] === "'=Notariat"), "Formel-Schutz in der Tabelle");
  ok(sheetRows("Kilometerstand").length === 1 && sheetRows("Kilometerstand")[0][2] === 10, "Kilometerstand hochgeladen");
  ok((gas.props.FAHRTEN_CONFIG || "").includes("Testwagen ZH 1"), "Einstellungen in der Ablage");
  ok(logs().filter((a) => a === "Fahrt neu").length === 2 && logs().includes("Kilometerstand neu"), "Protokoll: 2 × Fahrt neu, Kilometerstand neu");

  // ---- neue Fahrt, Ändern, Löschen
  await A.pg.waitForTimeout(1600);
  await A.pg.locator(".tile[data-p='0']").click();
  ok(await waitRows("Fahrten", 3), "neue Fahrt landet sofort in der Ablage");
  await statusIs(A.pg, "In der Ablage gespeichert");
  await A.pg.locator(".trip").first().click();
  await A.pg.locator("#t-km").fill("230");
  await A.pg.locator("#f-trip button[type=submit]").click();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !sheetRows("Fahrten").some((r) => r[4] === 230 && r[10] === 2)) await new Promise((r) => setTimeout(r, 50));
  ok(sheetRows("Fahrten").some((r) => r[4] === 230 && r[10] === 2) && logs().includes("Fahrt geändert"), "Ändern: Version 2 und Protokoll");
  await statusIs(A.pg, "In der Ablage gespeichert");
  await A.pg.locator(".trip").first().click();
  await A.pg.locator("#t-del").click();
  await A.pg.locator("#t-del").click();
  const t1 = Date.now();
  while (Date.now() - t1 < 8000 && !sheetRows("Fahrten").some((r) => r[6] === "gelöscht")) await new Promise((r) => setTimeout(r, 50));
  ok(sheetRows("Fahrten").length === 3 && sheetRows("Fahrten").filter((r) => r[6] === "gelöscht").length === 1 && logs().includes("Fahrt gelöscht"), "Löschen: Zeile bleibt mit Status «gelöscht»");
  await statusIs(A.pg, "In der Ablage gespeichert");
  ok((await A.pg.locator(".trip").count()) === 2, "App zeigt nach dem Löschen 2 Fahrten");

  // ---- Kilometerstand
  await A.pg.locator("#b-odo").click();
  await A.pg.locator("#o-km").fill("20500");
  await A.pg.locator("#f-odo button[type=submit]").click();
  ok(await waitRows("Kilometerstand", 2), "Kilometerstand des Monats in der Ablage");
  await statusIs(A.pg, "In der Ablage gespeichert");
  await A.pg.locator("#b-odo").click();
  await A.pg.locator("#o-km").fill("20600");
  await A.pg.locator("#f-odo button[type=submit]").click();
  const t2 = Date.now();
  while (Date.now() - t2 < 8000 && !logs().includes("Kilometerstand geändert")) await new Promise((r) => setTimeout(r, 50));
  ok(sheetRows("Kilometerstand").length === 2 && sheetRows("Kilometerstand").some((r) => r[2] === 20600 && r[6] === 2), "Korrektur überschreibt den Monat (Version 2, Protokoll)");
  await statusIs(A.pg, "In der Ablage gespeichert");

  // ---- B: neues Gerät nur mit Link
  const B = await device(app + "#verbinden=" + b64u({ u: srv.apiUrl, p: PIN }));
  await B.pg.waitForFunction(() => document.querySelectorAll(".trip").length === 2, null, { timeout: 8000 }).catch(() => {});
  ok((await B.pg.locator(".trip").count()) === 2, "neues Gerät holt die 2 Fahrten aus der Ablage");
  ok((await B.pg.locator("#sub").textContent()).includes("Muster AG") && (await B.pg.locator(".tile[data-p]").count()) === 2, "neues Gerät holt Fahrzeug und Ziele");
  ok(/pro Jahr/.test(await B.pg.locator("#summary").textContent()), "neues Gerät holt die Kilometerstände");

  // ---- ohne Netz erfassen, später senden
  srv.api.offline = true;
  await B.pg.locator(".tile[data-p='0']").click();
  ok(await statusIs(B.pg, "1 ausstehend"), "ohne Netz: «1 ausstehend»");
  ok((await B.pg.locator(".trip").count()) === 3 && sheetRows("Fahrten").length === 3, "ohne Netz: Fahrt bleibt auf dem Gerät");
  await B.pg.reload();
  ok(await statusIs(B.pg, "1 ausstehend") && (await B.pg.locator(".trip").count()) === 3, "ausstehende Fahrt überlebt das Neuladen");
  srv.api.offline = false;
  await B.pg.evaluate(() => window.dispatchEvent(new Event("online")));
  ok(await statusIs(B.pg, "In der Ablage gespeichert") && sheetRows("Fahrten").length === 4, "wieder Netz: Fahrt wird nachgesendet");

  // ---- A sieht die Fahrt von B
  await A.pg.reload();
  await A.pg.waitForFunction(() => document.querySelectorAll(".trip").length === 3, null, { timeout: 8000 }).catch(() => {});
  ok((await A.pg.locator(".trip").count()) === 3, "erstes Gerät sieht die Fahrt des zweiten");

  // ---- Blatt geleert: das Gerät lädt seine Fahrten wieder hoch
  gas.sheet("Fahrten")._rows.length = 1;
  await A.pg.reload();
  const t3 = Date.now();
  while (Date.now() - t3 < 8000 && sheetRows("Fahrten").length !== 3) await new Promise((r) => setTimeout(r, 50));
  ok(sheetRows("Fahrten").length === 3 && (await A.pg.locator(".trip").count()) === 3, "geleertes Blatt: Gerät stellt die 3 Fahrten wieder her");

  // ---- Einrichtungslink mit Zugang, Trennen
  await statusIs(A.pg, "In der Ablage gespeichert");
  const linkWithKey = await A.pg.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("fahrtenbuch:v1"));
    return !!(d.conn && d.conn.u && d.conn.p);
  });
  ok(linkWithKey, "Verbindung ist auf dem Gerät gespeichert");
  await B.pg.locator("#b-settings").click();
  await B.pg.locator("#c-off").click();
  await B.pg.locator("#c-off").click();
  await B.pg.reload();
  await B.pg.waitForTimeout(400);
  ok((await B.pg.locator("#status").textContent()) === "Nur auf diesem Gerät" && (await B.pg.locator(".trip").count()) === 3, "getrennt: bleibt getrennt, Fahrten bleiben auf dem Gerät");

  // ---- alte Ablage ohne Fahrtenbuch-Aktionen
  const origPost = gas.ctx.doPost;
  gas.ctx.doPost = (e) => {
    const req = JSON.parse(e.postData.contents);
    if (/^(fahrt|odo)/.test(req.action)) return { _s: JSON.stringify({ ok: false, error: "unknown_action" }) };
    return origPost(e);
  };
  const C = await device(app);
  await C.pg.locator("#b-settings").click();
  await C.pg.locator("#c-link").fill(invite());
  await C.pg.locator("#c-on").click();
  await C.pg.waitForFunction(() => !document.querySelector("#c-msg").hidden);
  ok((await C.pg.locator("#c-msg").textContent()).includes("kennt das Fahrtenbuch noch nicht"), "alte Ablage: klare Meldung statt Datenverlust");
  gas.ctx.doPost = origPost;
  await A.c.close(); await B.c.close(); await C.c.close();
  srv.close();

  ok(errors.length === 0, "keine Skriptfehler" + (errors.length ? ": " + errors.join(" | ") : ""));
  await browser.close();
  server.close();
  console.log(failed ? "\n" + failed + " Prüfung(en) fehlgeschlagen" : "\nAlle Prüfungen bestanden");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
