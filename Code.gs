/**
 * PMG Spesen – Firmenablage (Google Apps Script)
 *
 * Läuft unter dem Google-Konto der PMG Immobilien AG.
 * - Belegfotos landen in Google Drive: "PMG Spesen / Belege / <Jahr>"
 * - Alle Spesen stehen in der Tabelle "PMG Spesen" (Blatt "Spesen")
 * - Jede Änderung wird im Blatt "Protokoll" festgehalten, nichts wird überschrieben
 * - Jedes Foto bekommt eine SHA-256-Prüfsumme; ein Austausch wäre feststellbar
 * - Das Fahrtenbuch (fahrtenbuch/) speichert in dieselbe Tabelle: Blätter "Fahrten" und
 *   "Kilometerstand". Sie werden beim ersten Speichern angelegt.
 *
 * Einrichtung: einmal die Funktion "einrichten" ausführen (siehe Anleitung).
 */

const PROPS = PropertiesService.getScriptProperties();
const TZ = "Europe/Zurich";

const HEAD = [
  "ID", "Datum", "Kategorie-ID", "Kategorie", "Beschreibung", "Händler", "km",
  "Betrag", "Währung", "Kurs", "Betrag CHF", "Erfasst von",
  "Beleg (Drive-Datei)", "Beleg SHA-256", "Status",
  "Gespeichert am (Server)", "Zuletzt geändert", "Version",
  "Beleg-Link", "Bezahlt mit"   // neue Spalten nur hinten anhängen
];
const C = { id:0, date:1, catId:2, cat:3, desc:4, merchant:5, km:6, amount:7, cur:8, rate:9,
  chf:10, who:11, file:12, hash:13, status:14, created:15, updated:16, version:17,
  link:18, paidBy:19 };
const PAID_BY = ["privat", "firma"];
const LOG_HEAD = ["Zeitpunkt", "Aktion", "ID", "Wer", "Vorher", "Nachher"];
const BUSINESS = ["date","categoryId","categoryLabel","description","merchant","km",
  "amount","currency","rate","amountCHF","who","paidBy"];

/* ================================================================ Einrichtung */

function einrichten() {
  let root;
  if (PROPS.getProperty("FOLDER_ID")) {
    root = DriveApp.getFolderById(PROPS.getProperty("FOLDER_ID"));
  } else {
    root = DriveApp.createFolder("PMG Spesen");
    PROPS.setProperty("FOLDER_ID", root.getId());
  }
  subFolder_(root, "Belege");

  let ss;
  if (PROPS.getProperty("SHEET_ID")) {
    ss = SpreadsheetApp.openById(PROPS.getProperty("SHEET_ID"));
  } else {
    ss = SpreadsheetApp.create("PMG Spesen");
    ss.setSpreadsheetTimeZone(TZ);
    const sh = ss.getSheets()[0];
    sh.setName("Spesen");
    sh.appendRow(HEAD);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEAD.length).setFontWeight("bold");
    const lg = ss.insertSheet("Protokoll");
    lg.appendRow(LOG_HEAD);
    lg.setFrozenRows(1);
    lg.getRange(1, 1, 1, LOG_HEAD.length).setFontWeight("bold");
    DriveApp.getFileById(ss.getId()).moveTo(root);
    PROPS.setProperty("SHEET_ID", ss.getId());
  }

  if (!PROPS.getProperty("PIN")) PROPS.setProperty("PIN", randomCode_(20));

  Logger.log("✅ Fertig eingerichtet.");
  Logger.log("Ordner:  " + root.getUrl());
  Logger.log("Tabelle: " + ss.getUrl());
  Logger.log("Zugangscode: " + PROPS.getProperty("PIN"));
  Logger.log("KI-Erkennung: " + (PROPS.getProperty("ANTHROPIC_KEY") ? "an" : "aus (Schlüssel fehlt)"));
}

/** Zeigt den Zugangscode erneut im Ausführungsprotokoll an. */
function zugangscodeAnzeigen() {
  Logger.log("Zugangscode: " + PROPS.getProperty("PIN"));
}

/** Erzeugt einen neuen Zugangscode. Danach müssen alle Handys neu verbunden werden. */
function zugangscodeErneuern() {
  PROPS.setProperty("PIN", randomCode_(20));
  Logger.log("Neuer Zugangscode: " + PROPS.getProperty("PIN"));
}

/* ================================================================ Web-App */

function doGet() {
  return ContentService.createTextOutput("PMG Spesen – Ablage läuft.");
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return out_({ ok:false, error:"bad_request" }); }

  if (!req.pin || req.pin !== PROPS.getProperty("PIN")) return out_({ ok:false, error:"pin" });

  try {
    switch (req.action) {
      case "ping":   return out_({ ok:true, scan: !!PROPS.getProperty("ANTHROPIC_KEY") });
      case "list":   return out_({ ok:true, scan: !!PROPS.getProperty("ANTHROPIC_KEY"), items: listItems_() });
      case "save":   return out_(withLock_(() => saveItem_(req)));
      case "delete": return out_(withLock_(() => deleteItem_(req)));
      case "image":  return out_({ ok:true, data: getImage_(req.id) });
      case "scan":   return out_({ ok:true, result: scan_(req.image, req.categories) });
      case "fahrten":       return out_(fahrtenList_());
      case "fahrtSave":     return out_(withLock_(() => fahrtSave_(req)));
      case "fahrtDelete":   return out_(withLock_(() => fahrtDelete_(req)));
      case "odoSave":       return out_(withLock_(() => odoSave_(req)));
      case "fahrtenConfig": return out_(withLock_(() => fahrtenConfig_(req)));
      default:       return out_({ ok:false, error:"unknown_action" });
    }
  } catch (err) {
    return out_({ ok:false, error: String((err && err.message) || err) });
  }
}

/* ================================================================ Daten */

function listItems_() {
  const sh = sheet_("Spesen");
  const rows = sh.getDataRange().getValues().slice(1);
  return rows
    .filter(r => r[C.id] && r[C.status] !== "gelöscht")
    .map(r => clientItem_(fromRow_(r)));
}

function saveItem_(req) {
  const it = clean_(req.item || {});
  const editor = txt_(req.wer || it.who || "?", 60);
  if (!it.id) throw new Error("ID fehlt");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date)) throw new Error("Datum ungültig");

  const sh = sheet_("Spesen");
  ensureColumns_(sh);
  const rowIdx = findRow_(sh, it.id);
  const now = new Date();
  let old = null, fileId = "", hash = "";

  if (rowIdx > 0) {
    old = fromRow_(sh.getRange(rowIdx, 1, 1, HEAD.length).getValues()[0]);
    if (old.status === "gelöscht") throw new Error("Eintrag wurde bereits gelöscht");
    fileId = old.fileId; hash = old.receiptHash;
  }

  let newImage = false;
  if (req.image) {
    const bytes = Utilities.base64Decode(String(req.image).split(",").pop());
    const h = sha256Hex_(bytes);
    if (h !== hash) {
      const name = fileName_(it, h);
      const file = yearFolder_(it.date).createFile(Utilities.newBlob(bytes, "image/jpeg", name));
      fileId = file.getId(); hash = h; newImage = true;
    }
  }

  const changed = !old || newImage || BUSINESS.some(k => norm_(old[k]) !== norm_(it[k]));
  if (!changed) return { ok:true, item: clientItem_(old) };

  const version = old ? (old.version || 1) + 1 : 1;
  const row = [
    it.id, it.date, it.categoryId, it.categoryLabel, it.description, it.merchant,
    it.km == null ? "" : it.km, it.amount, it.currency, it.rate == null ? "" : it.rate,
    it.amountCHF, it.who, fileId, hash, "aktiv",
    old ? old.createdRaw : now, now, version,
    driveLink_(fileId), it.paidBy
  ];
  if (rowIdx > 0) sh.getRange(rowIdx, 1, 1, HEAD.length).setValues([row]);
  else sh.appendRow(row);

  const after = Object.assign(pick_(it), { beleg: hash ? hash.slice(0, 16) : "" });
  log_(old ? "geändert" + (newImage ? " (neues Foto)" : "") : "neu", it.id, editor,
       old ? JSON.stringify(Object.assign(pick_(old), { beleg: old.receiptHash ? old.receiptHash.slice(0, 16) : "" })) : "",
       JSON.stringify(after));

  const saved = fromRow_(sh.getRange(rowIdx > 0 ? rowIdx : sh.getLastRow(), 1, 1, HEAD.length).getValues()[0]);
  return { ok:true, item: clientItem_(saved) };
}

function deleteItem_(req) {
  const id = String(req.id || "");
  const sh = sheet_("Spesen");
  const rowIdx = findRow_(sh, id);
  if (rowIdx < 0) return { ok:true };
  const old = fromRow_(sh.getRange(rowIdx, 1, 1, HEAD.length).getValues()[0]);
  if (old.status === "gelöscht") return { ok:true };
  sh.getRange(rowIdx, C.status + 1).setValue("gelöscht");
  sh.getRange(rowIdx, C.updated + 1).setValue(new Date());
  sh.getRange(rowIdx, C.version + 1).setValue((old.version || 1) + 1);
  log_("gelöscht", id, txt_(req.wer || "?", 60), JSON.stringify(pick_(old)), "");
  return { ok:true };
}

function getImage_(id) {
  const sh = sheet_("Spesen");
  const rowIdx = findRow_(sh, String(id || ""));
  if (rowIdx < 0) throw new Error("nicht gefunden");
  const fileId = sh.getRange(rowIdx, C.file + 1).getValue();
  if (!fileId) throw new Error("kein Beleg");
  const blob = DriveApp.getFileById(fileId).getBlob();
  return "data:" + (blob.getContentType() || "image/jpeg") + ";base64," + Utilities.base64Encode(blob.getBytes());
}

/* ================================================================ Fahrtenbuch */

// Eigene Blätter in derselben Tabelle. Neue Spalten nur hinten anhängen.
const FB_HEAD = ["ID", "Datum", "Ziel", "Zweck", "km", "Ziel-ID", "Status",
  "Erfasst am (Gerät)", "Gespeichert am (Server)", "Zuletzt geändert", "Version"];
const F = { id:0, date:1, dest:2, purpose:3, km:4, presetId:5, status:6, clientTs:7, created:8, updated:9, version:10 };
const ODO_HEAD = ["Monat", "Datum", "km", "Notiz", "Gespeichert am (Server)", "Zuletzt geändert", "Version"];
const O = { month:0, date:1, km:2, note:3, created:4, updated:5, version:6 };
const FB_BUSINESS = ["date", "dest", "purpose", "km"];

function fbBook_() {
  const id = PROPS.getProperty("SHEET_ID");
  if (!id) throw new Error("Ablage nicht eingerichtet – Funktion 'einrichten' ausführen");
  return SpreadsheetApp.openById(id);
}

/** Blatt holen; fehlt es, mit Titelzeile anlegen (nur beim Speichern, also unter LockService). */
function fbSheet_(name, head) {
  const ss = fbBook_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, head.length).setFontWeight("bold");
  }
  return sh;
}

function fbRows_(name) {
  const sh = fbBook_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getDataRange().getValues().slice(1);
}

function fbMs_(v) {
  if (v instanceof Date) return v.getTime();
  const n = Date.parse(String(v || ""));
  return isFinite(n) ? n : 0;
}

function fbMonth_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, "yyyy-MM-dd").slice(0, 7);
  return String(v || "").replace(/^'/, "").slice(0, 7);
}

function fbTrip_(r) {
  return {
    id: String(r[F.id]), date: fmtDate_(r[F.date]), dest: String(r[F.dest]), purpose: String(r[F.purpose]),
    km: Number(r[F.km]) || 0, presetId: String(r[F.presetId] || ""), status: String(r[F.status] || "aktiv"),
    clientRaw: r[F.clientTs], createdAt: fbMs_(r[F.clientTs]), createdRaw: r[F.created],
    version: Number(r[F.version]) || 1
  };
}
function fbTripClient_(t) {
  return { id:t.id, date:t.date, dest:t.dest, purpose:t.purpose, km:t.km, presetId:t.presetId, createdAt:t.createdAt, version:t.version };
}
function fbTripPick_(t) {
  const r = {};
  FB_BUSINESS.forEach(k => r[k] = t[k] == null ? "" : t[k]);
  return r;
}

function fbOdo_(r) {
  return {
    month: fbMonth_(r[O.month]), date: fmtDate_(r[O.date]), km: Number(r[O.km]) || 0, note: String(r[O.note] || ""),
    createdRaw: r[O.created], version: Number(r[O.version]) || 1
  };
}
function fbOdoClient_(o) { return { month:o.month, date:o.date, km:o.km, note:o.note }; }

function fahrtenList_() {
  const trips = fbRows_("Fahrten").filter(r => r[F.id] && r[F.status] !== "gelöscht").map(r => fbTripClient_(fbTrip_(r)));
  const odo = fbRows_("Kilometerstand").filter(r => r[O.month]).map(r => fbOdoClient_(fbOdo_(r)));
  let config = null;
  try { config = JSON.parse(PROPS.getProperty("FAHRTEN_CONFIG") || "null"); } catch (err) { config = null; }
  return { ok:true, trips: trips, odo: odo, config: config };
}

function fahrtSave_(req) {
  const t = req.trip || {};
  const it = {
    id: txt_(t.id, 40, true),
    date: String(t.date || "").slice(0, 10),
    dest: txt_(t.dest, 120),
    purpose: txt_(t.purpose, 200),
    km: Math.round(Number(t.km)),
    presetId: txt_(t.presetId, 40, true)
  };
  const editor = txt_(req.wer || "Fahrtenbuch", 60);
  if (!it.id) throw new Error("ID fehlt");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date)) throw new Error("Datum ungültig");
  if (!(it.km > 0) || it.km > 100000) throw new Error("km ungültig");
  if (!norm_(it.dest)) throw new Error("Ziel fehlt");

  const sh = fbSheet_("Fahrten", FB_HEAD);
  const rowIdx = findRow_(sh, it.id);
  const now = new Date();
  let old = null;
  if (rowIdx > 0) {
    old = fbTrip_(sh.getRange(rowIdx, 1, 1, FB_HEAD.length).getValues()[0]);
    if (old.status === "gelöscht") throw new Error("Eintrag wurde bereits gelöscht");
  }
  const changed = !old || FB_BUSINESS.some(k => norm_(old[k]) !== norm_(it[k]));
  if (!changed) return { ok:true, trip: fbTripClient_(old) };

  const ms = Number(t.createdAt);
  const clientTs = old ? old.clientRaw : new Date(ms > 0 ? ms : now.getTime()).toISOString();
  const version = old ? (old.version || 1) + 1 : 1;
  const row = [it.id, it.date, it.dest, it.purpose, it.km, it.presetId, "aktiv",
    clientTs, old ? old.createdRaw : now, now, version];
  if (rowIdx > 0) sh.getRange(rowIdx, 1, 1, FB_HEAD.length).setValues([row]);
  else sh.appendRow(row);

  log_(old ? "Fahrt geändert" : "Fahrt neu", it.id, editor,
       old ? JSON.stringify(fbTripPick_(old)) : "", JSON.stringify(fbTripPick_(it)));

  const saved = fbTrip_(sh.getRange(rowIdx > 0 ? rowIdx : sh.getLastRow(), 1, 1, FB_HEAD.length).getValues()[0]);
  return { ok:true, trip: fbTripClient_(saved) };
}

/** Löschen nur als Status «gelöscht»; die Zeile bleibt (Fahrtenbuch als Beleg). */
function fahrtDelete_(req) {
  const id = String(req.id || "");
  const sh = fbBook_().getSheetByName("Fahrten");
  if (!sh) return { ok:true };
  const rowIdx = findRow_(sh, id);
  if (rowIdx < 0) return { ok:true };
  const old = fbTrip_(sh.getRange(rowIdx, 1, 1, FB_HEAD.length).getValues()[0]);
  if (old.status === "gelöscht") return { ok:true };
  sh.getRange(rowIdx, F.status + 1).setValue("gelöscht");
  sh.getRange(rowIdx, F.updated + 1).setValue(new Date());
  sh.getRange(rowIdx, F.version + 1).setValue((old.version || 1) + 1);
  log_("Fahrt gelöscht", id, txt_(req.wer || "Fahrtenbuch", 60), JSON.stringify(fbTripPick_(old)), "");
  return { ok:true };
}

/** Ein Kilometerstand pro Monat. Eine Korrektur überschreibt die Zeile und steht im Protokoll. */
function odoSave_(req) {
  const o = req.odo || {};
  const month = String(o.month || "");
  const km = Math.round(Number(o.km));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Monat ungültig");
  if (!(km >= 0) || km > 5000000) throw new Error("Kilometerstand ungültig");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || "")) ? String(o.date) : month + "-01";
  const note = txt_(o.note, 200);
  const editor = txt_(req.wer || "Fahrtenbuch", 60);

  const sh = fbSheet_("Kilometerstand", ODO_HEAD);
  const last = sh.getLastRow();
  let rowIdx = -1;
  if (last >= 2) {
    const months = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < months.length; i++) if (fbMonth_(months[i][0]) === month) { rowIdx = i + 2; break; }
  }
  const now = new Date();
  let old = null;
  if (rowIdx > 0) {
    old = fbOdo_(sh.getRange(rowIdx, 1, 1, ODO_HEAD.length).getValues()[0]);
    if (old.km === km && old.date === date && norm_(old.note) === norm_(note)) return { ok:true, odo: fbOdoClient_(old) };
  }
  // Apostroph: Sheets soll "2026-11" als Text behalten und nicht in ein Datum umwandeln
  const row = ["'" + month, date, km, note, old ? old.createdRaw : now, now, old ? (old.version || 1) + 1 : 1];
  if (rowIdx > 0) sh.getRange(rowIdx, 1, 1, ODO_HEAD.length).setValues([row]);
  else sh.appendRow(row);
  log_(old ? "Kilometerstand geändert" : "Kilometerstand neu", month, editor,
       old ? JSON.stringify({ date: old.date, km: old.km }) : "", JSON.stringify({ date: date, km: km }));
  return { ok:true, odo: { month: month, date: date, km: km, note: norm_(note) } };
}

/** Einstellungen des Fahrtenbuchs (Fahrzeug, Ziele, Ansätze) für ein neues Handy. Keine Geschäftsdaten. */
function fahrtenConfig_(req) {
  const c = req.config || {};
  const s = v => String(v == null ? "" : v);
  const clean = {
    vehicle: s(c.vehicle).slice(0, 80), company: s(c.company).slice(0, 80),
    start: s(c.start).slice(0, 80), hint: s(c.hint).slice(0, 300), rates: {}, presets: []
  };
  Object.keys(c.rates || {}).forEach(y => {
    const v = Number(c.rates[y]);
    if (/^\d{4}$/.test(y) && v >= 0 && v <= 5) clean.rates[y] = Math.round(v * 100) / 100;
  });
  (Array.isArray(c.presets) ? c.presets : []).slice(0, 30).forEach(p => {
    if (!p || !s(p.name).trim()) return;
    const km = Math.round(Number(p.km));
    clean.presets.push({ id: txt_(p.id, 40, true), name: s(p.name).slice(0, 80), purpose: s(p.purpose).slice(0, 80),
      km: km > 0 && km <= 100000 ? km : null });
  });
  const json = JSON.stringify(clean);
  if (json.length > 8500) throw new Error("Einstellungen zu gross");
  PROPS.setProperty("FAHRTEN_CONFIG", json);
  return { ok:true, config: clean };
}

/* ================================================================ KI-Erkennung */

function scan_(image, categories) {
  const key = PROPS.getProperty("ANTHROPIC_KEY");
  if (!key) throw new Error("nokey");
  const model = PROPS.getProperty("MODEL") || "claude-haiku-4-5-20251001";
  const labels = (categories || []).map(c => '"' + String(c).replace(/"/g, "") + '"').join(", ");
  const prompt =
    'Du bist ein Beleg-Parser für Schweizer Spesenabrechnungen. Lies den Beleg im Bild und gib AUSSCHLIESSLICH gültiges JSON zurück – keine Erklärung, kein Markdown. ' +
    'Schema: {"merchant":string|null,"date":"YYYY-MM-DD"|null,"amount":number|null,"currency":string,"category":string|null}. ' +
    '"amount" ist der Totalbetrag inkl. MwSt. "currency" als ISO-Code (z.B. "CHF","EUR"). ' +
    '"category" muss exakt einer von diesen sein: [' + labels + '] – wähle die plausibelste (Tankstelle/Benzin => "Fahrzeug / Treibstoff"). ' +
    'Wenn etwas nicht lesbar ist, setze null.';

  const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: model,
      max_tokens: 400,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: String(image).split(",").pop() } },
        { type: "text", text: prompt }
      ]}]
    })
  });
  const data = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200) throw new Error((data.error && data.error.message) || ("HTTP " + res.getResponseCode()));
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
  return JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
}

/* ================================================================ Hilfsfunktionen */

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function sheet_(name) {
  const id = PROPS.getProperty("SHEET_ID");
  if (!id) throw new Error("Ablage nicht eingerichtet – Funktion 'einrichten' ausführen");
  return SpreadsheetApp.openById(id).getSheetByName(name);
}

function findRow_(sh, id) {
  if (!id) return -1;
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return -1;
}

function fromRow_(r) {
  return {
    id: String(r[C.id]),
    date: fmtDate_(r[C.date]),
    categoryId: String(r[C.catId]),
    categoryLabel: String(r[C.cat]),
    description: String(r[C.desc]),
    merchant: String(r[C.merchant]),
    km: r[C.km] === "" ? null : Number(r[C.km]),
    amount: Number(r[C.amount]),
    currency: String(r[C.cur] || "CHF"),
    rate: r[C.rate] === "" ? null : Number(r[C.rate]),
    amountCHF: Number(r[C.chf]),
    who: String(r[C.who]),
    fileId: String(r[C.file] || ""),
    receiptHash: String(r[C.hash] || ""),
    status: String(r[C.status] || "aktiv"),
    createdRaw: r[C.created],
    createdAt: r[C.created] instanceof Date ? r[C.created].toISOString() : String(r[C.created] || ""),
    updatedAt: r[C.updated] instanceof Date ? r[C.updated].toISOString() : String(r[C.updated] || ""),
    version: Number(r[C.version]) || 1,
    paidBy: PAID_BY.indexOf(String(r[C.paidBy] || "")) >= 0 ? String(r[C.paidBy]) : ""
  };
}

function clientItem_(o) {
  return {
    id:o.id, date:o.date, categoryId:o.categoryId, categoryLabel:o.categoryLabel,
    description:o.description, merchant:o.merchant, km:o.km, amount:o.amount,
    currency:o.currency, rate:o.rate, amountCHF:o.amountCHF, who:o.who, paidBy:o.paidBy,
    hasReceipt: !!o.fileId, receiptHash:o.receiptHash,
    createdAt:o.createdAt, updatedAt:o.updatedAt, version:o.version
  };
}

function clean_(it) {
  const num = v => (v === "" || v == null || !isFinite(Number(v))) ? null : Number(v);
  return {
    id: txt_(it.id, 40, true),
    date: String(it.date || "").slice(0, 10),
    categoryId: txt_(it.categoryId, 40, true),
    categoryLabel: txt_(it.categoryLabel, 60),
    description: txt_(it.description, 200),
    merchant: txt_(it.merchant, 120),
    km: num(it.km),
    amount: num(it.amount) || 0,
    currency: txt_(it.currency || "CHF", 3, true).toUpperCase(),
    rate: num(it.rate),
    amountCHF: num(it.amountCHF) || 0,
    who: txt_(it.who, 60),
    paidBy: PAID_BY.indexOf(String(it.paidBy || "")) >= 0 ? String(it.paidBy) : ""
  };
}

/** Text kürzen und Formel-Einschleusung in der Tabelle verhindern. */
function txt_(s, max, plain) {
  s = String(s == null ? "" : s).slice(0, max || 200);
  if (plain) return s.replace(/[^\w\-.]/g, "");
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function norm_(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  const n = Number(v);
  if (String(v).trim() !== "" && isFinite(n) && /^[\d.\-]+$/.test(String(v))) return String(Math.round(n * 100) / 100);
  return String(v).replace(/^'/, "");
}

function pick_(o) {
  const r = {};
  BUSINESS.forEach(k => r[k] = o[k] == null ? "" : o[k]);
  return r;
}

function fmtDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  return String(v || "").slice(0, 10);
}

function driveLink_(fileId) {
  return fileId ? "https://drive.google.com/file/d/" + fileId + "/view" : "";
}

/**
 * Ergänzt fehlende Spaltentitel hinten (Tabellen aus einer älteren Version) und trägt
 * dabei einmalig die Beleg-Links für bestehende Zeilen nach. Ändert keine Geschäftsdaten.
 */
function ensureColumns_(sh) {
  const head = sh.getRange(1, 1, 1, HEAD.length).getValues()[0];
  if (head[C.link] === HEAD[C.link] && head[C.paidBy] === HEAD[C.paidBy]) return;
  sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight("bold");
  const last = sh.getLastRow();
  if (last < 2) return;
  const files = sh.getRange(2, C.file + 1, last - 1, 1).getValues();
  const links = sh.getRange(2, C.link + 1, last - 1, 1).getValues();
  const out = files.map((f, i) => [links[i][0] || driveLink_(String(f[0] || ""))]);
  sh.getRange(2, C.link + 1, last - 1, 1).setValues(out);
}

function log_(action, id, who, before, after) {
  sheet_("Protokoll").appendRow([new Date(), action, id, who, before, after]);
}

function sha256Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, "0")).join("");
}

function subFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function yearFolder_(date) {
  const root = DriveApp.getFolderById(PROPS.getProperty("FOLDER_ID"));
  return subFolder_(subFolder_(root, "Belege"), String(date || "").slice(0, 4) || "ohne-Datum");
}

function fileName_(it, hash) {
  const part = s => String(s || "").replace(/[^\wäöüÄÖÜ\- ]/g, "").trim().slice(0, 30).replace(/\s+/g, "-");
  return [it.date, part(it.who), part(it.merchant || it.description), hash.slice(0, 8)].filter(Boolean).join("_") + ".jpg";
}

/** Zufallscode aus sicheren Zufallsbytes (getUuid nutzt einen kryptografischen Generator, Math.random nicht). */
function randomCode_(n) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const limit = 256 - (256 % chars.length); // ohne Modulo-Verzerrung
  let s = "";
  while (s.length < n) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
    for (let i = 0; i < bytes.length && s.length < n; i++) {
      const b = (bytes[i] + 256) % 256;
      if (b < limit) s += chars[b % chars.length];
    }
  }
  return s;
}
