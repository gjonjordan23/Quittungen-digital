// Nachbau der Google-Apps-Script-Dienste, die Code.gs benutzt – nur für Tests.
// Lädt Code.gs in eine VM und stellt doGet/doPost per HTTP bereit,
// inkl. der 302-Weiterleitung, die das echte Apps Script bei POST macht.
"use strict";
const fs = require("fs");
const vm = require("vm");
const http = require("http");
const crypto = require("crypto");
const path = require("path");

function createGas() {
  let nextId = 1;
  const newId = p => p + (nextId++);
  const props = {};
  const folders = {};   // id -> {id,name,parent}
  const files = {};     // id -> {id,name,bytes:Buffer,type,parent}
  const sheetsById = {};
  const logs = [];
  const fetchStub = { handler: null, calls: [] };

  const toSigned = buf => Array.from(buf, b => (b > 127 ? b - 256 : b));
  const toBuf = arr => Buffer.from(arr.map(b => (b + 256) % 256));

  // Sheets wandelt "2026-11-04" in ein Datum um und blendet ein führendes ' aus.
  // Datum im Realm der VM erzeugen, damit "instanceof Date" in Code.gs stimmt.
  function sheetValue(v) {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new ctx.__Date(v + "T12:00:00Z");
    return v;
  }
  function readValue(v) {
    if (typeof v === "string" && v.startsWith("'")) return v.slice(1);
    return v == null ? "" : v;
  }

  function makeSheet(name) {
    const rows = [];
    const sh = {
      _rows: rows, _name: name,
      setName(n) { sh._name = n; return sh; },
      getName() { return sh._name; },
      appendRow(r) { rows.push(r.map(sheetValue)); return sh; },
      setFrozenRows() { return sh; },
      getLastRow() { return rows.length; },
      getDataRange() { return sh.getRange(1, 1, Math.max(rows.length, 1), Math.max(...rows.map(r => r.length), 1)); },
      getRange(r, c, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        return {
          getValues() {
            const out = [];
            for (let i = 0; i < nr; i++) {
              const row = rows[r - 1 + i] || [];
              const o = [];
              for (let j = 0; j < nc; j++) o.push(readValue(row[c - 1 + j]));
              out.push(o);
            }
            return out;
          },
          getValue() { return this.getValues()[0][0]; },
          setValues(vals) {
            for (let i = 0; i < nr; i++) {
              rows[r - 1 + i] = rows[r - 1 + i] || [];
              for (let j = 0; j < nc; j++) rows[r - 1 + i][c - 1 + j] = sheetValue(vals[i][j]);
            }
            return this;
          },
          setValue(v) { return this.setValues([[v]]); },
          setFontWeight() { return this; },
        };
      },
    };
    return sh;
  }

  function folderObj(f) {
    return {
      getId: () => f.id, getName: () => f.name, getUrl: () => "https://drive.example/" + f.id,
      createFolder(name) { const id = newId("fo"); folders[id] = { id, name, parent: f.id }; return folderObj(folders[id]); },
      getFoldersByName(name) {
        const list = Object.values(folders).filter(x => x.parent === f.id && x.name === name);
        let i = 0;
        return { hasNext: () => i < list.length, next: () => folderObj(list[i++]) };
      },
      createFile(blob) {
        const id = newId("fi");
        files[id] = { id, name: blob.getName(), bytes: blob._bytes, type: blob.getContentType(), parent: f.id };
        return fileObj(files[id]);
      },
    };
  }
  function fileObj(f) {
    return {
      getId: () => f.id, getName: () => f.name,
      getBlob: () => blobObj(f.bytes, f.type, f.name),
      moveTo(folder) { f.parent = folder.getId(); return this; },
    };
  }
  function blobObj(bytes, type, name) {
    return { _bytes: bytes, getBytes: () => toSigned(bytes), getContentType: () => type, getName: () => name };
  }

  const ctx = {
    console,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
    }) },
    Logger: { log: m => logs.push(String(m)) },
    DriveApp: {
      createFolder(name) { const id = newId("fo"); folders[id] = { id, name, parent: null }; return folderObj(folders[id]); },
      getFolderById(id) { if (!folders[id]) throw new Error("no folder " + id); return folderObj(folders[id]); },
      getFileById(id) {
        if (files[id]) return fileObj(files[id]);
        if (sheetsById[id]) return { moveTo() { return this; } };
        throw new Error("no file " + id);
      },
    },
    SpreadsheetApp: {
      create(name) {
        const id = newId("ss");
        const ss = { id, name, sheets: [makeSheet("Tabellenblatt1")] };
        sheetsById[id] = ss;
        return ssObj(ss);
      },
      openById(id) { if (!sheetsById[id]) throw new Error("no sheet " + id); return ssObj(sheetsById[id]); },
    },
    Utilities: {
      base64Decode: s => toSigned(Buffer.from(s, "base64")),
      base64Encode: arr => toBuf(arr).toString("base64"),
      computeDigest: (_alg, v) => toSigned(crypto.createHash("sha256").update(typeof v === "string" ? Buffer.from(v, "utf8") : toBuf(v)).digest()),
      DigestAlgorithm: { SHA_256: "SHA_256" },
      newBlob: (arr, type, name) => blobObj(toBuf(arr), type, name),
      getUuid: () => crypto.randomUUID(),
      formatDate(d, tz, _fmt) {
        const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
        return p; // yyyy-MM-dd
      },
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput(s) { return { _s: s, setMimeType() { return this; } }; },
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    UrlFetchApp: {
      fetch(url, opts) {
        fetchStub.calls.push({ url, opts });
        const r = fetchStub.handler ? fetchStub.handler(url, opts) : { code: 500, body: { error: { message: "kein Stub" } } };
        return { getResponseCode: () => r.code, getContentText: () => JSON.stringify(r.body) };
      },
    },
  };
  function ssObj(ss) {
    return {
      getId: () => ss.id, getUrl: () => "https://sheets.example/" + ss.id,
      setSpreadsheetTimeZone() {},
      getSheets: () => ss.sheets,
      insertSheet(name) { const s = makeSheet(name); ss.sheets.push(s); return s; },
      getSheetByName: name => ss.sheets.find(s => s._name === name) || null,
    };
  }

  vm.createContext(ctx);
  ctx.__Date = vm.runInContext("Date", ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "Code.gs"), "utf8"), ctx, { filename: "Code.gs" });

  const sheet = name => sheetsById[props.SHEET_ID].sheets.find(s => s._name === name);
  return { ctx, props, files, folders, logs, fetchStub, sheet };
}

// HTTP-Server: App unter appPort, Apps-Script-Web-App unter apiPort.
function startServers(gas) {
  const root = path.join(__dirname, "..");
  const pending = {};
  let n = 0;
  const cors = { "Access-Control-Allow-Origin": "*" };
  const api = http.createServer((req, res) => {
    if (req.method === "OPTIONS") { // echtes Apps Script beantwortet keinen Preflight
      res.writeHead(405); return res.end();
    }
    if (req.url.startsWith("/exec") && req.method === "POST") {
      if ((req.headers["content-type"] || "").indexOf("text/plain") !== 0) { res.writeHead(415); return res.end(); }
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        if (api.offline) { req.socket.destroy(); return; }
        const out = gas.ctx.doPost({ postData: { contents: body } });
        const id = "e" + (n++);
        pending[id] = out._s;
        res.writeHead(302, { ...cors, Location: "/echo?id=" + id });
        res.end();
      });
      return;
    }
    if (req.url.startsWith("/echo")) {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      return res.end(pending[id] || "{}");
    }
    if (req.url.startsWith("/exec")) {
      res.writeHead(200, cors); return res.end(gas.ctx.doGet()._s);
    }
    res.writeHead(404); res.end();
  });
  const app = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x").pathname;
    const f = u === "/" ? "index.html" : u.slice(1);
    if (f === "blank.html") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<!doctype html><title>x</title>"); }
    const p = path.join(root, f);
    if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    const type = f.endsWith(".html") ? "text/html; charset=utf-8" : f.endsWith(".png") ? "image/png" : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    fs.createReadStream(p).pipe(res);
  });
  return Promise.all([
    new Promise(r => api.listen(0, "127.0.0.1", () => r())),
    new Promise(r => app.listen(0, "127.0.0.1", () => r())),
  ]).then(() => ({
    api, app,
    apiUrl: `http://127.0.0.1:${api.address().port}/exec`,
    appUrl: `http://127.0.0.1:${app.address().port}/`,
    close: () => { api.close(); app.close(); },
  }));
}

module.exports = { createGas, startServers };
