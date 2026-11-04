// A stand-in for a deployed Apps Script web app: runs the real sheets-sync.gs against an in-memory
// spreadsheet and answers like Google does (POST → 302 → JSON on another URL, CORS open).
import http from 'http';
import fs from 'fs';
import vm from 'vm';

const SCRIPT = fs.readFileSync(new URL('../sheets-sync.gs', import.meta.url), 'utf8');

export function createSheetServer(port) {
  let sheets, mode = 'up', delayMs = 0, requests = 0, ctx;
  const pending = new Map(); let seq = 0;

  function reset() {
    sheets = {};
    const ss = {
      getSheetByName: n => sheets[n] || null,
      insertSheet: n => (sheets[n] = makeSheet()),
      getUrl: () => 'https://docs.google.com/spreadsheets/d/FAKE/edit',
      getName: () => 'SpendGate',
      getSpreadsheetTimeZone: () => 'Asia/Kolkata',
    };
    ctx = vm.createContext({
      SpreadsheetApp: { getActiveSpreadsheet: () => ss },
      ContentService: { createTextOutput: s => ({ content: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
      LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
      Date, JSON, String, Number, isFinite, Math,
    });
    vm.runInContext(SCRIPT + '\n;globalThis.doPost = doPost; globalThis.doGet = doGet;', ctx);
  }

  function makeSheet() {
    const data = [];
    // Sheets keeps a leading ' as a "this is text" marker and doesn't return it.
    const store = v => (typeof v === 'string' && v.startsWith("'")) ? v.slice(1) : v;
    const range = (r, c, nr, nc) => ({
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (data[r - 1 + i] || [])[c - 1 + j] ?? '')),
      setValues: v => { v.forEach((row, i) => { data[r - 1 + i] = data[r - 1 + i] || []; row.forEach((x, j) => { data[r - 1 + i][c - 1 + j] = store(x); }); }); },
      setFontWeight() { return this; }, setNumberFormat() { return this; },
    });
    return {
      data,
      getLastRow: () => data.length,
      appendRow: row => { data.push(row.map(store)); },
      getRange: (a, b, c, d) => typeof a === 'string' ? range(1, 1, 0, 0) : range(a, b, c ?? 1, d ?? 1),
      deleteRow: r => { data.splice(r - 1, 1); },
      setFrozenRows() {},
    };
  }

  reset();
  const cors = { 'Access-Control-Allow-Origin': '*' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname.endsWith('/exec')) {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        requests++;
        if (mode === 'down') { res.socket.destroy(); return; }
        if (mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html', ...cors }); res.end('<html>Sign in - Google Accounts</html>'); return; }
        const reply = () => {
          const out = ctx.doPost({ postData: { contents: body } });
          const id = String(++seq); pending.set(id, out.content);
          res.writeHead(302, { Location: `http://localhost:${port}/echo?id=${id}`, ...cors }); res.end();
        };
        delayMs ? setTimeout(reply, delayMs) : reply();
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/echo') {
      const body = pending.get(url.searchParams.get('id')) || '{"ok":false}';
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors }); res.end(body); return;
    }
    res.writeHead(404, cors); res.end();
  });

  return {
    url: `http://localhost:${port}/macros/s/FAKE/exec`,
    listen: () => new Promise(r => server.listen(port, r)),
    close: () => new Promise(r => server.close(r)),
    reset,
    setMode: m => { mode = m; },
    setDelay: ms => { delayMs = ms; },
    rows: () => (sheets.Expenses ? sheets.Expenses.data.slice(1) : []),
    header: () => (sheets.Expenses ? sheets.Expenses.data[0] : null),
    requests: () => requests,
  };
}
