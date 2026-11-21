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
const RECEIPT_SECRET_RE = /\+([a-z0-9]{8,32})@/i;

// ---------- each car's address ----------

function receiptMailbox_() {
  const set = String(props_().getProperty('RECEIPT_MAILBOX') || '').trim().toLowerCase();
  return normEmail_(set) || appEmail_();
}

function newReceiptSecret_() { return randomToken_().slice(0, 12); }

function receiptAddress_(secret) {
  const parts = receiptMailbox_().split('@');
  return parts[0].split('+')[0] + '+' + secret + '@' + parts[1];
}

/** The car's receipt address. Made on first use (so this action holds the script lock). */
function getReceiptAddress_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  let secret = car.receipt_secret;
  if (!secret) {
    secret = newReceiptSecret_();
    Db.update('Cars', car._row, touch_(car, ctx, { receipt_secret: secret }));
  }
  return { address: receiptAddress_(secret), emailOn: receiptMailOn_() };
}

/** Admin only: a new address for the car. The old one stops working at once (use it if the address has been shared too widely). */
function replaceReceiptSecret_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const secret = newReceiptSecret_();
  Db.update('Cars', car._row, touch_(car, ctx, { receipt_secret: secret }));
  audit_(ctx.user, 'receipt_address_replaced', 'Car', car.id, 'New receipt email address for ' + car.registration);
  return { address: receiptAddress_(secret), emailOn: receiptMailOn_() };
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

/** The secret in the address the mail was sent to, or ''. */
function receiptSecretOf_(message) {
  let m = RECEIPT_SECRET_RE.exec(String(message.getTo() || '') + ' ' + String(message.getCc() || ''));
  if (!m) { // sent as a hidden copy or through a forward: the delivery headers still say where it was delivered
    let raw = '';
    try { raw = String(message.getRawContent() || '').slice(0, 8000); } catch (e) { raw = ''; }
    const header = /^(?:Delivered-To|X-Original-To):.*$/gim;
    let h;
    while (!m && (h = header.exec(raw))) m = RECEIPT_SECRET_RE.exec(h[0]);
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
function handleReceiptMessage_(message, carsBySecret, usersByEmail) {
  const emailId = String(message.getId() || '');
  if (!emailId) return 'skipped';
  const from = senderEmail_(message.getFrom());
  if (!from || from === appEmail_() || /^forwarding-noreply@google\.com$/.test(from)) return 'skipped'; // our own mail, and Gmail's forwarding set-up message
  const car = carsBySecret[receiptSecretOf_(message)] || null;
  const user = usersByEmail[from] || null;
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
  readStoredReceipt_(row, '', receiptEmailText_(message), '');
  return 'read';
}

/** The timer: read new mail sent to a car's receipt address. Runs every 5 minutes (see setupReceiptEmail). */
function processReceiptEmails() {
  const threads = GmailApp.search(RECEIPT_MAIL_QUERY, 0, RECEIPT_MAIL_THREADS);
  if (!threads.length) return { read: 0 };
  Db.resetRequest();
  const carsBySecret = {};
  Db.all('Cars').forEach(function (c) { if (!isTrue_(c.deleted) && c.receipt_secret) carsBySecret[String(c.receipt_secret).toLowerCase()] = c; });
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
        outcome = handleReceiptMessage_(messages[i], carsBySecret, usersByEmail);
      } catch (e) {
        console.error('receipt email failed: ' + (e && e.stack ? e.stack : JSON.stringify(e)));
      }
      if (outcome === 'read') reads++;
    }
    if (finished) threads[t].addLabel(label); // handled (or ignored): not looked at again
  }
  return { read: reads };
}
