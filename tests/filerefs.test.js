'use strict';
// Every attachment and car document has an ID such as A-0042: one series, never changes, never reused.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const CAR = { registration: 'AB12 CDE', make: 'Toyota', model: 'Hilux', year: '2015', odometer: '50000' };
const jpeg = (n) => { const b = Buffer.alloc(n, 5); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0; return b.toString('base64'); };
const pdf = (n) => { const b = Buffer.alloc(n, 32); Buffer.from('%PDF-1.4\n').copy(b); return b.toString('base64'); };

function setup() {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  const car = env.call('saveCar', { token: sam, fields: CAR }).data.car;
  const entry = env.call('saveEntry', { token: sam, carId: car.id, type: 'Maintenance', fields: { title: 'Service', date: '2026-10-01' } }).data.entry;
  const attach = (extra) => env.call('uploadAttachment', Object.assign({ token: sam, entryId: entry.id, mime: 'image/jpeg', data: jpeg(2000), filename: 'a.jpg' }, extra || {}));
  const doc = (extra) => env.call('uploadCarDocument', Object.assign({ token: sam, carId: car.id, type: 'Other', mime: 'application/pdf', data: pdf(2000), filename: 'd.pdf' }, extra || {}));
  return { env, admin, sam, car, entry, attach, doc };
}

test('photos, files and car documents share one numbering: A-0001, A-0002, ...', () => {
  const { env, sam, car, entry, attach, doc } = setup();
  assert.equal(attach().data.attachment.ref, 'A-0001');
  assert.equal(doc().data.document.ref, 'A-0002', 'a car document continues the same series');
  assert.equal(attach({ mime: 'application/pdf', data: pdf(500), filename: 'q.pdf' }).data.attachment.ref, 'A-0003');
  assert.equal(attach({ mime: 'application/octet-stream', data: Buffer.from('hello').toString('base64'), filename: 'sheet.xlsx' }).data.attachment.ref, 'A-0004');

  // and they show wherever the files are listed
  assert.deepEqual(env.call('getEntry', { token: sam, id: entry.id }).data.attachments.map((a) => a.ref), ['A-0001', 'A-0003', 'A-0004']);
  assert.deepEqual(env.call('listCarDocuments', { token: sam, carId: car.id }).data.documents.map((d) => d.ref), ['A-0002']);
  assert.deepEqual(env.call('getCarPage', { token: sam, id: car.id }).data.documents.map((d) => d.ref), ['A-0002']);
  const bundle = env.call('getCarBundle', { token: sam, carId: car.id }).data;
  assert.deepEqual(bundle.details[entry.id].attachments.map((a) => a.ref), ['A-0001', 'A-0003', 'A-0004']);
});

test('an ID never changes and is never reused after a file is removed', () => {
  const { env, admin, sam, entry, attach, doc } = setup();
  const a = attach().data.attachment;
  const d = doc().data.document;
  assert.equal(env.call('deleteAttachment', { token: admin, id: a.id }).ok, true);
  assert.equal(env.call('deleteCarDocument', { token: admin, id: d.id }).ok, true);
  assert.equal(attach().data.attachment.ref, 'A-0003', 'removed numbers are not handed out again');
  assert.deepEqual(env.call('getEntry', { token: sam, id: entry.id }).data.attachments.map((x) => x.ref), ['A-0003']);
});

test('if the counter is ever lost, no ID is handed out twice', () => {
  const { env, attach, doc } = setup();
  attach(); attach(); doc();
  delete env.props.REF_A;
  assert.equal(attach().data.attachment.ref, 'A-0004');
  delete env.props.REF_A;
  assert.equal(doc().data.document.ref, 'A-0005');
});

test('IDs are unique across the whole platform, not per car or per entry', () => {
  const { env, sam, attach } = setup();
  const car2 = env.call('saveCar', { token: sam, fields: Object.assign({}, CAR, { registration: 'ZZ99 ZZZ' }) }).data.car;
  const e2 = env.call('saveEntry', { token: sam, carId: car2.id, type: 'Issue', fields: { title: 'Rattle', date: '2026-10-02' } }).data.entry;
  const refs = [attach().data.attachment.ref,
    env.call('uploadAttachment', { token: sam, entryId: e2.id, mime: 'image/jpeg', data: jpeg(900), filename: 'b.jpg' }).data.attachment.ref,
    attach().data.attachment.ref];
  assert.equal(new Set(refs).size, 3);
  assert.deepEqual(refs, ['A-0001', 'A-0002', 'A-0003']);
});

test('a guest\'s photo gets an ID too, and the guest sees it in their list', () => {
  const { env, sam, car } = setup();
  const secret = env.call('getCar', { token: sam, id: car.id }).data.car.guestSecret;
  const g = env.call('guestJoin', { carId: car.id, secret, name: 'Alice' }).data.guestToken;
  const e = env.call('guestSaveEntry', { guestToken: g, type: 'Maintenance', fields: { title: 'Oil', date: '2026-10-03' } }).data.entry;
  const up = env.call('guestUploadAttachment', { guestToken: g, entryId: e.id, mime: 'image/jpeg', data: jpeg(300), filename: 'p.jpg' });
  assert.equal(up.data.attachment.ref, 'A-0001');
  assert.deepEqual(env.call('guestListAttachments', { guestToken: g, entryId: e.id }).data.attachments.map((a) => a.ref), ['A-0001']);
});

test('the migration numbers every existing file, oldest first, removed ones too, in one series; new ones carry on', () => {
  const { env, admin, sam, car, entry, attach, doc } = setup();
  const a1 = attach().data.attachment;
  env.advance(1000);
  const d1 = doc().data.document;
  env.advance(1000);
  const a2 = attach().data.attachment;
  env.advance(1000);
  const d2 = doc().data.document;
  env.call('deleteAttachment', { token: admin, id: a2.id });
  // wind back to before the feature: no IDs, no counter
  for (const tab of ['Attachments', 'CarDocuments']) {
    const col = env.sheets[tab]._rows[0].indexOf('ref');
    env.sheets[tab]._rows.forEach((r, i) => { if (i > 0) r[col] = ''; });
  }
  delete env.props.REF_A;
  env.invalidate();
  env.props.SCHEMA_VERSION = '18';
  const got = env.call('getEntry', { token: sam, id: entry.id }).data.attachments; // the first request runs the migration
  assert.deepEqual(got.map((a) => [a.id, a.ref]), [[a1.id, 'A-0001']]);
  assert.equal(env.call('listCarDocuments', { token: sam, carId: car.id }).data.documents.find((d) => d.id === d1.id).ref, 'A-0002');
  const colA = env.sheets.Attachments._rows[0].indexOf('ref');
  assert.equal(env.sheets.Attachments._rows.find((r) => r[0] === a2.id)[colA], 'A-0003', 'a removed file keeps its number');
  assert.equal(env.call('listCarDocuments', { token: sam, carId: car.id }).data.documents.find((d) => d.id === d2.id).ref, 'A-0004');
  assert.equal(attach().data.attachment.ref, 'A-0005', 'new ones carry on after the old');
  assert.equal(env.props.SCHEMA_VERSION, '19');
});

test('a file ID changes the car\'s revision, so phones pick up the numbers', () => {
  const { env, sam, car, attach } = setup();
  const before = env.call('getChanges', { token: sam }).data.cars[car.id];
  attach();
  assert.notEqual(env.call('getChanges', { token: sam }).data.cars[car.id], before);
});
