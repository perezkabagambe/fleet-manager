/**
 * Receipts that arrive by email.
 *
 * Every car has its own receipt addresses: the app's Gmail address with "+" and a secret added, for example
 * potentiafleetmanager+k3f9a2c71b04@gmail.com. Gmail delivers it to the normal inbox, with the secret visible in the
 * To line. A timer (processReceiptEmails, every 5 minutes) reads new mail, and anything sent to a car's address (or
 * sent by an approved user, to the plain address) is stored in the Inbox exactly like an uploaded receipt: read by
 * Gemini, then waiting for a person to check it. Mail that is neither is ignored and never sent anywhere.
 *
 * Only the receipt itself goes to Gemini: the email's text (with every email address replaced by "[email]") and its
 * attached PDF or photo. Who sent it, who received it and the mail headers are never sent.
 *
 * Needs the Gmail permission, given once by running setupReceiptEmail in the Apps Script editor as the app account.
 * Until then nothing here runs.
 */

const RECEIPT_LABEL = 'Fleet-handled';
const RECEIPT_MAIL_QUERY = 'in:inbox newer_than:7d -label:' + RECEIPT_LABEL;
const RECEIPT_MAIL_BATCH = 5;     // emails read per run (each takes a few seconds); the rest wait for the next run
const RECEIPT_MAIL_THREADS = 25;  // threads looked at per run
const RECEIPT_INBOX_MAX = 200;
const MAX_EMAIL_FILE = 10000000;   // a photo straight from a phone camera is often 3 to 6 MB
const MIN_EMAIL_IMAGE = 15000;     // smaller pictures are logos and tracking pixels, not receipts
const RECEIPT_TAG_RE = /\+([a-z0-9]{2,32})@/i;

// ---------- each car's address ----------

function receiptMailbox_() {
  const set = String(props_().getProperty('RECEIPT_MAILBOX') || '').trim().toLowerCase();
  return normEmail_(set) || appEmail_();
}

const RECEIPT_SECRET_LENGTH = 8; // the public address's reference (it used to be 12; those addresses keep working)

/** The tags a stored secret answers to: the whole of it, and its first 8 characters (the short form shown today). */
function receiptSecretKeys_(secret) {
  const s = String(secret || '').toLowerCase();
  return s ? (s.length > RECEIPT_SECRET_LENGTH ? [s, s.slice(0, RECEIPT_SECRET_LENGTH)] : [s]) : [];
}

/** Every car by the tags that reach it: its public reference(s), and its registration (a registration two cars share points to neither). */
function receiptCarMaps_() {
  const carsBySecret = {};
  const carsByReg = {};
  Db.all('Cars').forEach(function (c) {
    if (isTrue_(c.deleted)) return;
    receiptSecretKeys_(c.receipt_secret).forEach(function (k) { if (!carsBySecret[k]) carsBySecret[k] = c; });
    const t = regTag_(c.registration);
    if (t.length >= 2) carsByReg[t] = Object.prototype.hasOwnProperty.call(carsByReg, t) ? null : c;
  });
  return { carsBySecret: carsBySecret, carsByReg: carsByReg };
}

/** A new public reference: random, and not one that already reaches a car (by reference or by registration). */
function newReceiptSecret_() {
  const m = receiptCarMaps_();
  let s = '';
  for (let i = 0; i < 20; i++) {
    s = randomToken_().slice(0, RECEIPT_SECRET_LENGTH);
    if (!m.carsBySecret[s] && !Object.prototype.hasOwnProperty.call(m.carsByReg, s)) break;
  }
  return s;
}

function receiptAddress_(tag) {
  const parts = receiptMailbox_().split('@');
  return parts[0].split('+')[0] + '+' + tag + '@' + parts[1];
}

/** A registration number as it is written in an address: letters and digits only, lower case ("AB12 CDE" is "ab12cde"). */
function regTag_(registration) {
  return String(registration || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
}

/**
 * A car has two addresses. The easy one is made from its registration number: it only works for mail sent by an approved
 * user (a number plate is public, so anyone could guess it). The public one has a secret in it and works for anyone,
 * so it suits shops and automatic forwarding rules.
 */
function receiptAddresses_(car, secret) {
  const tag = regTag_(car.registration);
  return { address: tag.length >= 2 ? receiptAddress_(tag) : '', privateAddress: receiptAddress_(String(secret).slice(0, RECEIPT_SECRET_LENGTH)), emailOn: receiptMailOn_() };
}

/** The car's receipt addresses. The public one is made on first use (so this action holds the script lock). */
function getReceiptAddress_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  let secret = car.receipt_secret;
  if (!secret) {
    secret = newReceiptSecret_();
    Db.update('Cars', car._row, touch_(car, ctx, { receipt_secret: secret }));
  }
  return receiptAddresses_(car, secret);
}

/** The car's easy address (made from its registration number). Changes nothing, so any signed-in user can ask. */
function getReceiptEmail_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const tag = regTag_(car.registration);
  return { address: tag.length >= 2 ? receiptAddress_(tag) : '' };
}

/** Admin only: every car's simple and public receipt addresses (a missing public address is made). */
function listReceiptAddresses_(p, ctx) {
  const cars = Db.all('Cars').filter(function (c) { return !isTrue_(c.deleted); }).sort(function (a, b) { return String(a.registration).localeCompare(String(b.registration)); });
  return {
    emailOn: receiptMailOn_(),
    cars: cars.map(function (c) {
      let secret = c.receipt_secret;
      if (!secret) {
        secret = newReceiptSecret_();
        Db.update('Cars', c._row, touch_(c, ctx, { receipt_secret: secret }));
      }
      const a = receiptAddresses_(c, secret);
      return { carId: c.id, registration: c.registration, address: a.address, privateAddress: a.privateAddress };
    }),
  };
}

/** Admin only: a new public address for the car. The old one stops working at once (use it if the address has been shared too widely). */
function replaceReceiptSecret_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const secret = newReceiptSecret_();
  Db.update('Cars', car._row, touch_(car, ctx, { receipt_secret: secret }));
  audit_(ctx.user, 'receipt_address_replaced', 'Car', car.id, 'New receipt email address for ' + car.registration);
  return receiptAddresses_(car, secret);
}

/** The timers this project has, as { handler, count } (shown on the Diagnostics page). */
function receiptTimerList_() {
  const counts = {};
  try { ScriptApp.getProjectTriggers().forEach(function (t) { const h = t.getHandlerFunction(); counts[h] = (counts[h] || 0) + 1; }); } catch (e) { return []; }
  return Object.keys(counts).sort().map(function (h) { return { handler: h, count: counts[h] }; });
}

/** Admin only: throw away the receipt timer (or timers) and make a fresh one that runs every 5 minutes. */
function resetReceiptTimer_(p, ctx) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'processReceiptEmails') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('processReceiptEmails').timeBased().everyMinutes(5).create();
  props_().setProperty('RECEIPT_MAIL_TIMER_MADE', nowIso_());
  audit_(ctx.user, 'receipt_timer_reset', 'Inbox', '', 'The receipt email timer was re-created');
  return { timers: receiptTimerList_() };
}

/** Has the timer been set up (see setupReceiptEmail)? */
function receiptMailOn_() {
  try { return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'processReceiptEmails'; }); } catch (e) { return false; }
}

// ---------- one-time set-up (run from the Apps Script editor) ----------

/**
 * Run this once from the Apps Script editor, signed in as the app account. Google asks for permission to use Gmail
 * (this is the one-time approval), then the label and the 5-minute timer are created. Safe to run again.
 */
function setupReceiptEmail() {
  receiptLabel_();
  ensureTrigger_('processReceiptEmails', 5);
  Logger.log('Receipt email is on. Cars\' receipt addresses are shown on each car\'s page.');
}

function receiptLabel_() {
  return GmailApp.getUserLabelByName(RECEIPT_LABEL) || GmailApp.createLabel(RECEIPT_LABEL);
}

// ---------- reading the mail ----------

/** "Name <a@b.com>" or "a@b.com" to a@b.com ('' if there is none). */
function senderEmail_(from) {
  const m = /<([^<>]+)>/.exec(String(from || ''));
  return normEmail_(m ? m[1] : from);
}

/** The part after the "+" in the address the mail was sent to (a secret or a registration), or ''. */
function receiptTagOf_(message) {
  let m = RECEIPT_TAG_RE.exec(String(message.getTo() || '') + ' ' + String(message.getCc() || ''));
  if (!m) { // sent as a hidden copy or through a forward: the delivery headers still say where it was delivered
    let raw = '';
    try { raw = String(message.getRawContent() || '').slice(0, 8000); } catch (e) { raw = ''; }
    const header = /^(?:Delivered-To|X-Original-To):.*$/gim;
    let h;
    while (!m && (h = header.exec(raw))) m = RECEIPT_TAG_RE.exec(h[0]);
  }
  return m ? m[1].toLowerCase() : '';
}

/** The email's text, ready to send for reading: headers and every email address removed. */
function receiptEmailText_(message) {
  let body = String(message.getPlainBody() || '');
  body = body.replace(/^\s*(?:From|To|Cc|Bcc|Reply-To|Sender)\s*:.*$/gim, '');
  const text = ('Subject: ' + String(message.getSubject() || '') + '\n\n' + body)
    .replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text.slice(0, RECEIPT_TEXT_MAX);
}

/** The kind of file an email attachment is, from its type or (when the type is vague) its name. '' if it is not a receipt-like file. */
function receiptFileKind_(mime, name) {
  mime = String(mime || '').toLowerCase();
  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (RECEIPT_READABLE.indexOf(mime) !== -1) return mime;
  const ext = (/\.([a-z0-9]+)$/i.exec(String(name || '')) || [])[1];
  const byExt = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
  return (mime === '' || mime === 'application/octet-stream') && ext && byExt[ext.toLowerCase()] ? byExt[ext.toLowerCase()] : '';
}

/**
 * The file to keep as the receipt: the best PDF or picture in the email (pictures pasted into the body count, as a photo
 * sent from a phone usually is one), otherwise the email itself as a PDF (or, failing that, plain text).
 */
function receiptEmailFile_(message) {
  let attachments = [];
  try { attachments = message.getAttachments({ includeInlineImages: true, includeAttachments: true }) || []; } catch (e) { attachments = []; }
  let pdf = null;
  let image = null;
  attachments.forEach(function (a) {
    let bytes;
    try { bytes = a.getBytes(); } catch (e) { return; }
    const kind = receiptFileKind_(a.getContentType(), a.getName());
    if (!kind || bytes.length > MAX_EMAIL_FILE) return;
    const found = { bytes: bytes, mime: kind, name: a.getName() };
    if (kind === 'application/pdf') {
      if (isPdf_(bytes) && (!pdf || bytes.length > pdf.bytes.length)) pdf = found;
    } else if (bytes.length >= MIN_EMAIL_IMAGE && (!image || bytes.length > image.bytes.length)) {
      image = found; // the biggest picture is the receipt; the rest are logos and decoration
    }
  });
  const chosen = pdf || image;
  if (chosen) {
    const ext = { 'application/pdf': ['.pdf', /\.pdf$/i], 'image/jpeg': ['.jpg', /\.jpe?g$/i], 'image/png': ['.png', /\.png$/i], 'image/webp': ['.webp', /\.webp$/i], 'image/heic': ['.heic', /\.heic$/i], 'image/heif': ['.heif', /\.heif$/i] }[chosen.mime];
    const base = cleanStr_(chosen.name, 100).replace(/[\\/:*?"<>|]/g, '_') || 'receipt';
    return { bytes: chosen.bytes, mime: chosen.mime, filename: ext[1].test(base) ? base : base + ext[0] };
  }
  try {
    const blob = Utilities.newBlob('<html><body>' + String(message.getBody() || '') + '</body></html>', 'text/html', 'receipt.html').getAs('application/pdf');
    const bytes = blob.getBytes();
    if (isPdf_(bytes) && bytes.length <= MAX_ATTACH_FILE) return { bytes: bytes, mime: 'application/pdf', filename: 'receipt-email.pdf' };
  } catch (e) { /* the email could not be turned into a PDF: keep its text instead */ }
  return { bytes: Utilities.newBlob(receiptEmailText_(message), 'text/plain', 'receipt-email.txt').getBytes(), mime: GENERIC_MIME, filename: 'receipt-email.txt' };
}

/** Decide what to do with one email: { car, user } to accept it, or { skip: 'why' }. */
function receiptClassify_(message, carsBySecret, carsByReg, usersByEmail) {
  const emailId = String(message.getId() || '');
  if (!emailId) return { skip: 'no message id' };
  const from = senderEmail_(message.getFrom());
  if (!from) return { skip: 'no sender address' };
  if (from === appEmail_()) return { skip: 'sent by the app\'s own address' };
  if (/^forwarding-noreply@google\.com$/.test(from)) return { skip: 'Gmail forwarding set-up message' };
  const tag = receiptTagOf_(message);
  const user = usersByEmail[from] || null;
  // the public address works for anyone; the registration address only for an approved user's mail
  const car = carsBySecret[tag] || (user ? carsByReg[tag] : null) || null;
  if (!car && !user) {
    return { skip: tag ? (carsByReg[tag] !== undefined ? 'sent to the registration address by someone who is not an approved user (' + from + ')' : 'the address tag "' + tag + '" matches no car') : 'not sent to a receipt address, and the sender (' + from + ') is not an approved user' };
  }
  return { car: car, user: user, from: from };
}

/** Store one email as an Inbox receipt and read it. Returns 'read' or 'skipped'. */
function handleReceiptMessage_(message, carsBySecret, carsByReg, usersByEmail) {
  const emailId = String(message.getId() || '');
  const verdict = receiptClassify_(message, carsBySecret, carsByReg, usersByEmail);
  if (verdict.skip) return 'skipped'; // never read, never sent anywhere
  const car = verdict.car;
  const user = verdict.user;
  const from = verdict.from;
  const seen = Db.all('Inbox').some(function (r) { return r.email_id === emailId; });
  if (seen) return 'skipped';
  if (Db.all('Inbox').filter(function (r) { return !isTrue_(r.deleted) && RECEIPT_OPEN.indexOf(r.status) !== -1; }).length >= RECEIPT_INBOX_MAX) return 'skipped';

  const file = receiptEmailFile_(message);
  const row = withScriptLock_(function () {
    return storeReceipt_({
      source: 'email', car_id: car ? car.id : '', sender: user ? user.name : from, subject: cleanStr_(message.getSubject(), 120), email_id: emailId, sender_id: user ? user.id : '',
    }, file.bytes, file.mime, file.filename, null);
  });
  audit_(null, 'receipt_emailed', 'Inbox', row.id, 'Receipt "' + file.filename + '" arrived by email' + (car ? ' for ' + car.registration : ''));
  readStoredReceipt_(row, '', receiptEmailText_(message), user ? user.id : ''); // an admin who sent it gets the confirmation instead of the admin notice
  return 'read';
}

/** Tell an approved user who emailed a receipt that it arrived and is waiting for review. (Strangers who use the public address get no reply.) */
function notifyReceiptSender_(row, user) {
  if (!dailyCap_('rc_ack', RECEIPT_MAIL_DAILY)) return;
  const read = row.status === 'Pending';
  const what = read
    ? 'We received your receipt' + (row.vendor ? ' from ' + row.vendor : '') + (row.total !== '' ? ' (' + (row.currency ? row.currency + ' ' : '') + row.total + ')' : '') + ' and it has been read.'
    : 'We received your receipt, but it could not be read automatically, so it needs to be filled in by hand.';
  const url = SITE_URL + '#/inbox';
  const html = layout_('Your receipt is waiting for approval',
    '<p>Hi ' + esc_(user.name) + ',</p>' +
    '<p>' + esc_(what) + ' It is now in the AI Inbox in Fleet Manager, waiting for someone to check it and add it to the vehicle\'s log. Nothing has been added yet.</p>' +
    button_(url, 'Open the AI Inbox'));
  const text = 'Hi ' + user.name + ',\n\n' + what + ' It is now in the AI Inbox in Fleet Manager, waiting for someone to check it and add it to the vehicle\'s log. Nothing has been added yet.\n' + url;
  sendMail_(user.email, 'Your receipt is waiting for approval', html, text);
}

/** Tell the sender, once, that the day's reading limit is used up and their receipt will be read tomorrow. */
function notifyReceiptQueued_(row, user) {
  if (!dailyCap_('rc_ack', RECEIPT_MAIL_DAILY)) return;
  const url = SITE_URL + '#/inbox';
  const html = layout_('Your receipt will be read tomorrow',
    '<p>Hi ' + esc_(user.name) + ',</p>' +
    '<p>We received your receipt, but the daily limit for reading receipts automatically has been reached. It is saved in the AI Inbox and will be read automatically tomorrow. We will email you again when it has been read and is waiting for approval.</p>' +
    '<p>You do not need to send it again.</p>' + button_(url, 'Open the AI Inbox'));
  const text = 'Hi ' + user.name + ',\n\nWe received your receipt, but the daily limit for reading receipts automatically has been reached. It is saved in the AI Inbox and will be read automatically tomorrow. We will email you again when it has been read and is waiting for approval. You do not need to send it again.\n' + url;
  sendMail_(user.email, 'Your receipt will be read tomorrow', html, text);
}

/** The timer: read new mail sent to a car's receipt address. Runs every 5 minutes (see setupReceiptEmail). */
function processReceiptEmails() {
  const props = props_();
  props.setProperty('RECEIPT_MAIL_LAST', nowIso_()); // shown on the Diagnostics page, to prove the timer is running
  try {
    const r = runReceiptMail_();
    props.setProperty('RECEIPT_MAIL_RESULT', 'ok: ' + r.looked + ' new thread' + (r.looked === 1 ? '' : 's') + ' looked at, ' + r.read + ' receipt' + (r.read === 1 ? '' : 's') + ' read from email, ' + r.retried + ' waiting receipt' + (r.retried === 1 ? '' : 's') + ' retried');
    return { read: r.read };
  } catch (e) {
    props.setProperty('RECEIPT_MAIL_RESULT', 'error: ' + cleanStr_(e && e.message ? e.message : JSON.stringify(e), 200));
    throw e;
  }
}

function runReceiptMail_() {
  let retried = 0;
  try { retried = readQueuedReceipts_(); } catch (e) { console.error('queue failed: ' + (e && e.stack ? e.stack : JSON.stringify(e))); }
  const threads = GmailApp.search(RECEIPT_MAIL_QUERY, 0, RECEIPT_MAIL_THREADS);
  if (!threads.length) return { read: 0, retried: retried, looked: 0 };
  Db.resetRequest();
  const maps = receiptCarMaps_();
  const carsBySecret = maps.carsBySecret;
  const carsByReg = maps.carsByReg;
  const usersByEmail = {};
  Db.all('Users').forEach(function (u) { if (!isTrue_(u.deleted) && u.status === 'Approved') usersByEmail[String(u.email).toLowerCase()] = u; });
  const label = receiptLabel_();
  let reads = 0;
  for (let t = 0; t < threads.length && reads < RECEIPT_MAIL_BATCH; t++) {
    const messages = threads[t].getMessages();
    let finished = true;
    for (let i = 0; i < messages.length; i++) {
      if (reads >= RECEIPT_MAIL_BATCH) { finished = false; break; }
      let outcome = 'skipped';
      try {
        outcome = handleReceiptMessage_(messages[i], carsBySecret, carsByReg, usersByEmail);
      } catch (e) {
        console.error('receipt email failed: ' + (e && e.stack ? e.stack : JSON.stringify(e)));
      }
      if (outcome === 'read') reads++;
    }
    if (finished) threads[t].addLabel(label); // handled (or ignored): not looked at again
  }
  return { read: reads, retried: retried, looked: threads.length };
}

/**
 * Run this from the Apps Script editor when emailed receipts do not show up. It prints (in the Execution log) whether the
 * timer is on and has run, whether the Gemini key is set, and for each recent email in the inbox what the app decided and
 * why. It shows senders and tags only, never the contents of an email.
 */
function checkReceiptEmail() {
  const out = receiptMailReport_();
  Logger.log(out.join('\n'));
  return out;
}

/** The lines of the report: the state of the timer and key, then a decision for each recent email. */
function receiptMailReport_() {
  const out = [];
  out.push('Timer on: ' + (receiptMailOn_() ? 'yes' : 'NO (run setupReceiptEmail once)'));
  out.push('Timer last ran: ' + (props_().getProperty('RECEIPT_MAIL_LAST') || 'never'));
  out.push('Gemini key set: ' + (geminiKey_() ? 'yes' : 'NO'));
  out.push('App mailbox: ' + receiptMailbox_());
  const maps2 = receiptCarMaps_();
  const carsBySecret = maps2.carsBySecret;
  const carsByReg = maps2.carsByReg;
  const usersByEmail = {};
  Db.all('Users').forEach(function (u) { if (!isTrue_(u.deleted) && u.status === 'Approved') usersByEmail[String(u.email).toLowerCase()] = u; });
  const threads = GmailApp.search('in:inbox newer_than:7d', 0, 10);
  out.push('Emails in the inbox from the last 7 days (newest 10 threads): ' + threads.length);
  threads.forEach(function (t) {
    const labelled = t.getLabels().some(function (l) { return l.getName() === RECEIPT_LABEL; });
    t.getMessages().forEach(function (m) {
      const v = receiptClassify_(m, carsBySecret, carsByReg, usersByEmail);
      const stored = Db.all('Inbox').some(function (r) { return r.email_id === String(m.getId()); });
      out.push('- ' + Utilities.formatDate(m.getDate(), TZ, 'yyyy-MM-dd HH:mm') + ' from ' + (senderEmail_(m.getFrom()) || '?') + ' to-tag "' + receiptTagOf_(m) + '": ' +
        (stored ? 'already in the Inbox' : v.skip ? 'IGNORED: ' + v.skip : 'would be accepted' + (v.car ? ' for ' + v.car.registration : ' (no car)')) + (labelled ? ' [labelled Fleet-handled]' : ' [not yet handled]'));
    });
  });
  return out;
}

// ---------- for the Diagnostics page (admins) ----------

/** How the receipt features are doing: the timer, the reading allowance, the Inbox, and the latest receipts. */
function getReceiptHealth_(p, ctx) {
  const props = props_();
  const rows = Db.all('Inbox').filter(function (r) { return !isTrue_(r.deleted); });
  const counts = { New: 0, Queued: 0, Pending: 0, Unreadable: 0, Approved: 0, Dismissed: 0 };
  rows.forEach(function (r) { if (counts[r.status] !== undefined) counts[r.status]++; });
  const open = rows.filter(function (r) { return RECEIPT_OPEN.indexOf(r.status) !== -1; }).sort(function (a, b) { return String(a.received_at).localeCompare(String(b.received_at)); });
  const recent = rows.slice().sort(function (a, b) { return String(b.received_at).localeCompare(String(a.received_at)); }).slice(0, 12).map(function (r) {
    const s = receiptShape_(r);
    return { id: s.id, status: s.status, source: s.source, vendor: s.vendor, total: s.total, currency: s.currency, car: s.car, receivedAt: s.receivedAt, sender: s.sender, subject: s.subject,
      note: s.note, attempts: Number(r.attempts || 0), retryAfter: r.status === 'Queued' ? r.retry_after : '' };
  });
  let quota = null;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (e) { quota = null; }
  return {
    now: nowIso_(),
    mail: {
      timerOn: receiptMailOn_(), timers: receiptTimerList_(), timerMade: props.getProperty('RECEIPT_MAIL_TIMER_MADE') || '', lastRun: props.getProperty('RECEIPT_MAIL_LAST') || '', lastResult: props.getProperty('RECEIPT_MAIL_RESULT') || '', mailbox: receiptMailbox_(),
    },
    reading: {
      keyOn: !!geminiKey_(), model: geminiModel_(), lastError: props.getProperty('GEMINI_LAST_ERROR') || '', usedToday: aiUsed_('rc_app'), appLimit: receiptLimit_('RECEIPT_APP_DAILY', RECEIPT_APP_DAILY), userLimit: receiptLimit_('RECEIPT_USER_DAILY', RECEIPT_USER_DAILY),
    },
    emails: { adminNoticesToday: aiUsed_('rc_mail'), confirmationsToday: aiUsed_('rc_ack'), dailyLimit: RECEIPT_MAIL_DAILY, quotaLeft: quota },
    inbox: { counts: counts, oldestOpen: open.length ? open[0].received_at : '', openTotal: open.length },
    recent: recent,
  };
}

/** What the app decides for each recent email in the app's Gmail (senders and tags only, never contents). */
function inspectReceiptMail_(p, ctx) {
  return { lines: receiptMailReport_() };
}

/** Do the timer's work now instead of waiting for it (an admin pressing a button). */
function processReceiptsNow_(p, ctx) {
  const r = processReceiptEmails();
  return { read: r.read, lastResult: props_().getProperty('RECEIPT_MAIL_RESULT') || '' };
}
