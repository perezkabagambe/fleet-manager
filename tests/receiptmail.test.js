'use strict';
// Receipts that arrive by email (Gmail mocked): per-car addresses, what is accepted, what is sent to Gemini.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { createEnv } = require('./harness');

const CAR = { registration: 'AB12 CDE', make: 'Toyota', model: 'Hilux', year: '2015', odometer: '50000' };
const PARTS = { documentType: 'parts_receipt', vendor: 'Euro Car Parts', date: '2026-10-02', currency: 'GBP', orderNumber: 'ECP-1', total: 20, items: [{ name: 'Oil filter', quantity: 2, unitPrice: 10 }], confidence: 'high' };
const answer = (obj) => ({ code: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } });
const pdfBytes = () => { const b = Buffer.alloc(60, 32); Buffer.from('%PDF-1.4\n').copy(b); return Array.from(b).map((x) => (x > 127 ? x - 256 : x)); };
const jpgBytes = (n) => { const b = Buffer.alloc(n || 20000, 5); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return Array.from(b).map((x) => (x > 127 ? x - 256 : x)); };

let counter = 0;
function mail(opts) {
  const id = opts.id || 'msg-' + (++counter);
  return {
    getId: () => id, getFrom: () => opts.from || 'Shop <orders@shop.example>', getTo: () => opts.to || '', getCc: () => opts.cc || '',
    getSubject: () => opts.subject || 'Your order', getPlainBody: () => opts.body || 'Order ECP-1. 2 x Oil filter 10.00. Questions? help@shop.example',
    getDate: () => new Date('2026-11-21T18:00:00Z'), getBody: () => opts.html || '<p>Your order</p>', getRawContent: () => opts.raw || '',
    getAttachments: (o) => (opts.attachments || []).filter((a) => !a.inline || (o && o.includeInlineImages)).map((a) => ({ getContentType: () => a.type, getName: () => a.name, getBytes: () => a.bytes })),
  };
}
function thread(messages) {
  const t = { labels: [], getLabels: () => t.labels.map((n) => ({ getName: () => n })), getMessages: () => messages, addLabel: (l) => { t.labels.push(l.name); } };
  return t;
}

function setup() {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  env.props.GEMINI_API_KEY = 'key';
  env.state.gemini = () => answer(PARTS);
  const car = env.call('saveCar', { token: sam, fields: CAR }).data.car;
  const address = () => env.call('getReceiptAddress', { token: sam, carId: car.id }).data.privateAddress;
  const run = () => JSON.parse(JSON.stringify(vm.runInContext('processReceiptEmails()', env.ctx)));
  const inbox = () => env.call('listInbox', { token: sam }).data.open;
  return { env, admin, sam, car, address, run, inbox };
}

test('each car has a private plus-address of the app mailbox; it is stable, and only an admin can replace it', () => {
  const { env, admin, sam, car, address } = setup();
  assert.equal(env.call('getReceiptAddress', { carId: car.id }).error, 'unauthorized');
  const a = address();
  assert.match(a, /^potentiafleetmanager\+[a-f0-9]{12}@gmail\.com$/);
  assert.equal(env.call('getReceiptAddress', { token: sam, carId: car.id }).data.address, 'potentiafleetmanager+ab12cde@gmail.com'); // the easy one: the registration without spaces
  assert.equal(address(), a);
  assert.equal(env.call('replaceReceiptSecret', { token: sam, carId: car.id }).error, 'forbidden');
  const b = env.call('replaceReceiptSecret', { token: admin, carId: car.id }).data.privateAddress;
  assert.notEqual(b, a);
  assert.equal(address(), b);
  env.props.RECEIPT_MAILBOX = 'Fleets@Example.org';
  assert.match(address(), /^fleets\+[a-f0-9]{12}@example\.org$/);
  assert.equal(env.call('getReceiptAddress', { token: sam, carId: car.id }).data.address, 'fleets+ab12cde@example.org');
  assert.equal(env.call('getReceiptAddress', { token: sam, carId: 'nope' }).error, 'not_found');
});

test('mail to a car\'s address becomes a Pending receipt for that car; only the receipt goes to Gemini', () => {
  const { env, car, address, run, inbox } = setup();
  const to = address();
  env.state.gmail = [thread([mail({ to: 'Fleet <' + to + '>', from: 'Euro Car Parts <orders@ecp.example>', attachments: [{ type: 'application/pdf', name: 'invoice.pdf', bytes: pdfBytes() }] })])];
  assert.deepEqual(run(), { read: 1 });
  const [r] = inbox();
  assert.equal(r.status, 'Pending');
  assert.equal(r.source, 'email');
  assert.equal(r.carId, car.id);
  assert.equal(r.filename, 'invoice.pdf');
  assert.equal(r.subject, 'Your order');
  assert.equal(r.sender, 'orders@ecp.example');
  const sent = JSON.stringify(env.state.geminiRequests[0].body);
  assert.equal(env.state.geminiRequests.length, 1);
  assert.equal(sent.includes('ecp.example'), false);      // the sender is never sent
  assert.equal(sent.includes('shop.example'), false);     // nor any email address in the text
  assert.equal(sent.includes('[email]'), true);
  assert.equal(sent.includes('Oil filter'), true);
  assert.equal(sent.includes(to), false);                 // nor the secret address
  assert.equal(env.state.gmail[0].labels.includes('Fleet-handled'), true);
  assert.ok(env.outbox.some((m) => /waiting for review/.test(m.subject) && m.to === 'admin@example.com'));
  // run again: the handled thread is not looked at again
  assert.deepEqual(run(), { read: 0 });
  assert.equal(inbox().length, 1);
});

test('an email with no attachment is kept as a PDF of the email; a photo attachment is kept as it is', () => {
  const { env, address, run, inbox } = setup();
  const to = address();
  env.ctx.Utilities.newBlob = ((orig) => (bytes, mime, name) => {
    const b = orig(bytes, mime, name);
    b.getAs = () => ({ getBytes: () => pdfBytes() });
    return b;
  })(env.ctx.Utilities.newBlob);
  env.state.gmail = [
    thread([mail({ to, html: '<p>Receipt body</p>' })]),
    thread([mail({ to, attachments: [{ type: 'image/png', name: 'logo.png', bytes: jpgBytes(3000) }, { type: 'image/jpeg', name: 'scan.jpg', bytes: jpgBytes() }] })]),
  ];
  run();
  const byName = Object.fromEntries(inbox().map((r) => [r.filename, r]));
  assert.equal(byName['receipt-email.pdf'].mime, 'application/pdf');
  assert.equal(byName['scan.jpg'].mime, 'image/jpeg');
  assert.equal(env.state.geminiRequests.length, 2);
});

test('mail that is not for a receipt address and not from an approved user is ignored and never read', () => {
  const { env, address, run, inbox } = setup();
  address();
  env.state.gmail = [
    thread([mail({ to: 'potentiafleetmanager@gmail.com', from: 'spam@junk.example' })]),
    thread([mail({ to: 'potentiafleetmanager+000000000000@gmail.com', from: 'spam@junk.example' })]), // a guessed secret
    thread([mail({ to: 'x@y.example', from: 'Gmail Team <forwarding-noreply@google.com>' })]),
  ];
  assert.deepEqual(run(), { read: 0 });
  assert.equal(inbox().length, 0);
  assert.equal(env.state.geminiRequests.length, 0);
  assert.ok(env.state.gmail.every((t) => t.labels.includes('Fleet-handled'))); // not looked at again
});

test('an approved user can forward to the plain address: it is accepted with no car, showing their name', () => {
  const { env, run, inbox } = setup();
  env.state.gmail = [thread([mail({ to: 'potentiafleetmanager@gmail.com', from: 'Sam <sam@example.com>', attachments: [{ type: 'application/pdf', name: 'r.pdf', bytes: pdfBytes() }] })])];
  run();
  const [r] = inbox();
  assert.equal(r.carId, '');
  assert.equal(r.sender, 'Sam');
});

test('the secret is also found in the delivery headers (a hidden copy or a forward)', () => {
  const { env, car, address, run, inbox } = setup();
  const to = address();
  env.state.gmail = [thread([mail({ to: 'undisclosed-recipients:;', raw: 'Received: x\nDelivered-To: ' + to + '\nSubject: hi\n\nbody' })])];
  run();
  assert.equal(inbox()[0].carId, car.id);
});

test('an old secret stops working once it has been replaced', () => {
  const { env, admin, car, address, run, inbox } = setup();
  const old = address();
  env.call('replaceReceiptSecret', { token: admin, carId: car.id });
  env.state.gmail = [thread([mail({ to: old })])];
  run();
  assert.equal(inbox().length, 0);
});

test('the same email is never added twice, and each run reads at most five', () => {
  const { env, address, run, inbox } = setup();
  const to = address();
  env.state.gmail = [thread([mail({ to, id: 'same' })])];
  run();
  env.state.gmail[0].labels = []; // as if the label were lost
  assert.deepEqual(run(), { read: 0 });
  assert.equal(inbox().length, 1);
  env.state.gmail = [];
  for (let i = 0; i < 8; i++) env.state.gmail.push(thread([mail({ to, id: 'm' + i, body: 'order ' + i })]));
  assert.deepEqual(run(), { read: 5 });
  assert.equal(env.state.gmail.filter((t) => t.labels.length).length, 5);
  assert.deepEqual(run(), { read: 3 });
  assert.equal(inbox().length, 9);
});

test('without a Gemini key, emailed receipts are still stored for filling in by hand', () => {
  const { env, address, run, inbox } = setup();
  delete env.props.GEMINI_API_KEY;
  env.state.gmail = [thread([mail({ to: address() })])];
  run();
  assert.equal(inbox()[0].status, 'Unreadable');
  assert.equal(env.state.geminiRequests.length, 0);
});

test('setupReceiptEmail makes the label and the 5-minute timer once', () => {
  const { env } = setup();
  vm.runInContext('setupReceiptEmail()', env.ctx);
  vm.runInContext('setupReceiptEmail()', env.ctx);
  assert.ok(env.state.gmailLabels['Fleet-handled']);
  assert.equal(env.triggers.filter((t) => t.fn === 'processReceiptEmails').length, 1);
});

test('the registration address only works for mail from an approved user', () => {
  const { env, car, run, inbox } = setup();
  const reg = 'potentiafleetmanager+ab12cde@gmail.com';
  env.state.gmail = [
    thread([mail({ to: reg, from: 'Stranger <who@junk.example>' })]),
    thread([mail({ to: reg, from: 'Sam <sam@example.com>', attachments: [{ type: 'application/pdf', name: 'r.pdf', bytes: pdfBytes() }] })]),
  ];
  assert.deepEqual(run(), { read: 1 });
  assert.equal(inbox().length, 1);
  assert.equal(inbox()[0].carId, car.id);
  assert.equal(inbox()[0].sender, 'Sam');
  assert.equal(env.state.geminiRequests.length, 1);
});

test('two cars with the same registration make the registration address ambiguous: no car is guessed', () => {
  const { env, sam, run, inbox } = setup();
  env.call('saveCar', { token: sam, fields: Object.assign({}, CAR, { registration: 'ab12 cde' }), force: true });
  env.state.gmail = [thread([mail({ to: 'potentiafleetmanager+ab12cde@gmail.com', from: 'sam@example.com' })])];
  run();
  assert.equal(inbox()[0].carId, '');
});

test('the approved user who emailed a receipt is told it arrived and is waiting for approval; strangers are not', () => {
  const { env, address, run } = setup();
  const to = address();
  env.state.gmail = [
    thread([mail({ to, from: 'Sam <sam@example.com>', attachments: [{ type: 'application/pdf', name: 'r.pdf', bytes: pdfBytes() }] })]),
    thread([mail({ to, from: 'Shop <orders@shop.example>' })]),
  ];
  env.outbox.length = 0;
  run();
  const acks = env.outbox.filter((m) => /waiting for approval/.test(m.subject));
  assert.equal(acks.length, 1);
  assert.equal(acks[0].to, 'sam@example.com');
  assert.match(acks[0].body, /Euro Car Parts/);
  assert.match(acks[0].body, /#\/inbox/);
  // the admin is told about both receipts; the stranger got nothing back
  assert.equal(env.outbox.filter((m) => /waiting for review/.test(m.subject) && m.to === 'admin@example.com').length, 2);
  assert.equal(env.outbox.some((m) => /shop\.example/.test(m.to)), false);
});

test('an admin who emails a receipt gets the confirmation, not the admin notice as well', () => {
  const { env, run } = setup();
  env.state.gmail = [thread([mail({ to: 'potentiafleetmanager@gmail.com', from: 'admin@example.com' })])];
  env.outbox.length = 0;
  run();
  assert.equal(env.outbox.filter((m) => m.to === 'admin@example.com' && /waiting for approval/.test(m.subject)).length, 1);
  assert.equal(env.outbox.filter((m) => m.to === 'admin@example.com' && /waiting for review/.test(m.subject)).length, 0);
});

test('when the daily limit is used up the sender is told once, and the receipt is read and confirmed the next day', () => {
  const { env, address, run, inbox } = setup();
  const to = address();
  env.props.RECEIPT_APP_DAILY = '1';
  env.state.gmail = [
    thread([mail({ to, from: 'Sam <sam@example.com>', id: 'a', body: 'first' })]),
    thread([mail({ to, from: 'Sam <sam@example.com>', id: 'b', body: 'second Oil filter' })]),
  ];
  env.outbox.length = 0;
  run();
  const subjects = () => env.outbox.map((m) => m.to + ': ' + m.subject);
  assert.equal(env.outbox.filter((m) => m.to === 'sam@example.com' && /read tomorrow/.test(m.subject)).length, 1);
  assert.equal(inbox().filter((r) => r.status === 'Queued').length, 1);
  assert.equal(inbox().filter((r) => r.status === 'Pending').length, 1);
  // five minutes later, and again: no second notice, no new reading, the admin is not told about a receipt that has not been read
  env.advance(5 * 60000); run(); env.advance(5 * 60000); run();
  assert.equal(env.outbox.filter((m) => /read tomorrow/.test(m.subject)).length, 1);
  assert.equal(env.state.geminiRequests.length, 1);
  assert.equal(env.outbox.filter((m) => /waiting for review/.test(m.subject)).length, 1);
  // the next day: it is read, the sender is told it is waiting for approval, and the admin is told too
  env.advance(26 * 3600 * 1000);
  run();
  assert.equal(inbox().filter((r) => r.status === 'Pending').length, 2);
  assert.equal(env.state.geminiRequests.length, 2);
  assert.equal(env.outbox.filter((m) => m.to === 'sam@example.com' && /waiting for approval/.test(m.subject)).length, 2);
  assert.equal(env.outbox.filter((m) => /waiting for review/.test(m.subject)).length, 2);
  assert.equal(env.outbox.filter((m) => /read tomorrow/.test(m.subject)).length, 1, subjects().join('\n'));
  // the queued receipt kept its email text for the reading
  assert.equal(JSON.stringify(env.state.geminiRequests[1].body).includes('second Oil filter'), true);
});

test('a busy Gemini is retried after 15 minutes; after three busy answers the sender is told once and it waits longer', () => {
  const { env, address, run, inbox } = setup();
  env.state.gemini = () => ({ code: 429, body: {} });
  env.state.gmail = [thread([mail({ to: address(), from: 'sam@example.com' })])];
  env.outbox.length = 0;
  run();
  assert.equal(inbox()[0].status, 'Queued');
  assert.equal(env.outbox.filter((m) => /read tomorrow/.test(m.subject)).length, 0); // not yet: it will be tried again shortly
  env.advance(16 * 60000); run();
  assert.equal(env.state.geminiRequests.length, 2);
  env.advance(16 * 60000); run();
  assert.equal(env.state.geminiRequests.length, 3);
  assert.equal(env.outbox.filter((m) => /read tomorrow/.test(m.subject)).length, 1);
  env.advance(16 * 60000); run(); // now it waits hours, not minutes
  assert.equal(env.state.geminiRequests.length, 3);
  env.state.gemini = () => answer(PARTS);
  env.advance(7 * 3600 * 1000); run();
  assert.equal(inbox()[0].status, 'Pending');
  assert.equal(env.outbox.filter((m) => m.to === 'sam@example.com' && /waiting for approval/.test(m.subject)).length, 1);
});

test('checkReceiptEmail explains what was decided for each recent email, without showing contents', () => {
  const { env, address, run } = setup();
  const to = address();
  env.state.gmail = [
    thread([mail({ to: 'potentiafleetmanager+ab12cde@gmail.com', from: 'Stranger <who@junk.example>', body: 'SECRET BODY TEXT' })]),
    thread([mail({ to, from: 'Shop <orders@shop.example>' })]),
    thread([mail({ to: 'potentiafleetmanager+ab12cde@gmail.com', from: 'sam@example.com' })]),
  ];
  const lines = vm.runInContext('checkReceiptEmail()', env.ctx).join('\n');
  assert.match(lines, /Timer on: NO/);
  assert.match(lines, /Timer last ran: never/);
  assert.match(lines, /IGNORED: sent to the registration address by someone who is not an approved user \(who@junk\.example\)/);
  assert.match(lines, /would be accepted for AB12 CDE/);
  assert.equal(lines.includes('SECRET BODY TEXT'), false);
  run();
  const after = vm.runInContext('checkReceiptEmail()', env.ctx).join('\n');
  assert.equal(/Timer last ran: never/.test(after), false);
  assert.match(after, /already in the Inbox/);
});

test('the Diagnostics actions are for admins, and report the timer, the allowance and the Inbox', () => {
  const { env, admin, sam, address, run } = setup();
  assert.equal(env.call('getReceiptHealth', { token: sam }).error, 'forbidden');
  assert.equal(env.call('inspectReceiptMail', { token: sam }).error, 'forbidden');
  assert.equal(env.call('processReceiptsNow', { token: sam }).error, 'forbidden');
  const before = env.call('getReceiptHealth', { token: admin }).data;
  assert.equal(before.mail.timerOn, false);
  assert.equal(before.mail.lastRun, '');
  assert.equal(before.reading.keyOn, true);
  assert.equal(before.reading.usedToday, 0);
  assert.equal(before.inbox.openTotal, 0);
  vm.runInContext('setupReceiptEmail()', env.ctx);
  env.state.gmail = [thread([mail({ to: address(), from: 'sam@example.com' })])];
  const now = env.call('processReceiptsNow', { token: admin }).data;
  assert.equal(now.read, 1);
  assert.match(now.lastResult, /^ok: 1 new thread/);
  const after = env.call('getReceiptHealth', { token: admin }).data;
  assert.equal(after.mail.timerOn, true);
  assert.notEqual(after.mail.lastRun, '');
  assert.equal(after.reading.usedToday, 1);
  assert.equal(after.inbox.counts.Pending, 1);
  assert.equal(after.recent.length, 1);
  assert.equal(after.recent[0].source, 'email');
  assert.equal(after.emails.confirmationsToday, 1);
  assert.equal(after.emails.adminNoticesToday, 1);
  assert.match(env.call('inspectReceiptMail', { token: admin }).data.lines.join('\n'), /already in the Inbox/);
});

test('a failure in the timer is recorded where the Diagnostics page can show it', () => {
  const { env } = setup();
  env.ctx.GmailApp.search = () => { throw new Error('Gmail is unavailable'); };
  assert.throws(() => vm.runInContext('processReceiptEmails()', env.ctx));
  assert.match(env.props.RECEIPT_MAIL_RESULT, /^error: Gmail is unavailable/);
});

test('a photo pasted into the email body (as a phone does) is found, and is not limited to 1.5 MB', () => {
  const { env, address, run, inbox } = setup();
  env.state.gmail = [thread([mail({ to: address(), html: '<img src="cid:x">', attachments: [
    { type: 'image/jpeg', name: 'IMG_0001.jpeg', bytes: jpgBytes(4000000), inline: true },   // the receipt: 4 MB, inline
    { type: 'image/png', name: 'logo.png', bytes: jpgBytes(3000), inline: true },            // a logo: too small to be a receipt
  ] })])];
  run();
  const [r] = inbox();
  assert.equal(r.mime, 'image/jpeg');
  assert.equal(r.filename, 'IMG_0001.jpeg');
  assert.equal(r.size, 4000000);
  assert.equal(r.status, 'Pending');
  assert.equal(env.state.geminiRequests[0].body.contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
});

test('the biggest picture wins; a PDF beats a picture; a vague type is read from the file name; too-big files are skipped', () => {
  const { env, address, run, inbox } = setup();
  const to = address();
  env.state.gmail = [
    thread([mail({ to, id: 'p1', attachments: [{ type: 'image/jpeg', name: 'small.jpg', bytes: jpgBytes(20000) }, { type: 'image/jpeg', name: 'big.jpg', bytes: jpgBytes(90000) }] })]),
    thread([mail({ to, id: 'p2', attachments: [{ type: 'image/jpeg', name: 'photo.jpg', bytes: jpgBytes(90000) }, { type: 'application/pdf', name: 'inv.pdf', bytes: pdfBytes() }] })]),
    thread([mail({ to, id: 'p3', attachments: [{ type: 'application/octet-stream', name: 'scan.HEIC', bytes: jpgBytes(90000) }] })]),
    thread([mail({ to, id: 'p4', html: '<p>x</p>', attachments: [{ type: 'image/jpeg', name: 'huge.jpg', bytes: jpgBytes(10000001) }] })]),
  ];
  run();
  const names = inbox().map((r) => r.filename + ':' + r.mime).sort();
  assert.deepEqual(names, ['big.jpg:image/jpeg', 'inv.pdf:application/pdf', 'receipt-email.txt:application/octet-stream', 'scan.HEIC:image/heic'].sort());
});

test('a PNG receipt is read as a PNG and attached as an ordinary file when approved', () => {
  const { env, sam, car, address, run, inbox } = setup();
  const png = Array.from(Buffer.alloc(30000, 7)).map((x) => x);
  env.state.gmail = [thread([mail({ to: address(), attachments: [{ type: 'image/png', name: 'shot.png', bytes: png }] })])];
  run();
  const [r] = inbox();
  assert.equal(r.mime, 'image/png');
  assert.equal(env.state.geminiRequests[0].body.contents[0].parts[1].inline_data.mime_type, 'image/png');
  const entry = env.call('saveEntry', { token: sam, carId: car.id, type: 'Purchase', fields: { date: '2026-10-03' }, items: [{ name: 'Bulb', quantity: '1', unitCost: '3' }] }).data.entry;
  env.call('resolveReceipt', { token: sam, id: r.id, entryId: entry.id });
  const att = env.call('getEntry', { token: sam, id: entry.id }).data.attachments[0];
  assert.equal(att.mime, 'application/octet-stream');
  assert.equal(att.filename, 'shot.png');
});

test('an admin can re-create the receipt timer; it ends up as exactly one, and Diagnostics lists the timers', () => {
  const { env, admin, sam } = setup();
  assert.equal(env.call('resetReceiptTimer', { token: sam }).error, 'forbidden');
  vm.runInContext('setupReceiptEmail()', env.ctx);
  vm.runInContext('ensureTrigger_("flushTextLog", 10)', env.ctx);
  env.triggers.push({ fn: 'processReceiptEmails' }); // a stray duplicate
  const r = env.call('resetReceiptTimer', { token: admin }).data;
  assert.equal(JSON.stringify(r.timers.filter((t) => t.handler === 'processReceiptEmails')), JSON.stringify([{ handler: 'processReceiptEmails', count: 1 }]));
  assert.ok(r.timers.some((t) => t.handler === 'flushTextLog')); // other timers are left alone
  const h = env.call('getReceiptHealth', { token: admin }).data;
  assert.notEqual(h.mail.timerMade, '');
  assert.equal(h.mail.timerOn, true);
});
