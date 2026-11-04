// End-to-End-Tests: echte index.html im Chromium gegen den Apps-Script-Nachbau (mock-gas.js).
// Start:  node test/run.js
"use strict";
const { chromium } = require("playwright");
const crypto = require("crypto");
const { createGas, startServers } = require("./mock-gas");

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (info !== undefined ? "  → " + JSON.stringify(info) : "")); }
}
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; }
const isDate = v => Object.prototype.toString.call(v) === "[object Date]";
const b64url = s => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

(async () => {
  const gas = createGas();
  gas.ctx.einrichten();
  const PIN = gas.props.PIN;
  const srv = await startServers(gas);
  const invite = (pin = PIN) => srv.appUrl + "#verbinden=" + b64url(JSON.stringify({ u: srv.apiUrl, p: pin }));
  const browser = await chromium.launch();

  async function newDevice() {
    const ctx = await browser.newContext();
    await ctx.route(/cdnjs\.cloudflare\.com/, r => r.abort());
    const page = await ctx.newPage();
    page.on("dialog", d => d.accept());
    page.on("pageerror", e => { page._errors = (page._errors || []).concat(String(e)); });
    return { ctx, page };
  }
  const tag = p => p.textContent("#syncTag");
  const rows = () => gas.sheet("Spesen")._rows.slice(1);
  const logRows = () => gas.sheet("Protokoll")._rows.slice(1);
  const settle = p => p.waitForFunction(() => !document.querySelector("#syncTag").textContent.includes("ausstehend"), null, { timeout: 8000 });
  async function saveManual(p, { desc, amount, cat, currency, km, rate }) {
    await p.click("#btnManual");
    if (cat && !(cat === "fahrt_km" && currency)) await p.selectOption('.sheet [data-f="categoryId"]', cat);
    await p.fill('.sheet [data-f="description"]', desc);
    if (currency) await p.fill('.sheet [data-f="currency"]', currency);
    if (cat === "fahrt_km" && currency) await p.selectOption('.sheet [data-f="categoryId"]', "fahrt_km");
    if (km != null) await p.fill('.sheet [data-f="km"]', String(km));
    if (amount != null) await p.fill('.sheet [data-f="amount"]', String(amount));
    if (rate != null) await p.fill('.sheet [data-f="rate"]', String(rate));
    await p.click(".sheet [data-save]");
    await p.waitForTimeout(150);
    if (await p.$(".scrim")) await p.click(".sheet [data-x]"); // Speichern abgelehnt → Formular schliessen
  }

  // Testbild erzeugen (echtes JPEG, damit compressImage es lesen kann)
  const tmp = await newDevice();
  await tmp.page.goto(srv.appUrl + "blank.html");
  const jpgB64 = await tmp.page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 400; c.height = 600;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 400, 600);
    g.fillStyle = "#000"; g.font = "30px sans-serif"; g.fillText("Migros 12.50", 40, 100);
    return c.toDataURL("image/jpeg", 0.9).split(",")[1];
  });
  await tmp.ctx.close();
  const photo = { name: "beleg.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpgB64, "base64") };

  // ---------------------------------------------------------------- 1
  console.log("\n1. Upgrade von der alten App (IndexedDB v1)");
  const A = await newDevice();
  await A.page.goto(srv.appUrl + "blank.html");
  await A.page.evaluate(() => new Promise((res, rej) => {
    localStorage.setItem("spesen:settings", JSON.stringify({ kmRate: 0.7, lunchRate: 25, apiKey: "sk-ant-ALT", model: "x" }));
    const r = indexedDB.open("spesenDB", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("expenses", { keyPath: "id" }); r.result.createObjectStore("receipts", { keyPath: "id" }); };
    r.onsuccess = () => {
      const t = r.result.transaction(["expenses", "receipts"], "readwrite");
      t.objectStore("expenses").put({ id: "alt1", date: "2026-10-02", categoryId: "verpflegung", categoryLabel: "Verpflegung",
        description: "Alter Beleg", merchant: "Coop", currency: "CHF", amount: 8.4, amountCHF: 8.4, km: null, rate: null, hasReceipt: false, createdAt: 1 });
      t.oncomplete = () => { r.result.close(); res(); }; t.onerror = () => rej(t.error);
    };
  }));
  await A.page.goto(srv.appUrl);
  await A.page.waitForSelector(".row");
  check("alter Eintrag ist nach Upgrade noch da", (await A.page.textContent("#ledger")).includes("Alter Beleg"));
  check("alter API-Schlüssel aus localStorage entfernt", await A.page.evaluate(() => { saveSettings(); return !localStorage.getItem("spesen:settings").includes("sk-ant"); }));
  check("Kopfzeile «Nur dieses Gerät»", (await tag(A.page)) === "Nur dieses Gerät");

  // ---------------------------------------------------------------- 2
  console.log("\n2. Lokal erfassen (ohne Verbindung)");
  await saveManual(A.page, { desc: "Fahrt Kunde", cat: "fahrt_km", currency: "EUR", km: 10 });
  const fahrt = await A.page.evaluate(() => expenses.find(e => e.description === "Fahrt Kunde"));
  check("km-Spese trotz zuvor gewählter Fremdwährung in CHF (10 km × 0.70 = 7.00)",
    fahrt && fahrt.currency === "CHF" && fahrt.amountCHF === 7, fahrt && { cur: fahrt.currency, chf: fahrt.amountCHF });

  // ---------------------------------------------------------------- 3
  console.log("\n3. Falscher Zugangscode");
  const X = await newDevice();
  await X.page.goto(invite("falsch"));
  await X.page.waitForSelector(".toast");
  check("Meldung «Zugangscode stimmt nicht»", (await X.page.textContent(".toast")).includes("Zugangscode stimmt nicht"));
  check("bleibt unverbunden", (await tag(X.page)) === "Nur dieses Gerät");
  await X.ctx.close();

  // ---------------------------------------------------------------- 4
  console.log("\n4. Verbinden per Einladungslink + lokale Spesen hochladen");
  await A.page.evaluate(() => { settings.who = "Büro"; saveSettings(); });
  await A.page.goto(invite());
  await A.page.reload();
  await A.page.waitForFunction(() => connected());
  const expectLocal = fahrt ? 2 : 1;
  await until(() => rows().length >= expectLocal);
  await settle(A.page);
  check("Kopfzeile «Firmenablage»", (await tag(A.page)) === "Firmenablage", [await tag(A.page), await A.page.evaluate(()=>[settings, document.querySelector(".toast")?.textContent, expenses.map(e=>[e.id,e.synced,e.pending])])]);
  check("alle lokalen Spesen in der Tabelle", rows().length === expectLocal, rows().length);
  check("«Erfasst von» bei alter Spese nachgetragen", rows().every(r => r[11] === "Büro"));
  check("Protokoll: je Spese «neu»", logRows().filter(r => r[1] === "neu").length === expectLocal);

  // ---------------------------------------------------------------- 5
  console.log("\n5. Spese mit Foto");
  await A.page.setInputFiles("#fileMain", photo);
  await A.page.waitForSelector(".sheet [data-preview][src^='data:image']");
  await A.page.fill('.sheet [data-f="description"]', "=HYPERLINK(\"http://boese\")");
  await A.page.fill('.sheet [data-f="amount"]', "12.50");
  await A.page.click(".sheet [data-save]");
  await settle(A.page);
  await until(() => rows().some(r => String(r[4]).includes("HYPERLINK")));
  const r5 = rows().find(r => String(r[4]).includes("HYPERLINK"));
  if (!r5) console.log("    debug:", await A.page.evaluate(() => [document.querySelector(".toast")?.textContent, !!document.querySelector(".scrim"), expenses.map(e => [e.description, e.synced, e.pending])]), A.page._errors);
  check("Zeile angelegt", !!r5);
  const f5 = r5 && gas.files[r5[12]];
  check("Foto als Drive-Datei abgelegt", !!f5);
  check("SHA-256 in der Tabelle stimmt mit der Datei überein",
    f5 && crypto.createHash("sha256").update(f5.bytes).digest("hex") === r5[13]);
  check("Dateiname <Datum>_<Wer>_..._<Hash8>.jpg", f5 && /^\d{4}-\d{2}-\d{2}_Büro_.+_[0-9a-f]{8}\.jpg$/.test(f5.name), f5 && f5.name);
  check("Ordner Belege/<Jahr>", f5 && gas.folders[f5.parent].name === String(new Date().getFullYear()));
  check("Formel-Schutz: Text beginnt mit Apostroph", r5 && String(r5[4]).startsWith("'="), r5 && r5[4]);
  check("Server-Zeitstempel gesetzt", r5 && isDate(r5[15]) && isDate(r5[16]));
  check("Version 1, Status aktiv", r5 && r5[17] === 1 && r5[14] === "aktiv");

  // ---------------------------------------------------------------- 6
  console.log("\n6. Zweites Gerät: sehen, bearbeiten, löschen");
  const B = await newDevice();
  await B.page.goto(invite());
  await B.page.waitForFunction(() => connected());
  await B.page.evaluate(() => { settings.who = "Vater"; saveSettings(); });
  const nAll = rows().length;
  const seen = await B.page.waitForFunction(n => expenses.length === n, nAll, { timeout: 8000 }).then(() => true, () => false);
  check("Gerät B sieht alle Spesen", seen);
  await B.page.reload(); await B.page.waitForFunction(n => expenses.length === n, nAll);
  await B.page.evaluate(() => openEntry(expenses.find(e => e.description === "Alter Beleg")));
  await B.page.fill('.sheet [data-f="amount"]', "9.10");
  await B.page.click(".sheet [data-save]");
  await until(() => rows().some(r => r[4] === "Alter Beleg" && r[17] === 2));
  const r6 = rows().find(r => r[4] === "Alter Beleg");
  check("Betrag geändert, Version 2", r6[7] === 9.1 && r6[17] === 2, { betrag: r6[7], v: r6[17] });
  check("«Erfasst von» bleibt Büro", r6[11] === "Büro");
  const l6 = logRows().find(r => r[1] === "geändert" && r[2] === r6[0]);
  check("Protokoll «geändert» von Vater mit Vorher/Nachher", l6 && l6[3] === "Vater" && l6[4].includes("8.4") && l6[5].includes("9.1"));
  await B.page.evaluate(() => openEntry(expenses.find(e => e.description === "Alter Beleg")));
  await B.page.click(".sheet [data-del]");
  await until(() => rows().some(r => r[4] === "Alter Beleg" && r[14] === "gelöscht"));
  check("Löschen: Zeile bleibt, Status «gelöscht»", rows().find(r => r[0] === r6[0])[14] === "gelöscht");
  check("Protokoll «gelöscht»", logRows().some(r => r[1] === "gelöscht" && r[2] === r6[0]));
  check("Gerät A kennt die Spese vor dem Abgleich", await A.page.evaluate(() => expenses.some(e => e.description === "Alter Beleg")));
  await A.page.evaluate(() => sync());
  check("Gerät A sieht die gelöschte Spese nicht mehr", !(await A.page.evaluate(() => expenses.some(e => e.description === "Alter Beleg"))));
  check("Personenfilter erscheint nicht bei nur einer Person", (await A.page.$$("#people .chip")).length === 0);

  // ---------------------------------------------------------------- 7
  console.log("\n7. Ohne Netz erfassen, später senden");
  await A.ctx.setOffline(true);
  await saveManual(A.page, { desc: "Offline-Kaffee", amount: "4.20" });
  await A.page.waitForFunction(() => document.querySelector("#syncTag").textContent === "1 ausstehend");
  check("Kopfzeile «1 ausstehend»", true);
  check("noch nicht in der Tabelle", !rows().some(r => r[4] === "Offline-Kaffee"));
  await A.ctx.setOffline(false);
  await A.page.evaluate(() => window.dispatchEvent(new Event("online")));
  await settle(A.page);
  check("nach Wiederverbindung gesendet", rows().some(r => r[4] === "Offline-Kaffee"));

  // ---------------------------------------------------------------- 8
  console.log("\n8. Beleg von anderem Gerät laden");
  await B.page.evaluate(() => sync());
  const hasImg = await B.page.evaluate(async () => { const e = expenses.find(x => x.hasReceipt); return !!(await ensureImage(e)); });
  check("Gerät B lädt das Foto aus der Ablage", hasImg);

  // ---------------------------------------------------------------- 9
  console.log("\n9. KI-Erkennung (über Backend)");
  gas.props.ANTHROPIC_KEY = "sk-ant-test";
  gas.fetchStub.handler = () => ({ code: 200, body: { content: [{ type: "text",
    text: '```json\n{"merchant":"Shell","date":"2026-11-01","amount":71.3,"currency":"CHF","category":"Fahrzeug / Treibstoff"}\n```' }] } });
  await B.page.evaluate(() => sync());
  await B.page.waitForFunction(() => settings.scan === true);
  await B.page.setInputFiles("#fileMain", photo);
  await B.page.waitForFunction(() => document.querySelector('.sheet [data-f="merchant"]')?.value === "Shell");
  check("Händler, Datum, Betrag, Kategorie übernommen", await B.page.evaluate(() =>
    document.querySelector('.sheet [data-f="date"]').value === "2026-11-01" &&
    document.querySelector('.sheet [data-f="amount"]').value === "71.3" &&
    document.querySelector('.sheet [data-f="categoryId"]').value === "treibstoff"));
  const call = gas.fetchStub.calls[0];
  check("Schlüssel nur im Backend (Header von UrlFetchApp)", call && call.opts.headers["x-api-key"] === "sk-ant-test");
  check("Frontend kennt keinen Schlüssel", !(await B.page.evaluate(() => JSON.stringify(settings) + document.documentElement.outerHTML)).includes("sk-ant-test"));
  await B.page.click(".sheet [data-x]");

  // ---------------------------------------------------------------- 10
  console.log("\n10. Import einer fehlerhaften Spesen-Datei");
  const C = await newDevice();
  await C.page.goto(srv.appUrl);
  await C.page.waitForSelector(".empty");
  const bad = JSON.stringify({ version: 1, expenses: [
    { id: "ok1", date: "2026-09-01", categoryId: "verpflegung", categoryLabel: "Verpflegung", description: "Gut", merchant: "", currency: "CHF", amount: 5, amountCHF: 5, km: null, rate: null },
    { id: "kaputt1", categoryId: "verpflegung", description: "ohne Datum", amount: 3, amountCHF: 3 },
    { id: "kaputt2", date: "2026-09-02", categoryId: "fahrt_km", categoryLabel: "Fahrt (km)", description: "km-Text", km: "<img src=x onerror=window.__xss=1>", currency: "CHF", amount: 1, amountCHF: 1 },
  ], receipts: [{ id: "ok1", data: 'x" onerror="window.__xss2=1' }] });
  await C.page.evaluate(() => { const i = document.getElementById("fileImport"); i.onchange = null; });
  await C.page.evaluate(async b => { await importBackup(new File([b], "s.json")); }, bad);
  await C.page.waitForTimeout(300);
  check("App läuft weiter (keine JS-Fehler)", !(C.page._errors || []).length, C.page._errors);
  check("gültiger Eintrag importiert", (await C.page.textContent("#ledger")).includes("Gut"));
  check("Eintrag ohne Datum verworfen", !(await C.page.evaluate(() => expenses.some(e => e.id === "kaputt1"))));
  check("ungültiges Belegbild verworfen", !(await C.page.evaluate(() => "ok1" in receipts)));
  await C.page.evaluate(() => { filter = "2026"; window.print = () => {}; return buildReport(); });
  await C.page.waitForTimeout(200);
  check("kein eingeschleustes Script (Liste + Bericht)", !(await C.page.evaluate(() => window.__xss || window.__xss2)));
  await C.ctx.close();

  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  await browser.close(); srv.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
