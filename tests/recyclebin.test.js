'use strict';
// Deleted entries go to a recycle bin and can be restored for 30 days (admins).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const CAR = { registration: 'AB12 CDE', make: 'Toyota', model: 'Hilux', year: '2015', odometer: '50000' };
const DAY = 24 * 3600 * 1000;

function setup() {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  const car = env.call('saveCar', { token: sam, fields: CAR }).data.car;
  const entry = (type, fields, extra) => env.call('saveEntry', Object.assign({ token: sam, carId: car.id, type, fields: Object.assign({ title: type + ' one', date: '2026-10-05' }, fields || {}) }, extra || {}));
  const list = () => env.call('listEntries', { token: sam, carId: car.id }).data.entries;
  const bin = () => env.call('listDeletedEntries', { token: admin, carId: car.id }).data;
  return { env, admin, sam, car, entry, list, bin };
}

test('only an admin can delete, see the bin or restore', () => {
  const { env, admin, sam, car, entry, bin } = setup();
  const e = entry('Issue').data.entry;
  assert.equal(env.call('deleteEntry', { token: sam, id: e.id }).error, 'forbidden');
  assert.equal(env.call('listDeletedEntries', { token: sam, carId: car.id }).error, 'forbidden');
  assert.equal(env.call('restoreEntry', { token: sam, id: e.id }).error, 'forbidden');
  assert.equal(env.call('listDeletedEntries', { carId: car.id }).error, 'unauthorized');
  assert.equal(env.call('restoreEntry', { token: admin, id: e.id }).error, 'not_found'); // not deleted: nothing to restore
  assert.equal(bin().entries.length, 0);
});

test('a deleted entry leaves the log and the costs, sits in the bin with 30 days left, and comes back when restored', () => {
  const { env, admin, sam, car, entry, list, bin } = setup();
  const e = entry('Maintenance', { title: 'Brake job', labourCost: '80', costMode: 'itemised' }).data.entry;
  const keep = entry('Issue', { title: 'Noise' }).data.entry;
  const costBefore = env.call('getCarCosts', { token: sam, carId: car.id }).data;
  const del = env.call('deleteEntry', { token: admin, id: e.id });
  assert.equal(del.data.restorableDays, 30);
  assert.deepEqual(list().map((x) => x.id), [keep.id]);
  assert.notDeepEqual(env.call('getCarCosts', { token: sam, carId: car.id }).data, costBefore);
  assert.equal(env.call('getEntry', { token: sam, id: e.id }).error, 'not_found');
  const b = bin();
  assert.equal(b.days, 30);
  assert.equal(b.entries.length, 1);
  assert.equal(b.entries[0].title, 'Brake job');
  assert.equal(b.entries[0].ref, e.ref);
  assert.equal(b.entries[0].deletedBy, 'Admin One');
  assert.equal(b.entries[0].daysLeft, 30);
  const back = env.call('restoreEntry', { token: admin, id: e.id });
  assert.equal(back.data.entry.title, 'Brake job');
  assert.equal(back.data.entry.ref, e.ref); // it keeps its reference
  assert.equal(list().length, 2);
  assert.equal(bin().entries.length, 0);
  assert.deepEqual(env.call('getCarCosts', { token: sam, carId: car.id }).data, costBefore);
  // it can be edited again, and deleted again
  assert.ok(env.call('getEntry', { token: sam, id: e.id }).data.entry.version > 1);
  assert.equal(env.call('deleteEntry', { token: admin, id: e.id }).data.done, true);
});

test('the bin counts down, and an entry cannot be restored after 30 days (it leaves the bin)', () => {
  const { env, admin, car, entry, bin } = setup();
  const e = entry('Issue').data.entry;
  env.call('deleteEntry', { token: admin, id: e.id });
  env.advance(10 * DAY);
  assert.equal(bin().entries[0].daysLeft, 20);
  env.advance(19 * DAY + 3600 * 1000);
  assert.equal(bin().entries[0].daysLeft, 1);
  env.advance(2 * DAY); // (sessions last 30 days: sign in again)
  const again = env.signInAs('admin@example.com');
  assert.equal(env.call('listDeletedEntries', { token: again, carId: car.id }).data.entries.length, 0);
  assert.equal(env.call('restoreEntry', { token: again, id: e.id }).error, 'restore_expired');
  assert.equal(env.call('listEntries', { token: again, carId: car.id }).data.entries.length, 0);
});

test('restoring a maintenance entry takes its parts out of stock again, and is refused if they were used elsewhere meanwhile', () => {
  const { env, admin, sam, car, entry, list, bin } = setup();
  const p = entry('Purchase', { vendor: 'ECP' }, { items: [{ name: 'Pads', quantity: '2', unitCost: '30' }] }).data.entry;
  const itemId = env.call('getEntry', { token: sam, id: p.id }).data.items[0].id;
  const first = entry('Maintenance', { title: 'Job 1' }, { parts: [{ purchaseId: itemId, quantity: '2' }] }).data.entry;
  assert.equal(env.call('getEntry', { token: sam, id: p.id }).data.stock.remaining, 0);
  env.call('deleteEntry', { token: admin, id: first.id });
  assert.equal(env.call('getEntry', { token: sam, id: p.id }).data.stock.remaining, 2); // back in stock while deleted
  const second = entry('Maintenance', { title: 'Job 2' }, { parts: [{ purchaseId: itemId, quantity: '2' }] }).data.entry; // used again
  assert.equal(env.call('restoreEntry', { token: admin, id: first.id }).error, 'not_enough_stock');
  assert.equal(bin().entries.length, 1);
  env.call('deleteEntry', { token: admin, id: second.id });
  assert.equal(env.call('restoreEntry', { token: admin, id: first.id }).data.entry.title, 'Job 1');
  assert.equal(env.call('getEntry', { token: sam, id: p.id }).data.stock.remaining, 0);
  assert.equal(list().length, 2);
});

test('a purchase whose items were used cannot be deleted; one that was not can be restored with its items', () => {
  const { env, admin, sam, entry, list } = setup();
  const p = entry('Purchase', {}, { items: [{ name: 'Pads', quantity: '2', unitCost: '30' }, { name: 'Discs', quantity: '2', unitCost: '45' }] }).data.entry;
  const items = env.call('getEntry', { token: sam, id: p.id }).data.items;
  entry('Maintenance', { title: 'Fit' }, { parts: [{ purchaseId: items[0].id, quantity: '1' }] });
  assert.equal(env.call('deleteEntry', { token: admin, id: p.id }).error, 'purchase_in_use');
  const q = entry('Purchase', {}, { items: [{ name: 'Bulb', quantity: '1', unitCost: '3' }, { name: 'Fuse', quantity: '1', unitCost: '1' }] }).data.entry;
  env.call('deleteEntry', { token: admin, id: q.id });
  env.call('restoreEntry', { token: admin, id: q.id });
  assert.equal(env.call('getEntry', { token: sam, id: q.id }).data.items.length, 2);
  assert.equal(list().length, 3);
});

test('an entry deleted before the bin existed (no deletion time) is still restorable for 30 days from when it was changed', () => {
  const { env, admin, entry, bin } = setup();
  const e = entry('Issue').data.entry;
  env.call('deleteEntry', { token: admin, id: e.id });
  const Db = require('vm').runInContext('Db', env.ctx);
  Db.update('Entries', Db.all('Entries').filter((x) => x.id === e.id)[0]._row, { deleted_at: '' });
  assert.equal(bin().entries.length, 1);
  assert.equal(env.call('restoreEntry', { token: admin, id: e.id }).data.entry.id, e.id);
});

test('a phone is told the car changed when an entry is deleted and again when it is restored', () => {
  const { env, admin, sam, car, entry } = setup();
  const e = entry('Issue').data.entry;
  const rev = () => env.call('getChanges', { token: sam }).data.cars[car.id];
  const r0 = rev();
  env.call('deleteEntry', { token: admin, id: e.id });
  const r1 = rev();
  env.call('restoreEntry', { token: admin, id: e.id });
  const r2 = rev();
  assert.notEqual(r0, r1);
  assert.notEqual(r1, r2);
  assert.notEqual(r0, r2); // the version number moved on
});

test('several entries can be deleted at once (admins); one that cannot be is reported and the rest still go to the bin', () => {
  const { env, admin, sam, car, entry, list, bin } = setup();
  const a = entry('Issue', { title: 'A' }).data.entry;
  const b = entry('Maintenance', { title: 'B', labourCost: '10', costMode: 'itemised' }).data.entry;
  const keep = entry('Issue', { title: 'Keep' }).data.entry;
  const p = entry('Purchase', { vendor: 'ECP' }, { items: [{ name: 'Pads', quantity: '2', unitCost: '30' }] }).data.entry;
  const itemId = env.call('getEntry', { token: sam, id: p.id }).data.items[0].id;
  entry('Maintenance', { title: 'Fit' }, { parts: [{ purchaseId: itemId, quantity: '1' }] }); // the purchase is now in use
  assert.equal(env.call('deleteEntries', { token: sam, ids: [a.id] }).error, 'forbidden');
  assert.equal(env.call('deleteEntries', { token: admin, ids: [] }).error, 'not_found');
  const r = env.call('deleteEntries', { token: admin, ids: [a.id, b.id, p.id, 'nope'] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.deleted, 2);
  assert.deepEqual(r.data.failed, [{ id: p.id, error: 'purchase_in_use' }, { id: 'nope', error: 'not_found' }]);
  assert.equal(list().length, 3, 'Keep, the purchase that is in use, and the maintenance that used it');
  assert.deepEqual(bin().entries.map((x) => x.title).sort(), ['A', 'B']);
  assert.ok(list().some((x) => x.id === keep.id));
  // a restore brings one back
  assert.equal(env.call('restoreEntry', { token: admin, id: a.id }).ok, true);
});
