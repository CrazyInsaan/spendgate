// End-to-end tests for SpendGate. Usage: node run.mjs <webkit|chromium> <baseUrl>
import { webkit, chromium, devices } from 'playwright';
import QRCode from 'qrcode';
import fs from 'fs';

const engine = process.argv[2] || 'webkit';
const BASE = process.argv[3] || 'http://localhost:8765/';
const SHOTS = new URL('./shots/', import.meta.url).pathname; fs.mkdirSync(SHOTS, { recursive: true });
const NOW = new Date('2026-11-04T15:00:00+05:30'); // Wednesday

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; } else { fail++; failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

// ---------- helpers ----------
const f = (t, v) => t + String(v.length).padStart(2, '0') + v;
const EMV = f('00', '01') + f('01', '12') + f('26', f('00', 'A000000524') + f('01', 'tea.stall@ybl')) + f('52', '5812') + f('53', '356') + f('54', '30.00') + f('58', 'IN') + f('59', 'RAVI TEA') + f('60', 'HYD') + '6304ABCD';
const qrPng = async (text, scale = 8) => QRCode.toBuffer(text, { type: 'png', scale, margin: 4 });

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({
    ...(engine === 'webkit' ? devices['iPhone 13'] : { viewport: { width: 390, height: 844 }, hasTouch: true }),
    timezoneId: 'Asia/Kolkata', locale: 'en-IN', colorScheme: opts.dark ? 'dark' : 'light',
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/gpay|phonepe|paytmmp|upi:|scheme|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
  await page.clock.setFixedTime(NOW);
  // Record payment-app hand-offs instead of letting the browser try to open an unknown scheme.
  await page.addInitScript(() => { window.__nav = []; });
  await page.route(/^(gpay|phonepe|paytmmp|upi):/, r => r.abort());
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  return { ctx, page, errors };
}
const toastText = page => page.locator('.toast').last().textContent({ timeout: 3000 }).catch(() => null);
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('spendgate.v1') || '{"tx":[]}'));
async function fill(page, { vpa, amount, note, cat }) {
  if (vpa !== undefined) await page.fill('#f-vpa', vpa);
  if (amount !== undefined) await page.fill('#f-amount', amount);
  if (note !== undefined) await page.fill('#f-note', note);
  if (cat) await page.click(`#f-cats .chip:text-is("${cat}")`);
}
async function seed(page, tx) {
  await page.evaluate(tx => localStorage.setItem('spendgate.v1', JSON.stringify({ tx, app: 'gpay' })), tx);
  await page.reload();
}
const tab = (page, name) => page.click(`nav.tabs button[data-tab="${name}"]`);
const T = s => new Date(s).getTime();

const browser = await (engine === 'webkit' ? webkit : chromium).launch(
  engine === 'chromium' ? { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${SHOTS}../qr.y4m`] } : {});

// ======================= 1. QR parsing & payment links =======================
{
  const { ctx, page, errors } = await newPage(browser);
  const r = await page.evaluate(EMV => {
    const S = window.__spendgate, P = s => { const x = S.parseQR(s); return x && { pa: x.pa, pn: x.pn, am: x.am }; };
    return {
      basic: P('upi://pay?pa=shop.123@okaxis&pn=Ravi%20Tea%20Stall&mc=5812&cu=INR'),
      upper: P('UPI://pay?pa=a.b@ybl&pn=AB'),
      withAm: P('upi://pay?pa=x@paytm&pn=X&am=120.50&cu=INR'),
      plusName: P('upi://pay?pa=x@oksbi&pn=Ravi+Kumar'),
      noPa: P('upi://pay?pn=Nobody'),
      emv: P(EMV),
      url: P('https://example.com/menu'),
      empty: P(''),
      plainVpa: P('ravi@okicici'),
      gpay: S.buildPayUrl('gpay', { payee: 'shop.123@okaxis', payeeName: 'Ravi', amount: 45, note: 'chai & snacks', qrParams: 'pa=shop.123@okaxis&pn=Ravi&mc=5812' }),
      phonepe: S.buildPayUrl('phonepe', { payee: 'a@ybl', payeeName: '', amount: 1200.5, note: 'rent share', qrParams: '' }),
      paytm: S.buildPayUrl('paytm', { payee: 'a@paytm', payeeName: 'A', amount: 10, note: 'x y', qrParams: '' }),
      upi: S.buildPayUrl('upi', { payee: 'a@upi', payeeName: '', amount: 1, note: 'n', qrParams: '' }),
      signed: S.buildPayUrl('gpay', { payee: 'm@hdfc', payeeName: 'Shop', amount: 99, note: 'my note', qrParams: 'pa=m@hdfc&pn=Shop&am=50.00&tn=ORDER123&sign=abc' }),
    };
  }, EMV);
  eq(r.basic, { pa: 'shop.123@okaxis', pn: 'Ravi Tea Stall', am: '' }, 'parse: basic upi QR');
  eq(r.upper, { pa: 'a.b@ybl', pn: 'AB', am: '' }, 'parse: uppercase scheme');
  eq(r.withAm, { pa: 'x@paytm', pn: 'X', am: '120.50' }, 'parse: QR with fixed amount');
  eq(r.plusName.pn, 'Ravi Kumar', 'parse: + decoded as space');
  eq(r.noPa, null, 'parse: upi QR without UPI ID rejected');
  eq(r.emv, { pa: 'tea.stall@ybl', pn: 'RAVI TEA', am: '30.00' }, 'parse: Bharat/EMV QR');
  eq(r.url, null, 'parse: website QR rejected');
  eq(r.empty, null, 'parse: empty rejected');
  eq(r.plainVpa, { pa: 'ravi@okicici', pn: '', am: '' }, 'parse: bare UPI ID');
  eq(r.gpay, 'gpay://upi/pay?pa=shop.123@okaxis&pn=Ravi&mc=5812&am=45.00&cu=INR&tn=chai%20%26%20snacks', 'link: gpay');
  eq(r.phonepe, 'phonepe://pay?pa=a@ybl&am=1200.50&cu=INR&tn=rent%20share', 'link: phonepe');
  eq(r.paytm, 'paytmmp://pay?pa=a@paytm&pn=A&am=10.00&cu=INR&tn=x%20y', 'link: paytm');
  eq(r.upi, 'upi://pay?pa=a@upi&am=1.00&cu=INR&tn=n', 'link: generic upi');
  ok(r.signed.includes('am=50.00') && r.signed.includes('tn=ORDER123') && r.signed.includes('sign=abc') && !r.signed.includes('my%20note'), 'link: merchant fields left untouched', r.signed);
  ok(errors.length === 0, 'no page errors (parsing)', errors);
  await ctx.close();
}

// ======================= 2. QR images =======================
{
  const { ctx, page, errors } = await newPage(browser);
  const upload = async (name, buf, mime = 'image/png') => {
    await page.setInputFiles('#photo-input', { name, mimeType: mime, buffer: buf });
  };
  // simple merchant QR, no amount
  await upload('a.png', await qrPng('upi://pay?pa=chaiwala@okaxis&pn=Chai%20Wala&cu=INR'));
  await page.waitForSelector('#payee-box:not([hidden])', { timeout: 5000 }).catch(() => {});
  eq(await page.textContent('#payee-name'), 'Chai Wala', 'photo QR: payee name shown');
  eq(await page.textContent('#payee-vpa'), 'chaiwala@okaxis', 'photo QR: UPI ID shown');
  ok(await page.isHidden('#vpa-entry'), 'photo QR: manual UPI field hidden');
  ok(!(await page.$eval('#f-amount', e => e.readOnly)), 'photo QR: amount editable when QR has none');
  ok(await page.evaluate(() => document.activeElement.id) === 'f-amount', 'photo QR: amount focused');
  ok(await page.isDisabled('#btn-pay'), 'photo QR: pay disabled until filled');
  await fill(page, { amount: '20', note: 'tea', cat: 'Food' });
  ok(await page.isEnabled('#btn-pay'), 'photo QR: pay enabled after filling');
  ok(await page.isVisible('#app-pick'), 'photo QR: app picker visible');
  // clear payee
  await page.click('#payee-clear');
  ok(await page.isVisible('#vpa-entry') && await page.isHidden('#payee-box'), 'clear payee restores manual entry');
  ok(await page.isDisabled('#btn-pay'), 'pay disabled after clearing payee with no UPI ID');

  // QR with amount → locked
  await upload('b.png', await qrPng('upi://pay?pa=shop@ybl&pn=Shop&am=149.00&cu=INR'));
  await page.waitForTimeout(400);
  if (process.env.DBG) console.log('DBG', await page.isVisible('#payee-box'), await page.locator('.toast').allTextContents(), await page.inputValue('#f-amount'), errors);
  eq(await page.inputValue('#f-amount'), '149', 'fixed-amount QR: amount filled');
  ok(await page.$eval('#f-amount', e => e.readOnly), 'fixed-amount QR: amount locked');
  ok(await page.evaluate(() => document.activeElement.id) === 'f-note', 'fixed-amount QR: reason focused');
  await page.click('#payee-clear');
  ok(!(await page.$eval('#f-amount', e => e.readOnly)), 'clearing payee unlocks amount');

  // EMV QR
  await upload('c.png', await qrPng(EMV));
  await page.waitForTimeout(400);
  eq(await page.textContent('#payee-vpa'), 'tea.stall@ybl', 'EMV QR image decoded');
  await page.click('#payee-clear');

  // non-UPI QR
  await upload('d.png', await qrPng('https://example.com'));
  eq(await toastText(page), 'That QR code isn\'t a UPI payment code', 'website QR: clear error');
  ok(await page.isHidden('#payee-box'), 'website QR: payee not set');

  // image with no QR
  const blank = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d'); x.fillStyle = '#ccc'; x.fillRect(0, 0, 400, 300); return c.toDataURL('image/png').split(',')[1]; });
  await page.waitForTimeout(2700);
  await upload('blank.png', Buffer.from(blank, 'base64'));
  eq(await toastText(page), 'No QR code found in that photo', 'no-QR photo: clear error');

  // not an image
  await page.waitForTimeout(2700);
  await upload('x.png', Buffer.from('not an image'));
  eq(await toastText(page), 'Couldn\'t read that image', 'broken image: clear error');

  // realistic photo: small, slightly rotated QR on a large noisy JPEG
  const qrData = (await qrPng('upi://pay?pa=bigphoto@okhdfcbank&pn=Medical%20Store', 4)).toString('base64');
  const photo = await page.evaluate(async b64 => {
    const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
    const c = document.createElement('canvas'); c.width = 4032; c.height = 3024; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 4032, 3024); g.addColorStop(0, '#8a7f6a'); g.addColorStop(1, '#d9d2c3'); x.fillStyle = g; x.fillRect(0, 0, 4032, 3024);
    for (let i = 0; i < 4000; i++) { x.fillStyle = `rgba(0,0,0,${Math.random() * .15})`; x.fillRect(Math.random() * 4032, Math.random() * 3024, 20, 20); }
    x.save(); x.translate(2300, 1500); x.rotate(0.12); x.fillStyle = '#fff'; x.fillRect(-260, -260, 520, 520); x.drawImage(im, -230, -230, 460, 460); x.restore();
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }, qrData);
  await upload('IMG_0001.jpg', Buffer.from(photo, 'base64'), 'image/jpeg');
  await page.waitForSelector('#payee-box:not([hidden])', { timeout: 8000 }).catch(() => {});
  eq(await page.textContent('#payee-vpa').catch(() => null), 'bigphoto@okhdfcbank', 'phone-camera-sized photo with small tilted QR decoded');
  ok(errors.length === 0, 'no page errors (QR images)', errors);
  await ctx.close();
}

// ======================= 3. Form validation & logging =======================
{
  const { ctx, page, errors } = await newPage(browser);
  ok(await page.isDisabled('#btn-pay') && await page.isDisabled('#btn-logonly'), 'empty form: both buttons disabled');
  eq(await page.textContent('#missing'), 'Still needed: amount, category, reason', 'empty form: lists what is missing');
  ok(await page.isHidden('#app-pick'), 'empty form: app picker hidden');
  for (const bad of ['0', '-5', 'abc', '₹', ' ']) {
    await page.fill('#f-amount', bad);
    ok((await page.textContent('#missing')).includes('amount'), `invalid amount "${bad}" rejected`);
  }
  await fill(page, { amount: '₹1,250.5', note: 'a' });
  ok((await page.textContent('#missing')).includes('reason'), 'one-letter reason rejected');
  await fill(page, { note: '   ' });
  ok((await page.textContent('#missing')).includes('reason'), 'blank reason rejected');
  await fill(page, { note: 'groceries for week', cat: 'Groceries' });
  ok(await page.$eval('#f-cats .chip[aria-pressed="true"]', e => e.textContent) === 'Groceries', 'category chip shows selected');
  await page.click('#f-cats .chip:text-is("Food")');
  eq(await page.$$eval('#f-cats .chip[aria-pressed="true"]', es => es.map(e => e.textContent)), ['Food'], 'only one category selected at a time');
  ok(await page.isEnabled('#btn-logonly') && await page.isDisabled('#btn-pay'), 'no UPI ID: can log, cannot pay');
  ok((await page.textContent('#missing')).startsWith('No UPI ID'), 'no UPI ID: explains why pay is disabled');
  for (const bad of ['ravi', 'ravi@', '@ybl', 'ra vi@ybl', 'ravi@1bank']) {
    await page.fill('#f-vpa', bad);
    ok(await page.isDisabled('#btn-pay') && (await page.textContent('#missing')).includes('doesn\'t look right'), `bad UPI ID "${bad}" rejected`);
  }
  for (const good of ['ravi.kumar@okaxis', '9876543210@ybl', 'shop-1_a@paytm', 'name@oksbi']) {
    await page.fill('#f-vpa', good);
    ok(await page.isEnabled('#btn-pay'), `UPI ID "${good}" accepted`);
  }
  ok(await page.isVisible('#app-pick'), 'app picker shows once UPI ID typed');
  // log only (with UPI ID)
  await page.click('#btn-logonly');
  let s = await stored(page);
  eq(s.tx.length, 1, 'log only: one entry saved');
  eq([s.tx[0].amount, s.tx[0].category, s.tx[0].note, s.tx[0].status, s.tx[0].payee], [1250.5, 'Food', 'groceries for week', 'paid', 'name@oksbi'], 'log only: saved fields correct');
  eq(s.tx[0].ts, NOW.getTime(), 'log only: timestamp is now');
  eq([await page.inputValue('#f-amount'), await page.inputValue('#f-note'), await page.inputValue('#f-vpa')], ['', '', ''], 'form resets after logging');
  ok(await page.$$eval('#f-cats .chip[aria-pressed="true"]', es => es.length) === 0, 'category resets after logging');
  // app choice is remembered
  await fill(page, { vpa: 'a@ybl' });
  await page.click('#f-apps .chip:text-is("PhonePe")');
  await page.reload();
  await fill(page, { vpa: 'a@ybl' });
  eq(await page.$eval('#f-apps .chip[aria-pressed="true"]', e => e.textContent), 'PhonePe', 'chosen payment app remembered after reload');
  // persistence
  s = await stored(page);
  eq(s.tx.length, 1, 'entries survive reload');
  ok(errors.length === 0, 'no page errors (form)', errors);
  await ctx.close();
}

// ======================= 4. Pay → confirm flows =======================
{
  const { ctx, page, errors } = await newPage(browser);
  const navs = [];
  page.on('request', r => { if (/^(gpay|phonepe|paytmmp|upi):/.test(r.url())) navs.push(r.url()); });
  page.on('framenavigated', fr => { if (/^(gpay|phonepe|paytmmp|upi):/.test(fr.url())) navs.push(fr.url()); });
  await page.evaluate(() => {
    // Capture the hand-off URL however the engine reports it.
    window.__vis = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => window.__vis, configurable: true });
  });
  const goAway = () => page.evaluate(() => { window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
  const comeBack = () => page.evaluate(() => { window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });

  // A: app opens, user pays, comes back
  await fill(page, { vpa: 'ravi@okaxis', amount: '250', note: 'lunch with Ravi', cat: 'Food' });
  await page.click('#btn-pay');
  let s = await stored(page);
  eq([s.tx.length, s.tx[0] && s.tx[0].status], [1, 'pending'], 'pay: entry saved as pending BEFORE app opens');
  await goAway(); await page.waitForTimeout(3300); await comeBack();
  await page.waitForTimeout(200);
  ok(await page.isVisible('#dlg-confirm'), 'pay: returning asks "did it go through?"');
  const txt = await page.textContent('#confirm-text');
  ok(txt.includes('₹250') && txt.includes('ravi@okaxis') && txt.includes('lunch with Ravi') && !txt.includes('didn\'t open'), 'confirm text describes the payment', txt);
  await page.fill('#confirm-amount', '260');
  await page.click('#confirm-yes');
  s = await stored(page);
  eq([s.tx[0].status, s.tx[0].amount], ['paid', 260], 'confirm yes: marked paid with corrected amount');
  ok(await page.isHidden('#dlg-confirm'), 'confirm dialog closes');
  ok(await page.isHidden('#pending-banner'), 'no banner when nothing is pending');
  ok(navs.length === 0 || navs[0].startsWith('gpay://upi/pay?pa=ravi@okaxis&am=250.00'), 'hand-off URL sent to GPay', navs);

  // B: app does not open (page never hidden) → asks after ~3s
  await fill(page, { vpa: 'x@ybl', amount: '99', note: 'test fail', cat: 'Other' });
  await page.click('#btn-pay');
  await page.waitForTimeout(1500);
  ok(await page.isHidden('#dlg-confirm'), 'no premature prompt within 1.5s');
  await page.waitForTimeout(2000);
  ok(await page.isVisible('#dlg-confirm'), 'app did not open: prompt appears');
  ok((await page.textContent('#confirm-text')).includes('didn\'t open'), 'app did not open: explains what to do');
  await page.click('#confirm-no');
  s = await stored(page);
  ok(!s.tx.some(t => t.note === 'test fail'), 'confirm no: failed payment removed');

  // C: not sure yet → stays pending, banner, review
  await fill(page, { vpa: 'y@ybl', amount: '40', note: 'auto', cat: 'Transport' });
  await page.click('#btn-pay');
  await goAway(); await page.waitForTimeout(200); await comeBack(); await page.waitForTimeout(200);
  await page.click('#confirm-later');
  ok(await page.isVisible('#pending-banner'), 'not sure: banner shows unconfirmed payment');
  ok((await page.textContent('#pending-banner')).includes('1 payment not confirmed'), 'banner count correct');
  // pending not counted in totals
  await tab(page, 'summary');
  eq(await page.textContent('#s-today'), '₹260', 'pending payments excluded from totals');
  await tab(page, 'history');
  ok((await page.textContent('#history')).includes('UNCONFIRMED'), 'history marks unconfirmed');
  await page.click('.tx:has-text("auto")');
  ok(await page.isVisible('#dlg-confirm'), 'tapping unconfirmed entry opens confirm');
  await page.click('#confirm-later');
  await tab(page, 'pay');
  await page.click('#pending-banner button');
  ok(await page.isVisible('#dlg-confirm'), 'banner Review opens confirm');
  // retry hands off again
  await page.click('#confirm-retry');
  ok(await page.isHidden('#dlg-confirm'), 'retry closes dialog to reopen the app');
  await goAway(); await page.waitForTimeout(200); await comeBack(); await page.waitForTimeout(200);
  ok(await page.isVisible('#dlg-confirm'), 'after retry, returning asks again');
  await page.click('#confirm-yes');
  ok(await page.isHidden('#pending-banner'), 'banner gone after confirming');
  // D: pending survives app being closed and reopened
  await fill(page, { vpa: 'z@ybl', amount: '15', note: 'killed app', cat: 'Other' });
  await page.click('#btn-pay');
  await page.reload();
  ok(await page.isVisible('#pending-banner'), 'unconfirmed payment still flagged after app restart');
  ok(errors.length === 0, 'no page errors (pay flow)', errors);
  await ctx.close();
}

// ======================= 5. History, edit, delete =======================
{
  const { ctx, page, errors } = await newPage(browser);
  await seed(page, [
    { id: 'a', ts: T('2026-11-04T09:00:00+05:30'), amount: 120, category: 'Food', note: 'breakfast', payee: 'idli@ybl', payeeName: 'Idli Corner', status: 'paid' },
    { id: 'b', ts: T('2026-11-04T13:30:00+05:30'), amount: 80.5, category: 'Transport', note: 'auto', payee: '', payeeName: '', status: 'paid' },
    { id: 'c', ts: T('2026-11-03T20:00:00+05:30'), amount: 500, category: 'Shopping', note: 'tshirt', payee: '', payeeName: '', status: 'paid' },
    { id: 'd', ts: T('2026-10-28T10:00:00+05:30'), amount: 1000, category: 'Bills', note: 'phone recharge', payee: '', payeeName: '', status: 'paid' },
  ]);
  await tab(page, 'history');
  const days = await page.$$eval('.day', ds => ds.map(d => [d.firstChild.textContent, d.lastChild.textContent]));
  eq(days, [['Today', '₹200.50'], ['Yesterday', '₹500'], ['Wed, 28 Oct', '₹1,000']], 'history: grouped by day with day totals');
  eq(await page.$$eval('.tx .note', ns => ns.map(n => n.textContent)), ['auto', 'breakfast', 'tshirt', 'phone recharge'], 'history: newest first');
  ok((await page.textContent('.tx:has-text("breakfast") .meta')).includes('Idli Corner'), 'history: shows who was paid');
  // edit
  await page.click('.tx:has-text("breakfast")');
  ok(await page.isVisible('#dlg-edit'), 'edit dialog opens');
  eq([await page.inputValue('#e-amount'), await page.inputValue('#e-note'), await page.inputValue('#e-date')], ['120', 'breakfast', '2026-11-04T09:00'], 'edit: fields prefilled');
  await page.fill('#e-amount', '');
  await page.click('#e-save');
  eq(await toastText(page), 'Amount and reason are required', 'edit: empty amount refused');
  ok(await page.isVisible('#dlg-edit'), 'edit: dialog stays open on error');
  await page.fill('#e-amount', '150');
  await page.fill('#e-note', 'breakfast + coffee');
  await page.click('#e-cats .chip:text-is("Personal")');
  await page.fill('#e-date', '2026-11-02T08:15');
  await page.click('#e-save');
  let s = await stored(page);
  const a = s.tx.find(t => t.id === 'a');
  eq([a.amount, a.note, a.category, a.ts], [150, 'breakfast + coffee', 'Personal', T('2026-11-02T08:15:00+05:30')], 'edit: all changes saved');
  ok((await page.$$eval('.day', ds => ds.map(d => d.firstChild.textContent))).includes('Mon, 2 Nov'), 'edit: moved to the new day');
  // cancel leaves things unchanged
  await page.click('.tx:has-text("auto")');
  await page.fill('#e-amount', '9999');
  await page.click('#e-cancel');
  eq((await stored(page)).tx.find(t => t.id === 'b').amount, 80.5, 'edit: cancel discards changes');
  // delete — dismiss first, then accept
  page.once('dialog', d => d.dismiss());
  await page.click('.tx:has-text("tshirt")'); await page.click('#e-delete');
  ok((await stored(page)).tx.some(t => t.id === 'c'), 'delete: cancelling keeps entry');
  page.once('dialog', d => d.accept());
  await page.click('#e-delete');
  ok(!(await stored(page)).tx.some(t => t.id === 'c'), 'delete: entry removed');
  ok(await page.isHidden('#dlg-edit'), 'delete: dialog closed');
  ok(errors.length === 0, 'no page errors (history)', errors);
  await ctx.close();
}

// ======================= 6. Summary maths =======================
{
  const { ctx, page, errors } = await newPage(browser);
  await seed(page, [
    { id: '1', ts: T('2026-11-04T00:00:00+05:30'), amount: 100, category: 'Food', note: 'midnight', status: 'paid' },     // today (edge)
    { id: '2', ts: T('2026-11-04T14:59:00+05:30'), amount: 50.25, category: 'Food', note: 'snack', status: 'paid' },      // today
    { id: '3', ts: T('2026-11-03T23:59:00+05:30'), amount: 200, category: 'Transport', note: 'cab', status: 'paid' },     // yesterday, this week
    { id: '4', ts: T('2026-11-02T00:00:00+05:30'), amount: 300, category: 'Shopping', note: 'shoes', status: 'paid' },    // Monday 00:00 → this week (edge)
    { id: '5', ts: T('2026-11-01T23:59:00+05:30'), amount: 400, category: 'Shopping', note: 'bag', status: 'paid' },      // Sunday → last week, this month
    { id: '6', ts: T('2026-10-31T23:59:00+05:30'), amount: 700, category: 'Bills', note: 'rent part', status: 'paid' },   // last month (edge)
    { id: '7', ts: T('2026-11-04T10:00:00+05:30'), amount: 999, category: 'Food', note: 'pending', status: 'pending' },   // excluded
    { id: '8', ts: T('2026-10-05T10:00:00+05:30'), amount: 0.1, category: 'Food', note: 'f1', status: 'paid' },
    { id: '9', ts: T('2026-10-06T10:00:00+05:30'), amount: 0.2, category: 'Food', note: 'f2', status: 'paid' },
  ]);
  await tab(page, 'summary');
  eq([await page.textContent('#s-today'), await page.textContent('#s-week'), await page.textContent('#s-month')], ['₹150.25', '₹650.25', '₹1,050.25'], 'summary: today / week (Mon start) / month');
  eq(await page.textContent('#m-label'), 'November 2026', 'summary: current month label');
  const rows = () => page.$$eval('#m-cats .cat', cs => cs.map(c => c.querySelector('.row').innerText.replace(/\s+/g, ' ').trim()));
  const r = await rows();
  eq(r, ['Shopping ₹700 · 67%', 'Transport ₹200 · 19%', 'Food ₹150.25 · 14%', 'Total ₹1,050.25'], 'summary: categories sorted, % and total correct');
  ok(await page.isDisabled('#m-next'), 'summary: cannot go to future month');
  await page.click('#m-prev');
  eq(await page.textContent('#m-label'), 'October 2026', 'summary: previous month');
  eq(await rows(), ['Bills ₹700 · 100%', 'Food ₹0.30 · 0%', 'Total ₹700.30'], 'summary: October totals, no floating-point junk');
  await page.click('#m-next');
  eq(await page.textContent('#m-label'), 'November 2026', 'summary: back to current month');
  // empty state
  await seed(page, []);
  await tab(page, 'summary');
  ok((await page.textContent('#m-cats')).includes('No confirmed spending'), 'summary: empty state');
  eq(await page.textContent('#s-month'), '₹0', 'summary: zero when empty');
  await tab(page, 'history');
  ok((await page.textContent('#history')).includes('Nothing logged yet'), 'history: empty state');
  ok(errors.length === 0, 'no page errors (summary)', errors);
  await ctx.close();
}

// ======================= 7. Export & import =======================
{
  const { ctx, page, errors } = await newPage(browser);
  await seed(page, [
    { id: 'e1', ts: T('2026-11-04T09:00:00+05:30'), amount: 45, category: 'Food', note: 'chai, "special"', payee: 'c@ybl', payeeName: 'Café Ravi', status: 'paid' },
    { id: 'e2', ts: T('2026-11-03T09:00:00+05:30'), amount: 10, category: 'Other', note: 'x', payee: '', payeeName: '', status: 'pending' },
  ]);
  // capture exports regardless of whether the engine uses the share sheet or a download
  await page.evaluate(() => {
    window.__shared = [];
    navigator.canShare = () => true;
    navigator.share = async ({ files }) => { for (const f of files) { const u = new Uint8Array(await f.arrayBuffer()); window.__shared.push({ name: f.name, type: f.type, bom: u[0] === 0xef && u[1] === 0xbb && u[2] === 0xbf, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(u) }); } };
  });
  await tab(page, 'data');
  eq(await page.textContent('#data-count'), '2 expenses stored on this device.', 'data: count shown');
  await page.click('#btn-export-json');
  await page.click('#btn-export-csv');
  await page.waitForTimeout(300);
  const shared = await page.evaluate(() => window.__shared);
  eq(shared.map(s => s.name), ['spendgate-backup-2026-11-04.json', 'spendgate-2026-11-04.csv'], 'export: file names');
  const backup = JSON.parse(shared[0].text);
  eq(backup.tx.length, 2, 'export json: all entries');
  const csv = shared[1].text;
  ok(shared[1].bom, 'export csv: UTF-8 marker for Excel');
  const lines = csv.slice(1).split('\n');
  eq(lines[0], 'Date,Time,Amount,Category,Reason,Paid to,UPI ID,Status', 'export csv: header');
  eq(lines[2], '"2026-11-04","09:00","45","Food","chai, ""special""","Café Ravi","c@ybl","paid"', 'export csv: commas and quotes escaped, oldest first');

  // import into a fresh device
  await seed(page, [{ id: 'keep', ts: T('2026-11-01T09:00:00+05:30'), amount: 5, category: 'Food', note: 'existing', status: 'paid' }]);
  await tab(page, 'data');
  await page.setInputFiles('#import-input', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(shared[0].text) });
  eq(await toastText(page), 'Imported 2 new entries', 'import: adds entries');
  await page.waitForTimeout(2700);
  await page.setInputFiles('#import-input', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(shared[0].text) });
  eq(await toastText(page), 'Imported 0 new entries', 'import: same backup twice adds no duplicates');
  eq((await stored(page)).tx.length, 3, 'import: existing data kept');
  await page.waitForTimeout(2700);
  await page.setInputFiles('#import-input', { name: 'junk.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  eq(await toastText(page), 'That file isn\'t a SpendGate backup', 'import: wrong file rejected');
  await page.waitForTimeout(2700);
  await page.setInputFiles('#import-input', { name: 'm.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ tx: [{ id: 'bad1', amount: 'abc', ts: 1 }, { id: 'bad2', amount: 5 }, { amount: 5, ts: 1 }, { id: 'good', amount: '12', ts: T('2026-11-04T08:00:00+05:30'), note: 'ok', category: 'Food' }] })) });
  eq(await toastText(page), 'Imported 1 new entry', 'import: malformed entries skipped');
  await tab(page, 'history');
  ok((await page.textContent('#history')).includes('ok'), 'import: imported entry visible in history');
  await tab(page, 'summary');
  ok(errors.length === 0, 'no page errors (data)', errors);
  await ctx.close();
}

// ======================= 8. Layout & usability =======================
for (const v of [{ width: 320, height: 568, n: 'se' }, { width: 390, height: 844, n: 'iphone' }, { width: 430, height: 932, n: 'max' }]) {
  for (const dark of [false, true]) {
    const { ctx, page, errors } = await newPage(browser, { viewport: { width: v.width, height: v.height }, dark });
    await seed(page, [
      { id: 'l1', ts: NOW.getTime() - 3600e3, amount: 123456.75, category: 'Friends & family', note: 'a very long reason text to see whether it wraps nicely', payee: 'averyveryverylongupiid.name@okhdfcbank', payeeName: 'Some Very Long Merchant Name Private Limited', status: 'paid' },
      { id: 'l2', ts: NOW.getTime() - 7200e3, amount: 50, category: 'Food', note: 'tea', status: 'pending' },
    ]);
    const tag = `${engine}-${v.n}-${dark ? 'dark' : 'light'}`;
    for (const t of ['pay', 'history', 'summary', 'data']) {
      await tab(page, t);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(over <= 0, `layout ${tag}/${t}: no sideways scrolling`, over);
      const junk = await page.evaluate(() => (document.body.innerText.match(/undefined|NaN|null|\[object/g) || []));
      ok(junk.length === 0, `layout ${tag}/${t}: no "undefined"/"NaN" shown`, junk);
      await page.screenshot({ path: `${SHOTS}${tag}-${t}.png`, fullPage: true });
    }
    await tab(page, 'pay');
    await page.setInputFiles('#photo-input', { name: 'a.png', mimeType: 'image/png', buffer: await qrPng('upi://pay?pa=averyveryverylongupiid.name@okhdfcbank&pn=Some%20Very%20Long%20Merchant%20Name%20Private%20Limited') });
    await page.waitForTimeout(300);
    await fill(page, { amount: '99', note: 'test', cat: 'Food' });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 0, `layout ${tag}: long payee name fits`, over);
    // tap targets
    const small = await page.$$eval('button:not([hidden])', bs => bs.filter(b => b.offsetParent && b.getBoundingClientRect().height < 32).map(b => b.textContent.trim() || b.getAttribute('aria-label')));
    ok(small.length === 0, `layout ${tag}: buttons big enough to tap`, small);
    // nav bar does not cover the last button
    const covered = await page.evaluate(() => { window.scrollTo(0, 1e6); const b = document.querySelector('#btn-logonly').getBoundingClientRect(); const n = document.querySelector('nav.tabs').getBoundingClientRect(); return b.bottom > n.top; });
    ok(!covered, `layout ${tag}: bottom bar never hides the buttons`);
    // text inputs ≥16px so iPhone doesn't zoom in
    const tiny = await page.$$eval('input', is => is.filter(i => parseFloat(getComputedStyle(i).fontSize) < 16).map(i => i.id));
    ok(tiny.length === 0, `layout ${tag}: inputs won't trigger iPhone zoom`, tiny);
    await page.screenshot({ path: `${SHOTS}${tag}-pay-filled.png`, fullPage: true });
    await page.click('#pending-banner button');
    const ct = await page.textContent('#confirm-text');
    ok(!/undefined|NaN|null/.test(ct) && await page.isHidden('#confirm-retry'), `layout ${tag}: confirm for entry without UPI ID reads cleanly`, ct);
    await page.screenshot({ path: `${SHOTS}${tag}-confirm.png` });
    ok(errors.length === 0, `no page errors (layout ${tag})`, errors);
    await ctx.close();
  }
}

// ======================= 9. Live camera scanning (Chromium fake camera) =======================
if (engine === 'chromium') {
  const camBrowser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${process.cwd()}/qr.y4m`] });
  const { ctx, page, errors } = await newPage(camBrowser);
  await ctx.grantPermissions(['camera'], { origin: new URL(BASE).origin }); await page.reload();
  await page.click('#btn-live');
  await page.waitForSelector('#payee-box:not([hidden])', { timeout: 10000 }).catch(() => {});
  if (process.env.DBG) console.log('CAM', await page.evaluate(() => { const v = document.querySelector('#scan-video'); return { scanner: !document.querySelector('#scanner').hidden, rs: v.readyState, w: v.videoWidth, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent) }; }), errors);
  eq(await page.textContent('#payee-vpa').catch(() => null), 'camera.test@okaxis', 'live camera: QR scanned');
  ok(await page.isHidden('#scanner'), 'live camera: scanner closes after scan');
  ok(await page.evaluate(() => !document.querySelector('#scan-video').srcObject || document.querySelector('#scan-video').srcObject.getTracks().every(t => t.readyState === 'ended')), 'live camera: camera turned off after scan');
  // a camera that sees no QR: scanner stays open, Cancel closes it and turns the camera off
  const plainCam = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const p2 = await newPage(plainCam);
  await p2.ctx.grantPermissions(['camera'], { origin: new URL(BASE).origin }); await p2.page.reload();
  await p2.page.click('#btn-live');
  await p2.page.waitForSelector('#scanner:not([hidden])', { timeout: 5000 }).catch(() => {});
  ok(await p2.page.isVisible('#scanner'), 'live camera: scanner opens full screen');
  await p2.page.screenshot({ path: `${SHOTS}chromium-scanner.png` });
  await p2.page.click('#scan-close');
  ok(await p2.page.isHidden('#scanner'), 'live camera: cancel closes scanner');
  ok(await p2.page.evaluate(() => { const s = document.querySelector('#scan-video').srcObject; return !s || s.getTracks().every(t => t.readyState === 'ended'); }), 'live camera: cancel turns camera off');
  ok(p2.errors.length === 0, 'no page errors (camera cancel)', p2.errors);
  await plainCam.close();
  ok(errors.length === 0, 'no page errors (camera)', errors);
  await ctx.close(); await camBrowser.close();
} else {
  console.log('(live camera: headless WebKit never answers the camera permission prompt, so it is covered by the Chromium run)');
}

await browser.close();
console.log(`\n${engine}: ${pass} passed, ${fail} failed`);
failures.forEach(x => console.log('  ✗ ' + x));
process.exit(fail ? 1 : 0);
