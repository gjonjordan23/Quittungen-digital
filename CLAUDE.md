# Spesen-App – Hinweise für Claude

Web-App zum Erfassen von Spesenbelegen per Handyfoto. Die Spesen landen in einer
gemeinsamen Ablage (Google Drive + Google Sheets) eines Firmen-Google-Kontos.
Der Nutzer ist kein Programmierer: Antworten auf Deutsch in Schweizer Schreibweise
(ss statt ß), Schritt für Schritt, mit genauen Klickpfaden. Vor grösseren Änderungen
oder Löschungen nachfragen.

**Tatsächliche Nutzung:** Im Alltag erfasst eine Person alle Belege. Die Mehrgeräte-
Funktionen (Einladungslink, Personenfilter) sind vorhanden und getestet, aber nicht der
Kern. Der Nutzen der Ablage ist vor allem: Daten nicht nur im Browser (Datenverlust),
Archiv im Firmen-Drive, KI-Schlüssel nicht auf dem Handy. Keine neuen Mehrbenutzer-
Funktionen ohne Rückfrage.

## Dateien

| Datei | Zweck |
| --- | --- |
| `index.html` | Die ganze App: HTML + CSS + Vanilla-JS, kein Build, keine Frameworks. SheetJS per CDN (Excel-Export, Fallback CSV). Ausgeliefert über GitHub Pages (main, root). |
| `Code.gs` | Backend als Google Apps Script. **Nur eine Kopie**: das echte Skript läuft im Apps-Script-Editor und wird von Hand dorthin kopiert. |
| `apple-touch-icon.png` | Icon für «Zum Home-Bildschirm». |
| `test/mock-gas.js`, `test/run.js` | Nachbau der Apps-Script-Dienste und End-to-End-Tests (siehe unten). |

## Frontend (`index.html`)

- IndexedDB `spesenDB`, Version 2: Stores `expenses` (keyPath `id`), `receipts`
  (`id` → dataURL), `outbox` (keyPath `key`, Warteschlange). Version 1 (alte App) hatte
  nur `expenses` und `receipts`; das Upgrade behält die Daten.
- localStorage `spesen:settings`: `who`, `kmRate` (0.7), `lunchRate` (25), `apiUrl`,
  `pin`, `scan`. Alte Felder `apiKey`/`model` werden beim Laden entfernt.
- Ohne Verbindung: alles lokal («Nur dieses Gerät»), Austausch per .json-Export/-Import.
- Mit Verbindung: jede Speicherung/Löschung zuerst in die `outbox`, dann `flushOutbox()`.
  Neuer Versuch bei `online` und bei `visibilitychange` → sichtbar. `refreshFromServer()`
  lädt die Liste vom Server und behält lokale, noch nicht gesendete Einträge.
- Server-Aufruf: `fetch` POST an die Web-App-URL, `Content-Type: text/plain`
  (absichtlich: kein CORS-Preflight, den Apps Script nicht beantwortet). Body:
  JSON `{action, pin, ...}`. Antwort `{ok, ...}` bzw. `{ok:false, error}`.
- Einladungslink: `<App-URL>#verbinden=<base64url(JSON {u: WebAppURL, p: Zugangscode})>`.
  Die App verbindet sich beim Öffnen selbst. Der Hash bleibt absichtlich stehen, damit
  «Zum Home-Bildschirm» auf dem iPhone die Verbindung mitnimmt.
- Jede Spese hat `who` («Erfasst von»). Filter nach Person, Jahr, Monat. Excel-Export,
  Druckbericht (Jahresbericht mit Monats-Zwischentotalen, Kategorien, Belegfotos).
- Fotos werden vor dem Speichern auf max. 1100 px, JPEG 0.7 verkleinert.
- Kategorie-IDs (nie ändern): `verpflegung`, `mittagessen` (Pauschale), `fahrt_km`
  (km × Ansatz, immer CHF), `treibstoff`, `transport`, `uebernachtung`, `material`,
  `repraesentation`, `sonstiges`.
- Fremde Daten (Import-Dateien, Server-Antworten) nie ungeprüft in `innerHTML`:
  `textContent` oder `escapeHtml()` verwenden. Import validiert über `validImport()` /
  `validImage()`.

## Backend (`Code.gs`)

- Bereitstellung als Web-App: «Ausführen als: Ich», «Zugriff: Jeder». Schutz über einen
  20-stelligen Zugangscode.
- Skripteigenschaften: `FOLDER_ID`, `SHEET_ID`, `PIN`, `ANTHROPIC_KEY` (optional),
  `MODEL` (optional). Vor einem Modellwechsel in den Anthropic-Docs prüfen, welches
  günstige Modell aktuell ist.
- Von Hand auszuführen: `einrichten`, `zugangscodeAnzeigen`, `zugangscodeErneuern`.
- `doPost`-Aktionen: `ping`, `list`, `save`, `delete`, `image`, `scan`.
- Tabelle, Blatt «Spesen», 20 Spalten in dieser Reihenfolge: ID, Datum, Kategorie-ID,
  Kategorie, Beschreibung, Händler, km, Betrag, Währung, Kurs, Betrag CHF, Erfasst von,
  Beleg (Drive-Datei), Beleg SHA-256, Status, Gespeichert am (Server), Zuletzt geändert,
  Version, Beleg-Link, Bezahlt mit. Blatt «Protokoll»: Zeitpunkt, Aktion, ID, Wer, Vorher,
  Nachher.
- Die echte Tabelle wurde mit 18 Spalten angelegt. `ensureColumns_()` ergänzt fehlende
  Spaltentitel hinten beim nächsten Speichern und trägt Beleg-Links einmalig nach.
- «Bezahlt mit» (`paidBy`): `privat` (wird zurückerstattet), `firma` (Firmenkarte) oder
  leer (ältere Einträge). Gehört zu den Geschäftsfeldern (Änderung → neue Version +
  Protokoll). Die App zeigt im Total, Excel und Bericht die Aufteilung.
- Die Firma ist nicht MWST-pflichtig: keine MWST-Felder nötig. KI-Erkennung wird bewusst
  nicht genutzt (kein `ANTHROPIC_KEY`).
- Fotos: Drive `<Ablage>/Belege/<Jahr>/<Datum>_<Wer>_<Händler>_<Hash8>.jpg`.
- KI-Erkennung (`scan`) nur im Backend; der Anthropic-Schlüssel kommt nie ins Frontend.
- Schreibzugriffe unter `LockService`. Texte, die mit `= + - @` beginnen, bekommen ein
  Apostroph vorangestellt (Formel-Schutz).

## Nicht verhandelbare Regeln

1. **Das Repo ist öffentlich.** Nie API-Schlüssel, Zugangscode, Web-App-URL,
   E-Mail-Adressen oder Personendaten in eine Datei schreiben – auch nicht in
   Kommentare, Tests, Commit-Messages oder diese Datei.
2. **Archivpflicht (GeBüV, 10 Jahre):** Fotos nie überschreiben (neues Foto = neue
   Drive-Datei mit neuer SHA-256). Löschen nur als Status «gelöscht», Zeilen nie
   entfernen. Jede Erfassung/Änderung/Löschung ins «Protokoll». Zeitstempel setzt der
   Server.
3. Spaltenreihenfolge, Blattnamen, Kategorie-IDs und IndexedDB-Name nicht ändern – es
   gibt echte Daten. Neue Spalten nur hinten anhängen; IndexedDB-Upgrades nur additiv.
4. Die App bleibt **eine** `index.html` ohne Build-Schritt.
5. Bei Änderungen an beiden Dateien zuerst `Code.gs` bereitstellen lassen, dann erst
   `index.html` auf main bringen (neues Frontend an altem Backend verliert neue Felder).
6. Änderungen an `Code.gs` wirken erst nach «Bereitstellen → Bereitstellungen verwalten
   → Stift → Version: Neue Version → Bereitstellen» (URL bleibt gleich). Das dem Nutzer
   bei jeder Änderung sagen, zusammen mit: welche Datei wo hochladen bzw. ersetzen.

## Testen

```bash
node test/run.js
```

- Startet die echte `index.html` in Chromium (Playwright, vorinstalliert) gegen
  `test/mock-gas.js`. Der Mock lädt `Code.gs` in eine Node-VM und bildet die benutzten
  Dienste nach (Properties, Drive, Sheets inkl. Datums-Umwandlung und Apostroph, Utilities,
  ContentService, LockService, UrlFetchApp-Stub). Er antwortet wie Apps Script mit 302 auf
  eine Echo-URL und beantwortet keinen CORS-Preflight.
- Abgedeckt: Upgrade von IndexedDB v1, km in CHF, falscher Zugangscode, Einladungslink,
  Hochladen lokaler Spesen, Foto mit SHA-256 und Dateiname, Formel-Schutz, zwei Geräte,
  Bearbeiten (Version + Protokoll), Soft-Delete, offline erfassen und nachsenden,
  KI-Scan über Backend, Import fehlerhafter Dateien.
- Der Mock ist nicht das echte Apps Script. Nicht abgedeckt: Laufzeit- und Kontingent-
  Limits, echte Google-Weiterleitung, iOS-Safari-Verhalten (Home-Bildschirm, Speicher).
- Nach Änderungen an `Code.gs` mindestens `node --check` auf eine `.js`-Kopie und die
  Tests laufen lassen. Neue Funktionen bekommen eine Prüfung in `test/run.js`.
