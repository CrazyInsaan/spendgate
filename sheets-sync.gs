/**
 * SpendGate → Google Sheets sync.
 *
 * Paste this into Extensions → Apps Script of the Google Sheet you want SpendGate to use,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * Paste the Web app URL into SpendGate's Data tab.
 *
 * Treat the Web app URL like a password: anyone who has it can read and add to this sheet.
 */

/** @OnlyCurrentDoc */ // this script can only open the sheet it is attached to

const SHEET_NAME = 'Expenses';
const HEADERS = ['Date', 'Time', 'Amount', 'Category', 'Reason', 'Paid to', 'UPI ID', 'Status',
  'App', 'Shop payment', 'ID', 'Timestamp', 'QR data', 'Last synced'];
const COL = { id: 11 }; // 1-based column of the ID

function doGet() {
  return out_({ ok: true, app: 'SpendGate sync' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad request' }); }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = sheet_(ss);
    if (req.action === 'ping') return out_({ ok: true, sheetUrl: ss.getUrl(), name: ss.getName() });
    if (req.action === 'list') return out_({ ok: true, rows: readAll_(sh) });
    if (req.action === 'sync') {
      const n = apply_(sh, ss.getSpreadsheetTimeZone(), req.upserts || [], req.deletes || []);
      return out_({ ok: true, written: n });
    }
    return out_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function sheet_(ss) {
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sh.getRange('A:A').setNumberFormat('yyyy-mm-dd');
    sh.getRange('B:B').setNumberFormat('h:mm am/pm');
    sh.getRange('C:C').setNumberFormat('#,##0.00');
    sh.getRange('K:K').setNumberFormat('@');
    sh.getRange('N:N').setNumberFormat('yyyy-mm-dd h:mm');
  }
  return sh;
}

// Text that starts with = + - @ would run as a formula; a leading ' keeps it as plain text.
function text_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function toRow_(t, now) {
  const d = new Date(Number(t.ts));
  return [d, d, Number(t.amount), text_(t.category), text_(t.note), text_(t.payeeName), text_(t.payee),
    t.status === 'pending' ? 'pending' : 'paid', text_(t.app), t.merchant ? 'Yes' : '',
    String(t.id), Number(t.ts), text_(t.qrParams), now];
}

function valid_(t) {
  return t && typeof t.id === 'string' && t.id.length > 0 && t.id.length < 100 &&
    isFinite(Number(t.ts)) && isFinite(Number(t.amount)) && Number(t.amount) > 0;
}

function apply_(sh, tz, upserts, deletes) {
  const last = sh.getLastRow();
  const ids = last > 1 ? sh.getRange(2, COL.id, last - 1, 1).getValues().map(r => String(r[0])) : [];
  const rowOf = {};
  ids.forEach((id, i) => { rowOf[id] = i + 2; });
  const now = new Date();
  const appends = [];
  let n = 0;
  upserts.filter(valid_).forEach(t => {
    const row = toRow_(t, now);
    if (rowOf[t.id]) sh.getRange(rowOf[t.id], 1, 1, row.length).setValues([row]);
    else { appends.push(row); rowOf[t.id] = -1; }
    n++;
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, HEADERS.length).setValues(appends);
  // Delete bottom-up so earlier row numbers stay valid.
  deletes.map(id => rowOf[String(id)]).filter(r => r > 1).sort((a, b) => b - a).forEach(r => { sh.deleteRow(r); n++; });
  return n;
}

function readAll_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS.length).getValues()
    .map(r => ({
      id: String(r[10]), ts: Number(r[11]), amount: Number(r[2]), category: String(r[3]), note: String(r[4]),
      payeeName: String(r[5]), payee: String(r[6]), status: r[7] === 'pending' ? 'pending' : 'paid',
      app: String(r[8]), merchant: r[9] === 'Yes', qrParams: String(r[12] || ''),
    }))
    .filter(valid_);
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
