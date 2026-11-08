'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { createEnv } = require('./harness');

const CAR = { registration: 'AB12 CDE', make: 'Toyota', model: 'Hilux', year: '2015', odometer: '50000' };
const D1 = '2025-03-01';
const D2 = '2025-04-10';

function setup() {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  const car = env.call('saveCar', { token: sam, fields: CAR }).data.car;
  const add = (type, fields, extra, token) => env.call('saveEntry', Object.assign({ token: token || sam, carId: car.id, type, fields }, extra || {}));
  const get = (id, token) => env.call('getEntry', { token: token || sam, id });
  const list = (token) => env.call('listEntries', { token: token || sam, carId: car.id }).data.entries;
  return { env, admin, sam, car, add, get, list };
}

const issue = (extra) => Object.assign({ title: 'Faulty parking sensor', date: D1, mileage: '50100' }, extra);
const purchase = (extra) => Object.assign({ title: 'Front brake pads', date: D1, quantity: '1', unitCost: '60' }, extra);
const repair = (extra) => Object.assign({ title: 'Replaced brake pads', date: D2, labourCost: '90' }, extra);

function jpeg(size) {
  const b = Buffer.alloc(size, 5);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  return b.toString('base64');
}
function pdf(size) {
  const b = Buffer.alloc(size, 32);
  Buffer.from('%PDF-1.4\n').copy(b);
  return b.toString('base64');
}

// ---------- access ----------

test('entry actions need a session; deleting needs an admin', () => {
  const { env, sam, car, add } = setup();
  const e = add('Issue', issue()).data.entry;
  ['listEntries', 'getEntry', 'listPurchases', 'saveEntry', 'setIssueStatus', 'deleteEntry', 'getCarCosts', 'uploadAttachment', 'getAttachment', 'deleteAttachment']
    .forEach((a) => assert.equal(env.call(a, { carId: car.id, id: e.id }).error, 'unauthorized', a));
  assert.equal(env.call('deleteEntry', { token: sam, id: e.id }).error, 'forbidden');
  assert.equal(env.call('deleteAttachment', { token: sam, id: 'x' }).error, 'forbidden');
});

// ---------- creating and validating ----------

test('every entry type can be added, with the fields that belong to it', () => {
  const { env, sam, car, add, list } = setup();
  assert.equal(add('Issue', issue({ cost: '25', currency: 'GBP' })).ok, true);
  assert.equal(add('Maintenance', repair()).ok, true);
  assert.equal(add('Maintenance', repair({ title: 'Oil and filter change' })).ok, true);
  assert.equal(add('Compliance', { title: 'MOT passed', date: D1, cost: '54.85', expiryDate: '2099-03-01' }).ok, true);
  assert.equal(add('Purchase', purchase()).ok, true);
  const types = list().map((e) => e.type).sort();
  assert.deepEqual(types, ['Compliance', 'Issue', 'Maintenance', 'Maintenance', 'Purchase']);
  assert.equal(env.call('listEntries', { token: sam, carId: car.id }).data.entries.length, 5);
});

test('required fields, formats and enumerations are enforced', () => {
  const { add, list } = setup();
  const bad = (type, fields, code, extra) => assert.equal(add(type, fields, extra).error, code, code + ' ' + JSON.stringify(fields).slice(0, 60));
  bad('Issue', issue({ title: '  ' }), 'title_required');
  bad('Issue', issue({ date: '' }), 'date_required');
  bad('Issue', issue({ date: '2999-01-01' }), 'invalid_date');
  bad('Issue', issue({ date: '2025-02-30' }), 'invalid_date');
  bad('Issue', issue({ date: 'Mar 2025' }), 'invalid_date');            // events need a full date
  bad('Issue', issue({ mileage: '-5' }), 'invalid_odometer');
  bad('Issue', issue({ currency: 'XYZ' }), 'invalid_currency');
  bad('Issue', issue({ status: 'Done' }), 'invalid_status');
  bad('Issue', issue({ cost: 'lots' }), 'invalid_cost');
  bad('Bogus', issue(), 'invalid_type');
  bad('Compliance', { title: 'MOT', date: D1, expiryDate: '2099' }, 'invalid_date');
  bad('Purchase', purchase({ quantity: '0' }), 'invalid_quantity');
  bad('Purchase', purchase({ quantity: '-2' }), 'invalid_quantity');
  bad('Purchase', purchase({ quantity: 'two' }), 'invalid_quantity');
  bad('Purchase', purchase({ unitCost: '' }), 'unit_cost_required');
  bad('Purchase', purchase({ productUrl: 'http://shop.example.com' }), 'invalid_url');
  bad('Purchase', purchase({ productUrl: 'javascript:alert(1)' }), 'invalid_url');
  bad('Maintenance', repair({ costMode: 'weird' }), 'invalid_cost_mode');
  bad('Maintenance', repair({ labourHours: '1e3' }), 'invalid_hours');
  assert.equal(list().length, 0, 'nothing saved by the failed attempts');
});

test('dates may be typed UK style and are stored as ISO; text is cleaned', () => {
  const { add } = setup();
  const e = add('Issue', issue({ date: '10/03/2025', title: '  Rattle   <b>at</b> front ', notes: 'line1\r\nline2\u0007' })).data.entry;
  assert.equal(e.date, '2025-03-10');
  assert.equal(e.title, 'Rattle <b>at</b> front');   // stored as text; the app escapes it when showing
  assert.equal(e.notes, 'line1\nline2');
  assert.equal(e.currency, 'GBP', 'currency defaults from the car');
});

test('an Uganda car defaults entries to UGX', () => {
  const { env, sam } = setup();
  const ug = env.call('saveCar', { token: sam, fields: { registration: 'UBA 1', make: 'Toyota', model: 'Hilux', year: '2012', country: 'UG' } }).data.car;
  const e = env.call('saveEntry', { token: sam, carId: ug.id, type: 'Issue', fields: issue() }).data.entry;
  assert.equal(e.currency, 'UGX');
});

test('entries can only be added to existing cars; deleted cars are closed to users', () => {
  const { env, admin, sam, car, add } = setup();
  assert.equal(env.call('saveEntry', { token: sam, carId: 'nope', type: 'Issue', fields: issue() }).error, 'not_found');
  const e = add('Issue', issue()).data.entry;
  env.call('deleteCar', { token: admin, id: car.id });
  assert.equal(add('Issue', issue()).error, 'not_found');
  assert.equal(env.call('listEntries', { token: sam, carId: car.id }).error, 'not_found');
  assert.equal(env.call('getEntry', { token: sam, id: e.id }).error, 'not_found');
  assert.equal(env.call('listEntries', { token: admin, carId: car.id }).ok, true);
});

// ---------- updating ----------

test('update needs the current version; the type cannot change', () => {
  const { env, sam, admin, add, get } = setup();
  const e = add('Issue', issue()).data.entry;
  const upd = env.call('saveEntry', { token: sam, id: e.id, version: e.version, type: 'Maintenance', fields: issue({ title: 'Parking sensor dead' }) });
  assert.equal(upd.ok, true);
  assert.equal(upd.data.entry.type, 'Issue', 'type is kept');
  assert.equal(upd.data.entry.version, 2);
  assert.equal(env.call('saveEntry', { token: admin, id: e.id, version: 1, fields: issue({ title: 'Other' }) }).error, 'conflict');
  assert.equal(get(e.id).data.entry.title, 'Parking sensor dead');
  assert.equal(env.call('saveEntry', { token: sam, id: 'nope', version: 1, fields: issue() }).error, 'not_found');
});

// ---------- issues ----------

test('issue statuses can be changed by any user and are audited', () => {
  const { env, sam, add, get } = setup();
  const e = add('Issue', issue()).data.entry;
  assert.equal(e.status, 'Not resolved');
  ['In-work', 'Ignored', 'Resolved'].forEach((s) => {
    assert.equal(env.call('setIssueStatus', { token: sam, id: e.id, status: s }).data.entry.status, s);
  });
  assert.equal(get(e.id).data.entry.status, 'Resolved');
  assert.equal(env.call('setIssueStatus', { token: sam, id: e.id, status: 'Done' }).error, 'invalid_status');
  const rep = add('Maintenance', repair()).data.entry;
  assert.equal(env.call('setIssueStatus', { token: sam, id: rep.id, status: 'Resolved' }).error, 'not_found', 'only issues have a status');
  const n = env.sheets.Audit._rows.slice(1).filter((r) => r[3] === 'issue_status_changed').length;
  assert.equal(n, 3);
});

test('maintenance can link to an issue and mark it resolved; links are checked', () => {
  const { env, sam, add, get, list } = setup();
  const i = add('Issue', issue()).data.entry;
  const r = add('Maintenance', repair({ linkedIssueId: i.id }), { resolveIssue: true });
  assert.equal(r.data.issueResolved, true);
  assert.equal(get(i.id).data.entry.status, 'Resolved');
  assert.deepEqual(get(i.id).data.fixedBy.map((x) => x.title), ['Replaced brake pads']);
  assert.equal(get(r.data.entry.id).data.linkedIssue.title, 'Faulty parking sensor');

  // without the flag the issue is left alone
  const i2 = add('Issue', issue({ title: 'Noise' })).data.entry;
  add('Maintenance', repair({ title: 'Fix noise', linkedIssueId: i2.id }));
  assert.equal(get(i2.id).data.entry.status, 'Not resolved');

  // a stand-alone repair (no issue) is fine; links must be to an issue on the same car
  assert.equal(add('Maintenance', repair({ title: 'Alone' })).ok, true);
  assert.equal(add('Maintenance', repair({ linkedIssueId: 'nope' })).error, 'not_found');
  const other = env.call('saveCar', { token: sam, fields: { registration: 'OTHER 1', make: 'Ford', model: 'Ka', year: '2010' } }).data.car;
  const foreign = env.call('saveEntry', { token: sam, carId: other.id, type: 'Issue', fields: issue() }).data.entry;
  assert.equal(add('Maintenance', repair({ linkedIssueId: foreign.id })).error, 'not_found');
  const rep = list().find((e) => e.type === 'Maintenance' && e.linkedIssueId === i.id);
  assert.ok(rep);
});

test('the old "Repair" type is now Maintenance: a stale app is accepted, and stored Repair rows are converted by the migration', () => {
  const { env, sam, add, list, get } = setup();
  // an older open copy of the app still sends type "Repair"
  const viaOld = add('Repair', repair({ title: 'From old app' }));
  assert.equal(viaOld.ok, true);
  assert.equal(viaOld.data.entry.type, 'Maintenance');

  // simulate rows saved before the merge, with parts and an issue link
  const i = add('Issue', issue()).data.entry;
  const old = add('Maintenance', repair({ title: 'Old brake job', linkedIssueId: i.id }), { parts: [{ name: 'Pads', quantity: '1', unitCost: '40' }] }).data.entry;
  const col = env.sheets.Entries._rows[0].indexOf('type');
  env.sheets.Entries._rows.forEach((r, n) => { if (n > 0 && r[0] === old.id) r[col] = 'Repair'; });
  env.props.SCHEMA_VERSION = '8';
  assert.equal(list().filter((e) => e.type === 'Repair').length, 0, 'migration ran on the first request');
  const back = get(old.id).data;
  assert.equal(back.entry.type, 'Maintenance');
  assert.equal(back.entry.title, 'Old brake job');
  assert.equal(back.parts.length, 1, 'its parts are still attached');
  assert.equal(back.linkedIssue.id, i.id, 'and its issue link');
  assert.equal(get(i.id).data.fixedBy.some((x) => x.id === old.id), true);
  assert.ok(env.sheets.Audit._rows.some((r) => r[3] === 'entry_types_merged'));
  assert.equal(env.call('saveEntry', { token: sam, carId: i.carId, type: 'Nonsense', fields: {} }).error, 'invalid_type');
});

// ---------- purchases and stock ----------

test('a purchase tracks its total and stock status', () => {
  const { add, get, list } = setup();
  const p = add('Purchase', purchase({ quantity: '4', unitCost: '12.50', shippingCost: '5', partNumber: 'BP-123', vendor: 'Parts Ltd', productUrl: 'https://partsouq.com/x' })).data.entry;
  const row = list().find((e) => e.id === p.id);
  assert.equal(row.total, 55);           // 4 x 12.50 + 5
  assert.equal(row.remaining, 4);
  assert.equal(row.stockStatus, 'In stock');
  const detail = get(p.id).data;
  assert.equal(detail.stock.perUnit, 13.75);
  assert.equal(detail.entry.productUrl, 'https://partsouq.com/x');
  assert.deepEqual(detail.usedIn, []);
});

test('a repair can buy-and-use new parts: they join the purchase ledger and add to the job cost', () => {
  const { add, get, list } = setup();
  const r = add('Maintenance', repair(), { parts: [
    { name: 'Brake pads', quantity: '1', unitCost: '60', vendor: 'Parts Ltd', partNumber: 'BP1' },
    { name: 'Brake fluid', quantity: '2', unitCost: '8.25', shippingCost: '1.50' },
  ] }).data.entry;
  const purchases = list().filter((e) => e.type === 'Purchase');
  assert.deepEqual(purchases.map((p) => p.title).sort(), ['Brake fluid', 'Brake pads']);
  purchases.forEach((p) => { assert.equal(p.stockStatus, 'Fitted'); assert.equal(p.remaining, 0); assert.equal(p.date, D2); });
  const d = get(r.id).data;
  assert.equal(d.parts.length, 2);
  // parts 60 + (2 x 8.25 + 1.50 = 18) = 78, plus labour 90 = 168
  assert.deepEqual(d.jobCost, { GBP: 168 });
  assert.equal(list().find((e) => e.id === r.id).partsUsed, 2);
});

test('a repair can use parts already bought, a few at a time; stock cannot go negative', () => {
  const { add, get, list, env, sam, car } = setup();
  const oil = add('Purchase', purchase({ title: '5 L oil', quantity: '5', unitCost: '10' })).data.entry;
  const r1 = add('Maintenance', repair({ title: 'Oil change 1', labourCost: '0' }), { parts: [{ purchaseId: oil.id, quantity: '3' }] }).data.entry;
  assert.equal(list().find((e) => e.id === oil.id).stockStatus, 'Partly used');
  assert.equal(list().find((e) => e.id === oil.id).remaining, 2);
  assert.deepEqual(get(r1.id).data.jobCost, { GBP: 30 });

  assert.equal(add('Maintenance', repair({ title: 'Too much' }), { parts: [{ purchaseId: oil.id, quantity: '3' }] }).error, 'not_enough_stock');
  const r2 = add('Maintenance', repair({ title: 'Oil change 2', labourCost: '' }), { parts: [{ purchaseId: oil.id, quantity: '2' }] }).data.entry;
  assert.equal(list().find((e) => e.id === oil.id).stockStatus, 'Fitted');
  assert.deepEqual(get(oil.id).data.usedIn.map((u) => u.quantity).sort(), [2, 3]);

  // editing the first event can lower its use, which frees stock for others
  const up = env.call('saveEntry', { token: sam, id: r1.id, version: r1.version, fields: repair({ title: 'Oil change 1', labourCost: '0' }), parts: [{ purchaseId: oil.id, quantity: '1' }] });
  assert.equal(up.ok, true);
  assert.equal(list().find((e) => e.id === oil.id).remaining, 2);
  // but cannot raise it beyond what is left (own usage counts as available)
  assert.equal(env.call('saveEntry', { token: sam, id: r1.id, version: 2, fields: repair({ title: 'Oil change 1', labourCost: '0' }), parts: [{ purchaseId: oil.id, quantity: '3.5' }] }).error, 'not_enough_stock');
  assert.equal(env.call('saveEntry', { token: sam, id: r1.id, version: 2, fields: repair({ title: 'Oil change 1', labourCost: '0' }), parts: [{ purchaseId: oil.id, quantity: '3' }] }).ok, true);
  assert.ok(r2 && car);
});

test('parts must be real purchases of the same car', () => {
  const { env, sam, add } = setup();
  assert.equal(add('Maintenance', repair(), { parts: [{ purchaseId: 'nope', quantity: '1' }] }).error, 'not_found');
  const other = env.call('saveCar', { token: sam, fields: { registration: 'OTHER 1', make: 'Ford', model: 'Ka', year: '2010' } }).data.car;
  const foreign = env.call('saveEntry', { token: sam, carId: other.id, type: 'Purchase', fields: purchase() }).data.entry;
  assert.equal(add('Maintenance', repair(), { parts: [{ purchaseId: foreign.id, quantity: '1' }] }).error, 'not_found');
  assert.equal(add('Maintenance', repair(), { parts: [{ name: '', quantity: '1', unitCost: '5' }] }).error, 'part_name_required');
  assert.equal(add('Maintenance', repair(), { parts: [{ name: 'X', quantity: '1' }] }).error, 'unit_cost_required');
  assert.equal(add('Maintenance', repair(), { parts: [{ name: 'X', quantity: '0', unitCost: '5' }] }).error, 'invalid_quantity');
  assert.equal(add('Maintenance', repair(), { parts: 'x' }).error, 'invalid_input');
  assert.equal(add('Issue', issue(), { parts: [{ name: 'X', quantity: '1', unitCost: '5' }] }).error, 'invalid_input', 'only repairs and maintenance use parts');
});

test('a failed save leaves nothing behind (no half-created purchases)', () => {
  const { add, list } = setup();
  const before = list().length;
  assert.equal(add('Maintenance', repair(), { parts: [{ name: 'Good part', quantity: '1', unitCost: '5' }, { name: 'Bad', quantity: '1' }] }).error, 'unit_cost_required');
  assert.equal(list().length, before);
});

test('removing a part from an event returns it to stock', () => {
  const { env, sam, add, list } = setup();
  const p = add('Purchase', purchase({ quantity: '2' })).data.entry;
  const r = add('Maintenance', repair(), { parts: [{ purchaseId: p.id, quantity: '2' }] }).data.entry;
  assert.equal(list().find((e) => e.id === p.id).stockStatus, 'Fitted');
  env.call('saveEntry', { token: sam, id: r.id, version: r.version, fields: repair(), parts: [] });
  assert.equal(list().find((e) => e.id === p.id).stockStatus, 'In stock');
  assert.equal(list().find((e) => e.id === p.id).remaining, 2);
});

test('a purchase cannot shrink below what is used, or be deleted while used', () => {
  const { env, sam, admin, add } = setup();
  const p = add('Purchase', purchase({ quantity: '4' })).data.entry;
  add('Maintenance', repair(), { parts: [{ purchaseId: p.id, quantity: '3' }] });
  assert.equal(env.call('saveEntry', { token: sam, id: p.id, version: 1, fields: purchase({ quantity: '2' }) }).error, 'quantity_below_used');
  assert.equal(env.call('saveEntry', { token: sam, id: p.id, version: 1, fields: purchase({ quantity: '3' }) }).ok, true);
  assert.equal(env.call('deleteEntry', { token: admin, id: p.id }).error, 'purchase_in_use');
});

// ---------- job cost ----------

test('invoice-total mode uses one figure; mixed currencies are kept apart', () => {
  const { add, get } = setup();
  const lump = add('Maintenance', repair({ costMode: 'lump', lumpSumCost: '250', labourCost: '999' })).data.entry;
  assert.deepEqual(get(lump.id).data.jobCost, { GBP: 250 }, 'labour is ignored in invoice mode');

  // UK parts (GBP) fitted with Ugandan labour (UGX)
  const mixed = add('Maintenance', repair({ currency: 'UGX', labourCost: '150000', otherCost: '20000' }), { parts: [
    { name: 'Part from UK', quantity: '2', unitCost: '30', currency: 'GBP' },
  ] }).data.entry;
  assert.deepEqual(get(mixed.id).data.jobCost, { UGX: 170000, GBP: 60 });
});

// ---------- deleting ----------

test('an admin deletes an entry (soft); its parts return to stock; users cannot', () => {
  const { env, admin, sam, add, get, list } = setup();
  const p = add('Purchase', purchase({ quantity: '2' })).data.entry;
  const r = add('Maintenance', repair(), { parts: [{ purchaseId: p.id, quantity: '2' }] }).data.entry;
  assert.equal(env.call('deleteEntry', { token: sam, id: r.id }).error, 'forbidden');
  assert.equal(env.call('deleteEntry', { token: admin, id: r.id }).ok, true);
  assert.equal(get(r.id).error, 'not_found');
  assert.equal(list().filter((e) => e.type === 'Maintenance').length, 0);
  assert.equal(list().find((e) => e.id === p.id).stockStatus, 'In stock', 'stock is back');
  assert.equal(env.call('deleteEntry', { token: admin, id: r.id }).error, 'not_found');
  const rows = env.sheets.Entries._rows.slice(1);
  assert.ok(rows.some((row) => row[0] === r.id), 'the row is still in the sheet (soft delete)');
  assert.ok(env.sheets.Audit._rows.slice(1).some((a) => a[3] === 'entry_deleted'));
});

// ---------- odometer ----------

test('an entry can raise the car odometer, but never lower it', () => {
  const { env, sam, car, add } = setup();
  const odo = () => env.call('getCar', { token: sam, id: car.id }).data.car.odometer;
  assert.equal(odo(), 50000);
  assert.equal(add('Issue', issue({ mileage: '51000' })).data.odometerUpdated, undefined, 'not unless asked');
  assert.equal(odo(), 50000);
  assert.equal(add('Issue', issue({ mileage: '51000' }), { updateOdometer: true }).data.odometerUpdated, true);
  assert.equal(odo(), 51000);
  assert.equal(add('Issue', issue({ mileage: '40000' }), { updateOdometer: true }).data.odometerUpdated, undefined);
  assert.equal(odo(), 51000);
});

// ---------- listing and reading ----------

test('the history is newest first and carries what the list needs', () => {
  const { add, list } = setup();
  add('Issue', issue({ date: '2025-01-05', title: 'Old' }));
  add('Issue', issue({ date: '2025-06-05', title: 'New' }));
  add('Purchase', purchase({ date: '2025-03-05', title: 'Middle' }));
  assert.deepEqual(list().map((e) => e.title), ['New', 'Middle', 'Old']);
});

test('listPurchases offers stock for the picker, counting an edited event\'s own parts as available', () => {
  const { env, sam, car, add } = setup();
  const a = add('Purchase', purchase({ title: 'A', quantity: '4' })).data.entry;
  add('Purchase', purchase({ title: 'Used up', quantity: '1' }));
  add('Issue', issue());
  const r = add('Maintenance', repair(), { parts: [{ purchaseId: a.id, quantity: '3' }, { name: 'Inline', quantity: '1', unitCost: '5' }] }).data.entry;
  const names = (res) => res.data.purchases.map((p) => p.name + ':' + p.available).sort();
  let res = env.call('listPurchases', { token: sam, carId: car.id });
  assert.deepEqual(names(res), ['A:1', 'Used up:1']);
  assert.equal(res.data.issues.length, 1);
  res = env.call('listPurchases', { token: sam, carId: car.id, eventId: r.id });
  assert.deepEqual(names(res), ['A:4', 'Inline:1', 'Used up:1']);
  assert.equal(res.data.purchases.find((p) => p.name === 'A').usedHere, 3);
});

// ---------- costs ----------

test('car costs count every cost once: a part bought earlier is not counted again when fitted', () => {
  const { env, sam, car, add, get } = setup();
  const pads = add('Purchase', purchase({ date: '2025-03-01', quantity: '1', unitCost: '60' })).data.entry;
  const rep = add('Maintenance', repair({ date: '2025-03-20', labourCost: '90' }), { parts: [{ purchaseId: pads.id, quantity: '1' }] }).data.entry;
  assert.deepEqual(get(rep.id).data.jobCost, { GBP: 150 }, 'job cost includes the part');
  const costs = env.call('getCarCosts', { token: sam, carId: car.id }).data.currencies;
  assert.equal(costs.length, 1);
  assert.equal(costs[0].total, 150, 'spend counts the pads once');
  assert.deepEqual(costs[0].categories, { parts: 60, labour: 90 });
  assert.equal(costs[0].years[0].year, '2025');
});

test('car costs split by currency, year and category', () => {
  const { env, sam, car, add } = setup();
  add('Purchase', purchase({ date: '2024-05-01', quantity: '2', unitCost: '10', shippingCost: '4' }));          // GBP 24 parts, 2024
  add('Issue', issue({ date: '2025-01-02', cost: '25' }));                                                      // GBP 25 issues, 2025
  add('Compliance', { title: 'MOT', date: '2025-02-02', cost: '54.85' });                                       // GBP compliance, 2025
  add('Maintenance', repair({ date: '2025-03-03', costMode: 'lump', lumpSumCost: '300', currency: 'UGX' }));         // UGX invoice, 2025
  add('Maintenance', repair({ title: 'Service', date: '2025-04-04', labourCost: '80', otherCost: '15' }));      // GBP labour 80 + other 15, 2025
  const costs = env.call('getCarCosts', { token: sam, carId: car.id }).data.currencies;
  const gbp = costs.find((c) => c.currency === 'GBP');
  const ugx = costs.find((c) => c.currency === 'UGX');
  assert.equal(gbp.total, 198.85);
  assert.deepEqual(gbp.categories, { parts: 24, issues: 25, compliance: 54.85, labour: 80, other: 15 });
  assert.deepEqual(gbp.years.map((y) => [y.year, y.total]), [['2025', 174.85], ['2024', 24]]);
  assert.equal(ugx.total, 300);
  assert.deepEqual(ugx.categories, { invoices: 300 });
});

test('a car with no costs has an empty summary; deleted cars are admin-only', () => {
  const { env, admin, sam, car } = setup();
  assert.deepEqual(env.call('getCarCosts', { token: sam, carId: car.id }).data.currencies, []);
  env.call('deleteCar', { token: admin, id: car.id });
  assert.equal(env.call('getCarCosts', { token: sam, carId: car.id }).error, 'not_found');
});

// ---------- attachments ----------

test('photos and PDFs can be attached; only real JPEGs and PDFs within the limits', () => {
  const { env, sam, add, get, list } = setup();
  const e = add('Maintenance', repair()).data.entry;
  const up = (mime, data, name) => env.call('uploadAttachment', { token: sam, entryId: e.id, mime, data, filename: name });
  const photo = up('image/jpeg', jpeg(3000), 'receipt.jpg');
  assert.equal(photo.ok, true);
  const doc = up('application/pdf', pdf(5000), 'invoice');
  assert.equal(doc.ok, true);
  assert.equal(doc.data.attachment.filename, 'invoice.pdf');
  assert.equal(get(e.id).data.attachments.length, 2);
  assert.equal(list().find((x) => x.id === e.id).attachmentCount, 2);

  assert.equal(up('image/png', jpeg(100), 'x.png').error, 'invalid_attachment');
  assert.equal(up('image/jpeg', pdf(100), 'x.jpg').error, 'invalid_photo', 'a PDF pretending to be a JPEG');
  assert.equal(up('application/pdf', jpeg(100), 'x.pdf').error, 'invalid_attachment', 'a JPEG pretending to be a PDF');
  assert.equal(up('application/pdf', '', 'x.pdf').error, 'invalid_attachment');
  assert.equal(up('image/jpeg', jpeg(1500001), 'big.jpg').error, 'photo_too_large');
  assert.equal(up('application/pdf', pdf(2500001), 'big.pdf').error, 'attachment_too_large');
  assert.equal(up('application/pdf', pdf(2500000), 'edge.pdf').ok, true, 'exactly at the limit');
  assert.equal(env.call('uploadAttachment', { token: sam, entryId: 'nope', mime: 'image/jpeg', data: jpeg(100) }).error, 'not_found');
});

test('an entry takes at most 10 attachments', () => {
  const { env, sam, add } = setup();
  const e = add('Issue', issue()).data.entry;
  for (let i = 0; i < 10; i++) assert.equal(env.call('uploadAttachment', { token: sam, entryId: e.id, mime: 'image/jpeg', data: jpeg(200), filename: 'p' + i }).ok, true);
  assert.equal(env.call('uploadAttachment', { token: sam, entryId: e.id, mime: 'image/jpeg', data: jpeg(200) }).error, 'too_many_attachments');
});

test('attachments are read back through the record, and only admins remove them', () => {
  const { env, admin, sam, add, get } = setup();
  const e = add('Purchase', purchase()).data.entry;
  const data = pdf(4000);
  const a = env.call('uploadAttachment', { token: sam, entryId: e.id, mime: 'application/pdf', data, filename: 'receipt.pdf' }).data.attachment;
  const back = env.call('getAttachment', { token: sam, id: a.id }).data;
  assert.equal(back.data, data);
  assert.equal(back.mime, 'application/pdf');
  assert.equal(back.filename, 'receipt.pdf');
  assert.equal(env.call('getAttachment', { token: sam, id: 'nope' }).error, 'not_found');
  assert.equal(env.call('getAttachment', { token: sam, id: a.id, fileId: 'logs' }).data.data, data, 'a file id from the caller is ignored');

  assert.equal(env.call('deleteAttachment', { token: sam, id: a.id }).error, 'forbidden');
  assert.equal(env.call('deleteAttachment', { token: admin, id: a.id }).ok, true);
  assert.equal(env.call('getAttachment', { token: sam, id: a.id }).error, 'not_found');
  assert.equal(get(e.id).data.attachments.length, 0);
  assert.ok(Object.values(env.files).some((f) => f.trashed), 'file moved to the Drive trash');
  assert.equal(env.call('deleteAttachment', { token: admin, id: a.id }).error, 'not_found');
});

test('attachments of a deleted entry cannot be read', () => {
  const { env, admin, sam, add } = setup();
  const e = add('Issue', issue()).data.entry;
  const a = env.call('uploadAttachment', { token: sam, entryId: e.id, mime: 'image/jpeg', data: jpeg(300) }).data.attachment;
  env.call('deleteEntry', { token: admin, id: e.id });
  assert.equal(env.call('getAttachment', { token: sam, id: a.id }).error, 'not_found');
  assert.equal(env.call('uploadAttachment', { token: sam, entryId: e.id, mime: 'image/jpeg', data: jpeg(300) }).error, 'not_found');
});

// ---------- audit + schema ----------

test('entry changes are audited, and the schema migration adds the expiry column', () => {
  const { env, sam, add } = setup();
  const e = add('Issue', issue()).data.entry;
  env.call('saveEntry', { token: sam, id: e.id, version: 1, fields: issue({ title: 'Changed' }) });
  env.call('uploadAttachment', { token: sam, entryId: e.id, mime: 'image/jpeg', data: jpeg(300) });
  const actions = env.sheets.Audit._rows.slice(1).map((r) => r[3]);
  ['entry_created', 'entry_updated', 'attachment_added'].forEach((a) => assert.ok(actions.includes(a), a));

  const header = env.sheets.Entries._rows[0];
  header.splice(header.indexOf('expiry_date'), 1);
  env.props.SCHEMA_VERSION = '5';
  assert.equal(env.call('listEntries', { token: sam, carId: e.carId }).ok, true);
  assert.ok(env.sheets.Entries._rows[0].includes('expiry_date'));
  assert.equal(env.props.SCHEMA_VERSION, String(vm.runInContext('SCHEMA_VERSION', env.ctx)));
});

// ---------- mileage unit and a currency for each cost ----------

test('a reading carries its own unit (miles or km), defaulting to the car\'s', () => {
  const { add, get } = setup();
  const def = add('Issue', issue({ mileage: '51000' })).data.entry;
  assert.equal(def.mileageUnit, 'mi', 'the car is in miles');
  const km = add('Issue', issue({ mileage: '82000', mileageUnit: 'km' })).data.entry;
  assert.equal(km.mileageUnit, 'km');
  assert.equal(get(km.id).data.entry.mileageUnit, 'km');
  const none = add('Issue', issue({ mileage: '', mileageUnit: 'km' })).data.entry;
  assert.equal(none.mileageUnit, '', 'no reading, no unit');
  assert.equal(add('Issue', issue({ mileage: '5', mileageUnit: 'furlongs' })).error, 'invalid_unit');
});

test('a reading in the other unit is converted into the car\'s unit when it raises the odometer', () => {
  const { env, sam, car, add } = setup();
  const odo = () => env.call('getCar', { token: sam, id: car.id }).data.car.odometer;
  // the car is in miles at 50,000. 90,000 km is 55,923 miles (rounded)
  assert.equal(add('Issue', issue({ mileage: '90000', mileageUnit: 'km' })).data.odometerUpdated, undefined, 'not unless asked');
  assert.equal(odo(), 50000);
  assert.equal(add('Issue', issue({ mileage: '90000', mileageUnit: 'km' }), { updateOdometer: true }).data.odometerUpdated, true);
  assert.equal(odo(), 55923);
  // 40,000 km is about 24,855 miles: lower than the odometer, so it is left alone
  assert.equal(add('Issue', issue({ mileage: '40000', mileageUnit: 'km' }), { updateOdometer: true }).data.odometerUpdated, undefined);
  assert.equal(odo(), 55923);
  // a reading already in the car's unit works as before
  assert.equal(add('Issue', issue({ mileage: '56000', mileageUnit: 'mi' }), { updateOdometer: true }).data.odometerUpdated, true);
  assert.equal(odo(), 56000);
  // the entry itself keeps what was typed
  const e = add('Issue', issue({ mileage: '100000', mileageUnit: 'km' })).data.entry;
  assert.equal(e.mileage, 100000);
  assert.equal(e.mileageUnit, 'km');
  assert.ok(env.sheets.Audit._rows.slice(1).some((r) => /converted from 90000 km/.test(r[6])));
});

test('distance conversion is exact enough, symmetric on whole numbers, and never touches money', () => {
  const { env } = setup();
  const conv = vm.runInContext('convertDistance_', env.ctx);
  assert.equal(conv(50000, 'mi', 'km'), 80467);
  assert.equal(conv(80467, 'km', 'mi'), 50000);
  assert.equal(conv(131000, 'km', 'mi'), 81400);
  assert.equal(conv(100, 'mi', 'mi'), 100);
  assert.equal(conv(0, 'km', 'mi'), 0);
  assert.ok(Number.isNaN(conv('abc', 'km', 'mi')));
});

test('labour, other costs and an invoice total each keep their own currency', () => {
  const { add, get, list } = setup();
  const r = add('Maintenance', repair({
    labourCost: '150000', labourCurrency: 'UGX', otherCost: '25', otherCurrency: 'USD', currency: 'UGX',
  }), { parts: [{ name: 'UK part', quantity: '1', unitCost: '40', currency: 'GBP' }] }).data.entry;
  assert.equal(r.labourCurrency, 'UGX');
  assert.equal(r.otherCurrency, 'USD');
  assert.deepEqual(get(r.id).data.jobCost, { UGX: 150000, USD: 25, GBP: 40 });
  assert.deepEqual(list().find((e) => e.id === r.id).jobCost, { UGX: 150000, USD: 25, GBP: 40 });

  const lump = add('Maintenance', repair({ costMode: 'lump', lumpSumCost: '300', lumpCurrency: 'KES', currency: 'KES' })).data.entry;
  assert.equal(lump.lumpCurrency, 'KES');
  assert.deepEqual(get(lump.id).data.jobCost, { KES: 300 });
});

test('a cost with no amount stores no currency; a bad currency is refused', () => {
  const { env, add } = setup();
  const e = add('Maintenance', repair({ labourCost: '', otherCost: '', labourCurrency: 'USD' })).data.entry;
  const row = env.sheets.Entries._rows.find((r) => r[0] === e.id);
  const header = env.sheets.Entries._rows[0];
  assert.equal(row[header.indexOf('labour_currency')], '');
  assert.equal(add('Maintenance', repair({ labourCurrency: 'XYZ' })).error, 'invalid_currency');
  assert.equal(add('Maintenance', repair({ otherCost: '5', otherCurrency: 'XYZ' })).error, 'invalid_currency');
  assert.equal(add('Maintenance', repair({ costMode: 'lump', lumpSumCost: '5', lumpCurrency: 'XYZ' })).error, 'invalid_currency');
});

test('when no separate currency is given, every cost uses the entry currency', () => {
  const { add, get } = setup();
  const e = add('Maintenance', repair({ currency: 'UGX', labourCost: '100', otherCost: '20' })).data.entry;
  assert.equal(e.labourCurrency, 'UGX');
  assert.equal(e.otherCurrency, 'UGX');
  assert.deepEqual(get(e.id).data.jobCost, { UGX: 120 });
});

test('entries saved before these fields existed still work (they fall back to the entry currency and the car unit)', () => {
  const { env, sam, car, add, get, list } = setup();
  const e = add('Maintenance', repair({ currency: 'GBP', labourCost: '90', otherCost: '10', mileage: '50100' })).data.entry;
  // simulate an old row: the new columns were empty
  const header = env.sheets.Entries._rows[0];
  const row = env.sheets.Entries._rows.find((r) => r[0] === e.id);
  ['labour_currency', 'other_currency', 'lump_currency', 'mileage_unit'].forEach((k) => { row[header.indexOf(k)] = ''; });
  assert.deepEqual(get(e.id).data.jobCost, { GBP: 100 });
  assert.equal(get(e.id).data.entry.labourCurrency, 'GBP');
  assert.equal(get(e.id).data.entry.mileageUnit, '', 'the app shows the car\'s unit for old readings');
  const costs = env.call('getCarCosts', { token: sam, carId: car.id }).data.currencies;
  assert.deepEqual(costs[0].categories, { labour: 90, other: 10 });
  assert.ok(list().find((x) => x.id === e.id));
});

test('car costs split each cost into its own currency', () => {
  const { env, sam, car, add } = setup();
  add('Maintenance', repair({ date: '2025-05-01', labourCost: '150000', labourCurrency: 'UGX', otherCost: '30', otherCurrency: 'GBP', currency: 'UGX' }));
  const costs = env.call('getCarCosts', { token: sam, carId: car.id }).data.currencies;
  const ugx = costs.find((c) => c.currency === 'UGX');
  const gbp = costs.find((c) => c.currency === 'GBP');
  assert.deepEqual(ugx.categories, { labour: 150000 });
  assert.deepEqual(gbp.categories, { other: 30 });
});

test('the schema migration adds the unit and currency columns', () => {
  const { env, sam, car } = setup();
  const header = env.sheets.Entries._rows[0];
  ['mileage_unit', 'labour_currency', 'other_currency', 'lump_currency'].forEach((k) => header.splice(header.indexOf(k), 1));
  env.props.SCHEMA_VERSION = '6';
  assert.equal(env.call('listEntries', { token: sam, carId: car.id }).ok, true);
  ['mileage_unit', 'labour_currency', 'other_currency', 'lump_currency'].forEach((k) => assert.ok(env.sheets.Entries._rows[0].includes(k), k));
});
