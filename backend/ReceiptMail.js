/**
 * Receipts that arrive by email.
 *
 * Every car has its own private receipt address: the app's Gmail address with "+" and a secret added, for example
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
const RECEIPT_TAG_RE = /\+([a-z0-9]{2,32})@/i;

// ---------- each car's address ----------

function receiptMailbox_() {
  const set = String(props_().getProperty('RECEIPT_MAILBOX') || '').trim().toLowerCase();
  return normEmail_(set) || appEmail_();
}

function newReceiptSecret_() { return randomToken_().slice(0, 12); }

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
 * user (a number plate is public, so anyone could guess it). The private one has a secret in it and works for anyone,
 * so it suits shops and automatic forwarding rules.
 */
function receiptAddresses_(car, secret) {
  const tag = regTag_(car.registration);
  return { address: tag.length >= 2 ? receiptAddress_(tag) : '', privateAddress: receiptAddress_(secret), emailOn: receiptMailOn_() };
}

/** The car's receipt addresses. The private one is made on first use (so this action holds the script lock). */
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

/** Admin only: a new private address for the car. The old one stops working at once (use it if the address has been shared too widely). */
function replaceReceiptSecret_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const secret = newReceiptSecret_();
  Db.update('Cars', car._row, touch_(car, ctx, { receipt_secret: secret }));
  audit_(ctx.user, 'receipt_address_replaced', 'Car', car.id, 'New receipt email address for ' + car.registration);
  return receiptAddresses_(car, secret);
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

/** The file to keep as the receipt: the first PDF or photo attached, otherwise the email itself as a PDF (or, failing that, plain text). */
function receiptEmailFile_(message) {
  let pdf = null;
  let jpg = null;
  let attachments = [];
  try { attachments = message.getAttachments({ includeInlineImages: false, includeAttachments: true }) || []; } catch (e) { attachments = []; }
  attachments.forEach(function (a) {
    const mime = String(a.getContentType() || '').toLowerCase();
    let bytes;
    try { bytes = a.getBytes(); } catch (e) { return; }
    if (mime === 'application/pdf' && !pdf && bytes.length <= MAX_ATTACH_FILE && isPdf_(bytes)) pdf = { bytes: bytes, mime: mime, name: a.getName() };
    else if (mime === 'image/jpeg' && !jpg && bytes.length <= MAX_ATTACH_JPEG && bytes.length > 4 && (bytes[0] & 0xff) === 0xff && (bytes[1] & 0xff) === 0xd8) jpg = { bytes: bytes, mime: mime, name: a.getName() };
  });
  const chosen = pdf || jpg;
  if (chosen) return { bytes: chosen.bytes, mime: chosen.mime, filename: safeFilename_(chosen.name || 'receipt', chosen.mime) };
  try {
    const blob = Utilities.newBlob('<html><body>' + String(message.getBody() || '') + '</body></html>', 'text/html', 'receipt.html').getAs('application/pdf');
    const bytes = blob.getBytes();
    if (isPdf_(bytes) && bytes.length <= MAX_ATTACH_FILE) return { bytes: bytes, mime: 'application/pdf', filename: 'receipt-email.pdf' };
  } catch (e) { /* the email could not be turned into a PDF: keep its text instead */ }
  return { bytes: Utilities.newBlob(receiptEmailText_(message), 'text/plain', 'receipt-email.txt').getBytes(), mime: GENERIC_MIME, filename: 'receipt-email.txt' };
}

/** Store one email as an Inbox receipt and read it. Returns 'read' or 'skipped'. */
function handleReceiptMessage_(message, carsBySecret, carsByReg, usersByEmail) {
  const emailId = String(message.getId() || '');
  if (!emailId) return 'skipped';
  const from = senderEmail_(message.getFrom());
  if (!from || from === appEmail_() || /^forwarding-noreply@google\.com$/.test(from)) return 'skipped'; // our own mail, and Gmail's forwarding set-up message
  const tag = receiptTagOf_(message);
  const user = usersByEmail[from] || null;
  // the private address works for anyone; the registration address only for an approved user's mail
  const car = carsBySecret[tag] || (user ? carsByReg[tag] : null) || null;
  if (!car && !user) return 'skipped'; // not a receipt address and not someone we know: never read, never sent anywhere
  const seen = Db.all('Inbox').some(function (r) { return r.email_id === emailId; });
  if (seen) return 'skipped';
  if (Db.all('Inbox').filter(function (r) { return !isTrue_(r.deleted) && RECEIPT_OPEN.indexOf(r.status) !== -1; }).length >= RECEIPT_INBOX_MAX) return 'skipped';

  const file = receiptEmailFile_(message);
  const row = withScriptLock_(function () {
    return storeReceipt_({
      source: 'email', car_id: car ? car.id : '', sender: user ? user.name : from, subject: cleanStr_(message.getSubject(), 120), email_id: emailId,
    }, file.bytes, file.mime, file.filename, null);
  });
  audit_(null, 'receipt_emailed', 'Inbox', row.id, 'Receipt "' + file.filename + '" arrived by email' + (car ? ' for ' + car.registration : ''));
  const done = readStoredReceipt_(row, '', receiptEmailText_(message), user ? user.id : ''); // an admin who sent it gets the confirmation below instead of the admin notice
  if (user) notifyReceiptSender_(done, user);
  return 'read';
}

/** Tell an approved user who emailed a receipt that it arrived and is waiting for review. (Strangers who use the private address get no reply.) */
function notifyReceiptSender_(row, user) {
  if (!dailyCap_('rc_ack', RECEIPT_MAIL_DAILY)) return;
  const read = row.status === 'Pending';
  const what = read
    ? 'We received your receipt' + (row.vendor ? ' from ' + row.vendor : '') + (row.total !== '' ? ' (' + (row.currency ? row.currency + ' ' : '') + row.total + ')' : '') + ' and it has been read.'
    : 'We received your receipt, but it could not be read automatically, so it needs to be filled in by hand.';
  const url = SITE_URL + '#/inbox';
  const html = layout_('Your receipt is waiting for approval',
    '<p>Hi ' + esc_(user.name) + ',</p>' +
    '<p>' + esc_(what) + ' It is now in the Inbox in Fleet Manager, waiting for someone to check it and add it to the vehicle\'s log. Nothing has been added yet.</p>' +
    button_(url, 'Open the Inbox'));
  const text = 'Hi ' + user.name + ',\n\n' + what + ' It is now in the Inbox in Fleet Manager, waiting for someone to check it and add it to the vehicle\'s log. Nothing has been added yet.\n' + url;
  sendMail_(user.email, 'Your receipt is waiting for approval', html, text);
}

/** The timer: read new mail sent to a car's receipt address. Runs every 5 minutes (see setupReceiptEmail). */
function processReceiptEmails() {
  const threads = GmailApp.search(RECEIPT_MAIL_QUERY, 0, RECEIPT_MAIL_THREADS);
  if (!threads.length) return { read: 0 };
  Db.resetRequest();
  const carsBySecret = {};
  const carsByReg = {}; // a registration shared by two cars is ambiguous, so it points to neither
  Db.all('Cars').forEach(function (c) {
    if (isTrue_(c.deleted)) return;
    if (c.receipt_secret) carsBySecret[String(c.receipt_secret).toLowerCase()] = c;
    const t = regTag_(c.registration);
    if (t.length >= 2) carsByReg[t] = Object.prototype.hasOwnProperty.call(carsByReg, t) ? null : c;
  });
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
  return { read: reads };
}
