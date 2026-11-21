'use strict';
// Copying an entry to another vehicle.
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
  const car2 = env.call('saveCar', { token: sam, fields: Object.assign({}, CAR, { registration: 'ZZ99 ZZZ', odometer: '120000' }) }).data.car;
  const add = (type, fields, extra, carId) => env.call('saveEntry', Object.assign({ token: sam, carId: carId || car.id, type, fields }, extra || {}));
  const copy = (id, carId, token) => env.call('copyEntry', { token: token || sam, id, carId });
  const get = (id) => env.call('getEntry', { token: sam, id });
  return { env, admin, sam, car, car2, add, copy, get };
}

// a maintenance entry with everything on it
function fullJob(s) {
  const issue = s.add('Issue', { title: 'Squeaky brakes', date: '2026-09-20', mileage: '50000' }).data.entry;
  const purchase = s.add('Purchase', { title: 'Brake pads', date: '2026-09-25', quantity: '2', unitCost: '30', partNumber: 'BP-1' }).data.entry;
  const task = s.env.call('saveTask', { token: s.sam, carId: s.car.id, fields: { name: 'Brake check', dueDate: '2027-01-01' } }).data.task;
  const job = s.add('Maintenance', { title: 'Front brakes', date: '2026-10-02', mileage: '50100', vendor: 'Joe\'s Garage', labourCost: '90', labourNote: 'Joe', labourHours: '1.5', otherCost: '5', otherNote: 'disposal', notes: 'Used the Bosch pads.', linkedIssueId: issue.id },
    { parts: [{ purchaseId: purchase.id, quantity: '1' }], taskId: task && task.id }).data.entry;
  const up = (mime, data, name, thumb) => s.env.call('uploadAttachment', { token: s.sam, entryId: job.id, mime, data, filename: name, thumb });
  up('image/jpeg', jpeg(3000), 'pads.jpg', jpeg(400));
  up('application/pdf', pdf(800), 'invoice.pdf');
  return { issue, purchase, job };
}

test('copying a maintenance entry: its details, costs, photos and files go to the other car, with new IDs', () => {
  const s = setup();
  const { job } = fullJob(s);
  const r = s.copy(job.id, s.car2.id);
  assert.equal(r.ok, true);
  const e = r.data.entry;
  assert.equal(e.carId, s.car2.id);
  assert.notEqual(e.id, job.id);
  assert.notEqual(e.ref, job.ref, 'its own reference');
  assert.match(e.ref, /^M-\d{4}$/);
  assert.deepEqual([e.title, e.date, e.vendor, e.type], ['Front brakes', '2026-10-02', 'Joe\'s Garage', 'Maintenance']);
  assert.deepEqual([e.labourCost, e.labourNote, e.labourHours, e.otherCost, e.otherNote], [90, 'Joe', 1.5, 5, 'disposal']);
  assert.equal(e.mileage, null, 'the mileage belongs to the first car, so it is left blank');
  assert.equal(r.data.attachments, 2);
  assert.equal(r.data.skipped, 0);

  const d = s.get(e.id).data;
  assert.equal(d.attachments.length, 2);
  assert.deepEqual(d.attachments.map((a) => a.filename).sort(), ['invoice.pdf', 'pads.jpg']);
  assert.equal(d.attachments.find((a) => a.filename === 'pads.jpg').thumb, true, 'the photo keeps its thumbnail');
  const orig = s.get(job.id).data;
  const refs = [...orig.attachments, ...d.attachments].map((a) => a.ref);
  assert.equal(new Set(refs).size, 4, 'every file has its own new ID');
  d.attachments.forEach((a) => assert.ok(!orig.attachments.some((o) => o.id === a.id)));
  // the files really are separate copies, and they open
  const copyJpeg = s.env.call('getAttachment', { token: s.sam, id: d.attachments.find((a) => a.filename === 'pads.jpg').id });
  assert.equal(copyJpeg.data.data, jpeg(3000));
  assert.equal(s.env.call('getAttachmentThumbs', { token: s.sam, ids: [d.attachments.find((a) => a.filename === 'pads.jpg').id] }).ok, true);
  assert.equal(orig.attachments.length, 2, 'the original still has its files');

  // not carried over: the issue link, the reminder, the stock the parts came from
  assert.equal(d.linkedIssue, undefined);
  assert.equal(d.reminder, undefined);
  assert.deepEqual(d.parts, []);
  assert.deepEqual(d.jobCost, { GBP: 95 }, 'only labour and other costs; the parts cost is not counted again');
  assert.equal(s.get(job.id).data.parts.length, 1, 'the original still uses its part');
  assert.equal(s.env.call('listPurchases', { token: s.sam, carId: s.car2.id }).data.purchases.length, 0, 'nothing appears in the other car\'s stock');

  // the notes say what happened
  assert.equal(e.notes, 'Used the Bosch pads.\n\nParts used on the original: Brake pads [BP-1] x 1\nCopied from ' + job.ref + ' on AB12 CDE');
});

test('copying does not touch the other car\'s odometer, and the other car\'s page and costs include the copy', () => {
  const s = setup();
  const { job } = fullJob(s);
  const before = s.env.call('getCar', { token: s.sam, id: s.car2.id }).data.car.odometer;
  const e = s.copy(job.id, s.car2.id).data.entry;
  assert.equal(s.env.call('getCar', { token: s.sam, id: s.car2.id }).data.car.odometer, before);
  const page = s.env.call('getCarPage', { token: s.sam, id: s.car2.id }).data;
  assert.deepEqual(page.entries.map((x) => x.id), [e.id]);
  assert.equal(page.costs.currencies[0].total, 95);
  assert.equal(s.env.call('getCarPage', { token: s.sam, id: s.car.id }).data.entries.some((x) => x.id === e.id), false);
});

test('issues, purchases and compliance entries copy too, keeping their own fields', () => {
  const s = setup();
  const issue = s.add('Issue', { title: 'Rattle', date: '2026-09-20', mileage: '50000', status: 'In-work', cost: '15', notes: 'Heard on bumps' }).data.entry;
  const buy = s.add('Purchase', { title: 'Wipers', date: '2026-09-25', quantity: '2', unitCost: '8', partNumber: 'W-1', productUrl: 'https://example.com/w' }).data.entry;
  const comp = s.add('Compliance', { title: 'MOT', date: '2026-08-01', cost: '54', expiryDate: '2027-08-01' }).data.entry;
  const i2 = s.copy(issue.id, s.car2.id).data.entry;
  assert.deepEqual([i2.type, i2.status, i2.cost, i2.mileage], ['Issue', 'In-work', 15, null]);
  assert.match(i2.ref, /^I-\d{4}$/);
  const p2 = s.copy(buy.id, s.car2.id).data.entry;
  assert.deepEqual([p2.type, p2.quantity, p2.unitCost, p2.partNumber, p2.productUrl], ['Purchase', 2, 8, 'W-1', 'https://example.com/w']);
  assert.equal(s.get(p2.id).data.stock.status, 'In stock');
  const c2 = s.copy(comp.id, s.car2.id).data.entry;
  assert.deepEqual([c2.type, c2.cost, c2.expiryDate], ['Compliance', 54, '2027-08-01']);
  assert.ok(i2.notes.endsWith('Copied from ' + issue.ref + ' on AB12 CDE'));
});

test('it can be copied again, and to several cars one after the other, each with its own reference', () => {
  const s = setup();
  const car3 = s.env.call('saveCar', { token: s.sam, fields: Object.assign({}, CAR, { registration: 'QQ11 QQQ' }) }).data.car;
  const job = s.add('Maintenance', { title: 'Oil change', date: '2026-10-02', labourCost: '20' }).data.entry;
  const a = s.copy(job.id, s.car2.id).data.entry;
  const b = s.copy(job.id, car3.id).data.entry;
  const again = s.copy(job.id, s.car2.id).data.entry;
  assert.equal(new Set([job.ref, a.ref, b.ref, again.ref]).size, 4);
  const fromCopy = s.copy(a.id, car3.id).data.entry; // a copy of a copy says where it came from
  assert.ok(fromCopy.notes.includes('Copied from ' + a.ref + ' on ZZ99 ZZZ'));
});

test('long notes are cut to leave room for the origin line', () => {
  const s = setup();
  const job = s.add('Maintenance', { title: 'Big notes', date: '2026-10-02', notes: 'x'.repeat(1990) }).data.entry;
  const e = s.copy(job.id, s.car2.id).data.entry;
  assert.ok(e.notes.length <= 2000);
  assert.ok(e.notes.endsWith('Copied from ' + job.ref + ' on AB12 CDE'));
});

test('removed files are not copied; a file missing from Drive is skipped without losing the entry', () => {
  const s = setup();
  const job = s.add('Maintenance', { title: 'Files', date: '2026-10-02' }).data.entry;
  const up = (name) => s.env.call('uploadAttachment', { token: s.sam, entryId: job.id, mime: 'image/jpeg', data: jpeg(900), filename: name }).data.attachment;
  const a = up('one.jpg'); const b = up('two.jpg'); up('three.jpg');
  s.env.call('deleteAttachment', { token: s.admin, id: a.id });
  // two.jpg's file disappears from Drive
  const row = s.env.sheets.Attachments._rows.find((r) => r[0] === b.id);
  const col = s.env.sheets.Attachments._rows[0].indexOf('drive_file_id');
  delete s.env.files[row[col]];
  const r = s.copy(job.id, s.car2.id);
  assert.equal(r.ok, true);
  assert.deepEqual([r.data.attachments, r.data.skipped], [1, 1]);
  assert.deepEqual(s.get(r.data.entry.id).data.attachments.map((x) => x.filename), ['three.jpg']);
});

test('only to another, existing car; signed-in users only; the audit log records it; phones see the change', () => {
  const s = setup();
  const job = s.add('Maintenance', { title: 'Oil change', date: '2026-10-02' }).data.entry;
  assert.equal(s.copy(job.id, s.car.id).error, 'invalid_input', 'not to the same car');
  assert.equal(s.copy(job.id, 'nope').error, 'not_found');
  assert.equal(s.copy('nope', s.car2.id).error, 'not_found');
  assert.equal(s.env.call('copyEntry', { id: job.id, carId: s.car2.id }).error, 'unauthorized');
  s.env.call('deleteCar', { token: s.admin, id: s.car2.id });
  assert.equal(s.copy(job.id, s.car2.id).error, 'not_found', 'not to a deleted car');
  s.env.call('restoreCar', { token: s.admin, id: s.car2.id });

  const rev = s.env.call('getChanges', { token: s.sam }).data.cars[s.car2.id];
  const e = s.copy(job.id, s.car2.id).data.entry;
  assert.notEqual(s.env.call('getChanges', { token: s.sam }).data.cars[s.car2.id], rev);
  const audit = s.env.sheets.Audit._rows.filter((r) => r.includes('entry_copied'));
  assert.equal(audit.length, 1);
  assert.ok(audit[0].join(' ').includes(job.ref) && audit[0].join(' ').includes('AB12 CDE') && audit[0].join(' ').includes('ZZ99 ZZZ') && audit[0].join(' ').includes(e.ref));
});

test('an entry added by a guest can be copied, and the copy is the staff member\'s', () => {
  const s = setup();
  const secret = s.env.call('getCar', { token: s.sam, id: s.car.id }).data.car.guestSecret;
  const g = s.env.call('guestJoin', { carId: s.car.id, secret, name: 'Alice' }).data.guestToken;
  const e = s.env.call('guestSaveEntry', { guestToken: g, type: 'Maintenance', fields: { title: 'Guest oil', date: '2026-10-03' } }).data.entry;
  const r = s.copy(e.id, s.car2.id);
  assert.equal(r.ok, true);
  assert.equal(s.get(r.data.entry.id).data.entry.guestName, '');
});
