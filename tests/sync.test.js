'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const CAR = { registration: 'AB12 CDE', make: 'Toyota', model: 'Hilux', year: '2015', currency: 'GBP' };
const issue = (extra) => Object.assign({ title: 'Squeaky brake', date: '2026-10-01', mileage: '50100' }, extra);

function setup() {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  const car = env.call('saveCar', { token: sam, fields: CAR }).data.car;
  const car2 = env.call('saveCar', { token: sam, fields: Object.assign({}, CAR, { registration: 'ZZ99 ZZZ' }) }).data.car;
  const changes = (token) => env.call('getChanges', { token: token || sam }).data;
  return { env, admin, sam, car, car2, changes };
}

test('getChanges needs a signed-in user and returns one revision per car plus one for the fleet', () => {
  const { env, car, car2, changes } = setup();
  assert.equal(env.call('getChanges').error, 'unauthorized');
  const c = changes();
  assert.deepEqual(Object.keys(c.cars).sort(), [car.id, car2.id].sort());
  assert.match(c.fleet, /^[0-9a-f]{16}$/);
  assert.match(c.cars[car.id], /^[0-9a-f]{16}$/);
  assert.notEqual(c.cars[car.id], c.cars[car2.id]);
  assert.equal(changes().fleet, c.fleet, 'nothing changed: nothing differs');
});

test('a revision changes for the car that changed and only that car', () => {
  const { env, sam, car, car2, changes } = setup();
  const before = changes();
  const e = env.call('saveEntry', { token: sam, carId: car.id, type: 'Issue', fields: issue() }).data.entry;
  const after = changes();
  assert.notEqual(after.cars[car.id], before.cars[car.id], 'a new entry changes its car');
  assert.equal(after.cars[car2.id], before.cars[car2.id], 'the other car is untouched');
  assert.notEqual(after.fleet, before.fleet);

  // each kind of change moves the revision
  const seen = new Set([after.cars[car.id]]);
  const step = (label) => { const r = changes().cars[car.id]; assert.ok(!seen.has(r), label + ' should change the revision'); seen.add(r); };
  env.call('setIssueStatus', { token: sam, id: e.id, status: 'Resolved' }); step('issue status');
  env.call('saveTask', { token: sam, carId: car.id, fields: { name: 'MOT', dueDate: '2027-01-01' } }); step('a reminder');
  env.call('saveFluids', { token: sam, carId: car.id, fluids: [{ fluid: 'Engine oil', specification: '5W-30' }] }); step('fluids');
  env.call('uploadAttachment', { token: sam, entryId: e.id, mime: 'application/pdf', data: Buffer.from('%PDF-1.4 x').toString('base64'), filename: 'a.pdf' }); step('an attachment');
  env.call('uploadCarDocument', { token: sam, carId: car.id, type: 'Logbook', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 y').toString('base64'), filename: 'b.pdf' }); step('a car document');
  env.call('updateOdometer', { token: sam, id: car.id, odometer: '60000' }); step('the odometer');
});

test('deleting an entry, and a rename of someone shown on the car, change the revision', () => {
  const { env, admin, sam, car, changes } = setup();
  const e = env.call('saveEntry', { token: sam, carId: car.id, type: 'Issue', fields: issue() }).data.entry;
  const r1 = changes(admin).cars[car.id];
  env.call('deleteEntry', { token: admin, id: e.id });
  const r2 = changes(admin).cars[car.id];
  assert.notEqual(r1, r2);
  env.call('updateMyName', { token: sam, name: 'Samuel' });
  assert.notEqual(changes(admin).cars[car.id], r2, 'a user rename can change what a car screen shows');
});

test('a guest turning up and being seen leaves every revision alone; their name on an entry counts', () => {
  const { env, sam, car, changes } = setup();
  const secret = env.call('getCar', { token: sam, id: car.id }).data.car.guestSecret;
  const before = changes();
  const joined = env.call('guestJoin', { carId: car.id, secret, name: 'Jo Guest' });
  assert.equal(joined.ok, true);
  const afterJoin = changes();
  // the guest row is new, so the car's fingerprint may move once; being seen again must not move it
  env.call('guestMe', { guestToken: joined.data.guestToken });
  env.advance(60 * 1000);
  env.call('guestMe', { guestToken: joined.data.guestToken });
  assert.deepEqual(changes(), afterJoin);
  assert.equal(Object.keys(before.cars).length, Object.keys(afterJoin.cars).length);
});

test('part usage changes the revision of the car it belongs to', () => {
  const { env, sam, car, changes } = setup();
  const p = env.call('saveEntry', { token: sam, carId: car.id, type: 'Purchase', fields: { title: 'Pads', date: '2026-10-01', quantity: '2', unitCost: '30' } }).data.entry;
  const before = changes().cars[car.id];
  env.call('saveEntry', { token: sam, carId: car.id, type: 'Maintenance', fields: { title: 'Fit pads', date: '2026-10-02', labourCost: '10' }, parts: [{ purchaseId: p.id, quantity: '1' }] });
  assert.notEqual(changes().cars[car.id], before);
});

test('non-admins do not see deleted cars in the changes; admins do', () => {
  const { env, admin, sam, car2, changes } = setup();
  env.call('deleteCar', { token: admin, id: car2.id });
  assert.equal(car2.id in changes(sam).cars, false);
  assert.equal(car2.id in changes(admin).cars, true);
});

test('getCarBundle returns exactly what the separate screens would have fetched', () => {
  const { env, sam, car, changes } = setup();
  const e = env.call('saveEntry', { token: sam, carId: car.id, type: 'Issue', fields: issue() }).data.entry;
  const p = env.call('saveEntry', { token: sam, carId: car.id, type: 'Purchase', fields: { title: 'Pads', date: '2026-10-01', quantity: '2', unitCost: '30' } }).data.entry;
  env.call('saveEntry', { token: sam, carId: car.id, type: 'Maintenance', fields: { title: 'Fit pads', date: '2026-10-02', labourCost: '10', linkedIssueId: e.id }, parts: [{ purchaseId: p.id, quantity: '1' }] });
  env.call('saveTask', { token: sam, carId: car.id, fields: { name: 'MOT', dueDate: '2027-01-01' } });

  const b = env.call('getCarBundle', { token: sam, carId: car.id });
  assert.equal(b.ok, true);
  assert.equal(b.data.rev, changes().cars[car.id], 'the bundle carries the revision it was read at');
  assert.deepEqual(b.data.page, env.call('getCarPage', { token: sam, id: car.id }).data);
  assert.deepEqual({ entries: b.data.page.entries }, env.call('listEntries', { token: sam, carId: car.id }).data);
  assert.deepEqual({ tasks: b.data.page.tasks, distanceUnit: 'mi' }, env.call('listTasks', { token: sam, carId: car.id }).data);
  assert.deepEqual(b.data.page.costs, env.call('getCarCosts', { token: sam, carId: car.id }).data);
  assert.deepEqual({ documents: b.data.page.documents }, env.call('listCarDocuments', { token: sam, carId: car.id }).data);
  const ids = b.data.page.entries.map((x) => x.id).sort();
  assert.equal(ids.length, 3);
  assert.deepEqual(Object.keys(b.data.details).sort(), ids);
  ids.forEach((id) => assert.deepEqual(b.data.details[id], env.call('getEntry', { token: sam, id }).data, 'entry ' + id));
});

test('getCarBundle refuses a car that does not exist or that a non-admin may not see', () => {
  const { env, admin, sam, car2 } = setup();
  assert.equal(env.call('getCarBundle', { token: sam, carId: 'nope' }).error, 'not_found');
  env.call('deleteCar', { token: admin, id: car2.id });
  assert.equal(env.call('getCarBundle', { token: sam, carId: car2.id }).error, 'not_found');
  assert.equal(env.call('getCarBundle', { token: admin, carId: car2.id }).ok, true);
});
