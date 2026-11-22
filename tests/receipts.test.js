'use strict';
// Receipts waiting for review: add a photo/PDF, have Gemini (mocked) read it, review it, approve or dismiss.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { createEnv } = require('./harness');
const tokens = new WeakMap();
const setupToken = (env) => tokens.get(env);

const CAR = { registration: 'AB12 CDE', make: 'Toyota', model: 'Hilux', year: '2015', odometer: '50000' };
const jpeg = (n) => { const b = Buffer.alloc(n || 50, 5); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0; return b.toString('base64'); };
const pdf = (n) => { const b = Buffer.alloc(n || 50, 32); Buffer.from('%PDF-1.4\n').copy(b); return b.toString('base64'); };

const PARTS = {
  documentType: 'parts_receipt', vendor: 'Euro Car Parts', date: '2026-10-02', currency: 'GBP', orderNumber: 'ECP-5521', total: 71.97,
  items: [{ name: 'Front brake pads', partNumber: 'BP123', quantity: 1, unitPrice: 41.99 }, { name: 'Oil filter', quantity: 2, lineTotal: 19.98 }, { name: 'Delivery', quantity: 1, unitPrice: 0 }],
  vehicleRegistration: 'ab12cde', confidence: 'high', summary: 'Brake pads and oil filters.',
};
const GARAGE = { documentType: 'garage_invoice', title: 'Full service', vendor: 'Kampala Motors', date: '2026-09-15', currency: 'UGX', total: 450000, workDescription: 'Full service', mileage: 51234, vehicleRegistration: '', confidence: 'medium' };

const answer = (obj) => ({ code: 200, body: { candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }] } });

function setup(opts) {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Admin Two', email: 'admin2@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  if (!opts || opts.key !== false) env.props.GEMINI_API_KEY = 'AIza-test-key';
  tokens.set(env, sam);
  const car = env.call('saveCar', { token: sam, fields: CAR }).data.car;
  const add = (extra, token) => env.call('uploadReceipt', Object.assign({ token: token || sam, mime: 'image/jpeg', data: jpeg(), filename: 'receipt.jpg' }, extra || {}));
  const read = (id, token) => env.call('readReceipt', { token: token || sam, id });
  return { env, admin, sam, car, add, read };
}

test('receipts need a session, and only a photo or a PDF is accepted', () => {
  const { env, sam, add } = setup();
  assert.equal(env.call('listInbox', {}).error, 'unauthorized');
  assert.equal(env.call('uploadReceipt', { mime: 'image/jpeg', data: jpeg() }).error, 'unauthorized');
  assert.equal(add({ mime: 'text/plain', data: Buffer.from('hi').toString('base64') }).error, 'invalid_attachment');
  assert.equal(add({ mime: 'application/pdf', data: jpeg() }).error, 'invalid_attachment'); // says PDF, is not
  assert.equal(add({ carId: 'nope' }).error, 'not_found');
  assert.equal(env.call('getInboxCount', { token: sam }).data.count, 0);
});

test('an uploaded receipt is stored, read by Gemini, and waits as Pending with the car guessed from its registration', () => {
  const { env, sam, car, add, read } = setup();
  env.state.gemini = () => answer(PARTS);
  const up = add().data.receipt;
  assert.equal(up.status, 'New');
  assert.equal(env.call('getInboxCount', { token: sam }).data.count, 1);
  const r = read(up.id).data.receipt;
  assert.equal(r.status, 'Pending');
  assert.equal(r.kind, 'Purchase');
  assert.equal(r.vendor, 'Euro Car Parts');
  assert.equal(r.total, 71.97);
  assert.equal(r.carId, car.id);
  assert.equal(r.data.items.length, 3);
  assert.deepEqual(r.data.items[1], { name: 'Oil filter', partNumber: '', quantity: 2, unitCost: 9.99 }); // a line total becomes a price each
  // the request: the key in a header (never the address), only the document and no email headers
  const sent = env.state.geminiRequests[0];
  assert.match(sent.url, /models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(sent.headers['x-goog-api-key'], 'AIza-test-key');
  assert.equal(sent.url.includes('AIza'), false);
  assert.equal(sent.body.contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
  assert.equal(sent.body.generationConfig.responseMimeType, 'application/json');
  // the saved row's file is in the Inbox folder, and the phone can fetch it back
  assert.equal(env.call('getReceiptFile', { token: sam, id: up.id }).data.mime, 'image/jpeg');
});

test('a garage invoice is suggested as Maintenance, with no car when the registration is not on it', () => {
  const { env, add, read } = setup();
  env.state.gemini = () => answer(GARAGE);
  const r = read(add().data.receipt.id).data.receipt;
  assert.equal(r.kind, 'Maintenance');
  assert.equal(r.carId, '');
  assert.equal(r.data.mileage, 51234);
  assert.equal(r.data.title, 'Full service'); // the entry's own title, without the garage's name
  assert.match(env.state.geminiRequests[0].body.systemInstruction.parts[0].text, /Do not put the shop or garage name/);
  assert.equal(r.currency, 'UGX');
});

test('the model\'s answer is cleaned: bad dates, currencies and types are dropped, never trusted', () => {
  const { env, add, read } = setup();
  env.state.gemini = () => answer({ documentType: 'weird', vendor: 'X'.repeat(500), date: '2999-01-01', currency: 'JPY', total: 'abc', items: [{ name: '' }, { name: 'Bolt', quantity: -3, unitPrice: 2 }], mileage: -5 });
  const r = read(add().data.receipt.id).data.receipt;
  assert.equal(r.kind, '');
  assert.equal(r.vendor.length, 80);
  assert.equal(r.date, '');
  assert.equal(r.currency, '');
  assert.equal(r.total, null);
  assert.deepEqual(r.data.items, [{ name: 'Bolt', partNumber: '', quantity: 1, unitCost: 2 }]);
  assert.equal(r.data.mileage, null);
});

test('without a key the receipt is kept as Unreadable, nothing is sent, and the admins are still told', () => {
  const { env, sam, add, read } = setup({ key: false });
  assert.equal(env.call('getReceiptStatus', { token: sam }).data.available, false);
  const r = read(add().data.receipt.id).data.receipt;
  assert.equal(r.status, 'Unreadable');
  assert.match(r.note, /not switched on/);
  assert.equal(env.state.geminiRequests.length, 0);
  assert.ok(env.outbox.some((m) => /waiting for review/.test(m.subject)));
});

test('a busy service queues the receipt; other Gemini trouble leaves it Unreadable; neither uses up the daily allowance', () => {
  const { env, add, read } = setup();
  env.props.RECEIPT_APP_DAILY = '2';
  const id = add().data.receipt.id;
  const cases = [[{ code: 429, body: {} }, 'Queued'], [{ code: 500, body: 'oops' }, 'Unreadable'], [answer('not json at all'), 'Unreadable'], [{ code: 200, body: { candidates: [] } }, 'Unreadable'],
    [{ code: 403, body: { error: { message: 'API key not valid' } } }, 'Unreadable'], [new Error('timeout'), 'Unreadable']];
  for (const [bad, status] of cases) {
    env.state.gemini = () => bad;
    assert.equal(read(id).data.receipt.status, status);
  }
  // six failures against a limit of two: the allowance was given back each time, so a good answer still works
  env.state.gemini = () => answer(PARTS);
  assert.equal(read(id).data.receipt.status, 'Pending');
});

test('the daily limit queues the receipt (saved, not lost) and it is read the next day', () => {
  const { env, add, read } = setup();
  env.props.RECEIPT_USER_DAILY = '1';
  env.state.gemini = () => answer(PARTS);
  assert.equal(read(add().data.receipt.id).data.receipt.status, 'Pending');
  const second = read(add().data.receipt.id).data.receipt;
  assert.equal(second.status, 'Queued');
  assert.match(second.note, /tomorrow/);
  assert.equal(env.state.geminiRequests.length, 1);
  assert.equal(env.call('getInboxCount', { token: setupToken(env) }).data.count, 2);
  // the timer does nothing for it today, and reads it once the allowance has renewed
  assert.equal(vm.runInContext('readQueuedReceipts_()', env.ctx), 0);
  env.advance(26 * 3600 * 1000);
  assert.equal(vm.runInContext('readQueuedReceipts_()', env.ctx), 1);
  assert.equal(env.call('getInboxItem', { token: setupToken(env), id: second.id }).data.receipt.status, 'Pending');
  assert.equal(env.state.geminiRequests.length, 2);
});

test('admins are emailed once when a receipt becomes ready, except the one who added it', () => {
  const { env, admin, add, read } = setup();
  env.state.gemini = () => answer(PARTS);
  const id = add({}, admin).data.receipt.id;
  env.outbox.length = 0;
  read(id, admin);
  const mails = env.outbox.filter((m) => /waiting for review/.test(m.subject));
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'admin2@example.com'); // the uploader is not told about their own receipt
  assert.match(mails[0].body, /Euro Car Parts/);
  assert.match(mails[0].body, /#\/inbox/);
  read(id, admin); // reading again does not email again
  assert.equal(env.outbox.filter((m) => /waiting for review/.test(m.subject)).length, 1);
});

test('the same order number is flagged as a possible duplicate', () => {
  const { env, add, read } = setup();
  env.state.gemini = () => answer(PARTS);
  const a = read(add().data.receipt.id).data.receipt;
  const b = read(add().data.receipt.id).data.receipt;
  assert.equal(a.duplicateOf, '');
  assert.equal(b.duplicateOf, a.id);
  assert.match(b.note, /same order/);
});

test('the Inbox lists open receipts first and the recently handled ones separately', () => {
  const { env, admin, sam, add, read } = setup();
  env.state.gemini = () => answer(PARTS);
  const a = add().data.receipt.id;
  add();
  read(a);
  env.call('dismissReceipt', { token: admin, id: a });
  const l = env.call('listInbox', { token: sam }).data;
  assert.equal(l.open.length, 1);
  assert.equal(l.recent.length, 1);
  assert.equal(l.recent[0].status, 'Dismissed');
  assert.equal(l.reading, true);
});

test('approving: the receipt is attached to the new entry with its own A- ID, and the Inbox item is closed (repeatable)', () => {
  const { env, sam, car, add, read } = setup();
  env.state.gemini = () => answer(PARTS);
  const id = read(add({ carId: car.id }).data.receipt.id).data.receipt.id;
  const saved = env.call('saveEntry', { token: sam, carId: car.id, type: 'Purchase', fields: { date: '2026-10-02', currency: 'GBP', vendor: 'Euro Car Parts' }, items: [{ name: 'Front brake pads', quantity: '1', unitCost: '41.99' }] }).data.entry;
  const r = env.call('resolveReceipt', { token: sam, id, entryId: saved.id });
  assert.equal(r.data.done, true);
  assert.match(r.data.attachment.ref, /^A-\d{4}$/);
  const detail = env.call('getEntry', { token: sam, id: saved.id }).data;
  assert.equal(detail.attachments.length, 1);
  assert.equal(detail.attachments[0].ref, r.data.attachment.ref);
  assert.equal(env.call('getAttachment', { token: sam, id: detail.attachments[0].id }).data.mime, 'image/jpeg');
  assert.equal(env.call('getInboxCount', { token: sam }).data.count, 0);
  assert.equal(env.call('getInboxItem', { token: sam, id }).data.receipt.status, 'Approved');
  // saving again (a retry after a dropped connection) neither fails nor attaches twice
  assert.equal(env.call('resolveReceipt', { token: sam, id, entryId: saved.id }).data.done, true);
  assert.equal(env.call('getEntry', { token: sam, id: saved.id }).data.attachments.length, 1);
  // a handled receipt cannot be used for another entry, nor read or dismissed
  const other = env.call('saveEntry', { token: sam, carId: car.id, type: 'Purchase', fields: { date: '2026-10-03' }, items: [{ name: 'Bulb', quantity: '1', unitCost: '3' }] }).data.entry;
  assert.equal(env.call('resolveReceipt', { token: sam, id, entryId: other.id }).error, 'receipt_closed');
  assert.equal(read(id).error, 'receipt_closed');
});

test('only an admin can dismiss, the file goes to the trash, and a dismissed receipt cannot be approved', () => {
  const { env, admin, sam, car, add } = setup();
  const id = add().data.receipt.id;
  assert.equal(env.call('dismissReceipt', { token: sam, id }).error, 'forbidden');
  assert.equal(env.call('dismissReceipt', { token: admin, id }).data.done, true);
  assert.ok(Object.values(env.files).some((f) => f.trashed === true));
  const entry = env.call('saveEntry', { token: sam, carId: car.id, type: 'Purchase', fields: { date: '2026-10-03' }, items: [{ name: 'Bulb', quantity: '1', unitCost: '3' }] }).data.entry;
  assert.equal(env.call('resolveReceipt', { token: sam, id, entryId: entry.id }).error, 'receipt_closed');
  assert.equal(env.call('getInboxCount', { token: sam }).data.count, 0);
});

test('a PDF receipt works the same way', () => {
  const { env, add, read } = setup();
  env.state.gemini = () => answer(PARTS);
  const up = add({ mime: 'application/pdf', data: pdf(), filename: 'order.pdf' }).data.receipt;
  assert.equal(up.filename, 'order.pdf');
  assert.equal(read(up.id).data.receipt.status, 'Pending');
  assert.equal(env.state.geminiRequests[0].body.contents[0].parts[1].inline_data.mime_type, 'application/pdf');
});

test('the receipt status says how many reads the person has left today (the smaller of theirs and the app\'s)', () => {
  const { env, sam, add, read } = setup();
  env.state.gemini = () => answer(PARTS);
  assert.deepEqual(env.call('getReceiptStatus', { token: sam }).data, { available: true, limit: 30, remaining: 30 });
  read(add().data.receipt.id);
  assert.equal(env.call('getReceiptStatus', { token: sam }).data.remaining, 29);
  env.props.RECEIPT_USER_DAILY = '2';
  assert.deepEqual(env.call('getReceiptStatus', { token: sam }).data, { available: true, limit: 2, remaining: 1 });
  env.props.RECEIPT_APP_DAILY = '1'; // the app has used its one
  assert.equal(env.call('getReceiptStatus', { token: sam }).data.remaining, 0);
  assert.equal(env.call('getReceiptStatus', {}).error, 'unauthorized');
});
