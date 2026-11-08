'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { createEnv } = require('./harness');

function setup() {
  const env = createEnv();
  const adminU = env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  const samU = env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const annU = env.seedUser({ name: 'Ann', email: 'ann@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  const ann = env.signInAs('ann@example.com');
  const mk = (reg) => env.call('saveCar', { token: sam, fields: { registration: reg, make: 'Toyota', model: 'Hilux', year: '2015' } }).data.car;
  return { env, admin, sam, ann, adminU, samU, annU, car1: mk('CAR1'), car2: mk('CAR2') };
}

const owners = (env, token, car) => env.call('getCar', { token, id: car.id }).data.people.owners.map((x) => x.name);
const liveRows = (env) => env.sheets.CarPeople._rows.slice(1).filter((r) => r[6] !== 'TRUE');

test('people actions need a session; setCarPeople needs an admin', () => {
  const { env, sam, car1 } = setup();
  assert.equal(env.call('getUserCars').error, 'unauthorized');
  assert.equal(env.call('saveUserCars', { cars: [] }).error, 'unauthorized');
  assert.equal(env.call('setMyCarRole', { carId: car1.id, owner: true }).error, 'unauthorized');
  assert.equal(env.call('setCarPeople', { token: sam, carId: car1.id, people: [] }).error, 'forbidden');
});

test('a user can mark themselves as the owner/custodian of a car; several people are allowed', () => {
  const { env, sam, ann, car1 } = setup();
  let r = env.call('setMyCarRole', { token: sam, carId: car1.id, owner: true });
  assert.deepEqual(r.data.people.owners.map((x) => x.name), ['Sam']);
  assert.equal('keepers' in r.data.people, false, 'there is no keeper role any more');
  r = env.call('setMyCarRole', { token: ann, carId: car1.id, owner: true });
  assert.deepEqual(r.data.people.owners.map((x) => x.name), ['Ann', 'Sam'], 'sorted by name');
  assert.deepEqual(owners(env, sam, car1), ['Ann', 'Sam']);
});

test('clearing and re-ticking reuses the same row (no duplicates)', () => {
  const { env, sam, car1 } = setup();
  env.call('setMyCarRole', { token: sam, carId: car1.id, owner: true });
  env.call('setMyCarRole', { token: sam, carId: car1.id, owner: false });
  assert.deepEqual(owners(env, sam, car1), []);
  env.call('setMyCarRole', { token: sam, carId: car1.id, owner: true });
  assert.equal(owners(env, sam, car1).length, 1);
  assert.equal(env.sheets.CarPeople._rows.length, 2, 'header + one row');
});

test('setMyCarRole rejects unknown or deleted cars', () => {
  const { env, admin, sam, car1 } = setup();
  assert.equal(env.call('setMyCarRole', { token: sam, carId: 'nope', owner: true }).error, 'not_found');
  env.call('deleteCar', { token: admin, id: car1.id });
  assert.equal(env.call('setMyCarRole', { token: sam, carId: car1.id, owner: true }).error, 'not_found');
});

test('getUserCars lists every car with my status; saveUserCars replaces it', () => {
  const { env, sam, car1, car2 } = setup();
  const by = (res) => Object.fromEntries(res.data.cars.map((c) => [c.registration, c.owner]));
  let r = env.call('saveUserCars', { token: sam, cars: [{ carId: car1.id, owner: true }, { carId: car2.id, owner: true }] });
  assert.equal(r.ok, true);
  assert.deepEqual(by(r), { CAR1: true, CAR2: true });
  // CAR2 left out entirely: its link is removed
  r = env.call('saveUserCars', { token: sam, cars: [{ carId: car1.id, owner: true }] });
  assert.deepEqual(by(r), { CAR1: true, CAR2: false });
  assert.deepEqual(by(env.call('getUserCars', { token: sam })), { CAR1: true, CAR2: false });
});

test('only a real true counts, and unknown cars are rejected', () => {
  const { env, sam, car1 } = setup();
  const r = env.call('saveUserCars', { token: sam, cars: [{ carId: car1.id, owner: 'true' }] });
  assert.deepEqual(r.data.cars.map((c) => c.owner), [false, false]);
  assert.equal(env.call('saveUserCars', { token: sam, cars: [{ carId: 'nope', owner: true }] }).error, 'not_found');
  assert.equal(env.call('saveUserCars', { token: sam, cars: 'x' }).error, 'invalid_input');
});

test("users can only change their own links; admins can change anyone's", () => {
  const { env, admin, sam, annU, samU, car1 } = setup();
  assert.equal(env.call('getUserCars', { token: sam, userId: annU.id }).error, 'forbidden');
  assert.equal(env.call('saveUserCars', { token: sam, userId: annU.id, cars: [{ carId: car1.id, owner: true }] }).error, 'forbidden');
  const r = env.call('saveUserCars', { token: admin, userId: samU.id, cars: [{ carId: car1.id, owner: true }] });
  assert.equal(r.ok, true);
  assert.equal(r.data.user.name, 'Sam');
  assert.deepEqual(owners(env, sam, car1), ['Sam']);
  assert.equal(env.call('getUserCars', { token: admin, userId: 'nope' }).error, 'not_found');
});

test('pending or revoked users cannot be given cars', () => {
  const { env, admin, car1 } = setup();
  const pending = env.seedUser({ email: 'new@example.com', status: 'Pending', name: 'New' });
  assert.equal(env.call('saveUserCars', { token: admin, userId: pending.id, cars: [{ carId: car1.id, owner: true }] }).error, 'not_found');
  assert.equal(env.call('setCarPeople', { token: admin, carId: car1.id, people: [{ userId: pending.id, owner: true }] }).error, 'not_found');
});

test('admin sets all owners/custodians of a car at once', () => {
  const { env, admin, samU, annU, car1 } = setup();
  let r = env.call('setCarPeople', { token: admin, carId: car1.id, people: [{ userId: samU.id, owner: true }, { userId: annU.id, owner: true }] });
  assert.deepEqual(r.data.people.owners.map((x) => x.name), ['Ann', 'Sam']);
  // Sam left out: removed
  r = env.call('setCarPeople', { token: admin, carId: car1.id, people: [{ userId: annU.id, owner: true }] });
  assert.deepEqual(r.data.people.owners.map((x) => x.name), ['Ann']);
  assert.equal(env.call('setCarPeople', { token: admin, carId: 'nope', people: [] }).error, 'not_found');
  assert.equal(env.call('setCarPeople', { token: admin, carId: car1.id, people: 'x' }).error, 'invalid_input');
});

test('the fleet list marks my cars', () => {
  const { env, sam, ann, car1 } = setup();
  env.call('setMyCarRole', { token: sam, carId: car1.id, owner: true });
  assert.deepEqual(env.call('listCars', { token: sam }).data.mine, { [car1.id]: { owner: true } });
  assert.deepEqual(env.call('listCars', { token: ann }).data.mine, {}, 'other users see none');
});

test('rows from the earlier "registered keeper" role are read as owner/custodian and tidied up', () => {
  const { env, sam, samU, annU, car1, car2 } = setup();
  const now = new Date().toISOString();
  const db = vm.runInContext('Db', env.ctx);
  const legacy = (carId, userId, role) => db.insert('CarPeople', {
    id: Math.random().toString(36).slice(2), created_at: now, created_by: 'x', updated_at: now, updated_by: 'x', version: 1,
    deleted: false, car_id: carId, user_id: userId, role,
  });
  legacy(car1.id, samU.id, 'keeper');
  legacy(car1.id, samU.id, 'owner');          // had both roles: still one person
  legacy(car2.id, annU.id, 'keeper');

  assert.deepEqual(owners(env, sam, car1), ['Sam'], 'listed once');
  assert.deepEqual(owners(env, sam, car2), ['Ann']);
  assert.deepEqual(env.call('listCars', { token: sam }).data.mine, { [car1.id]: { owner: true } });
  assert.equal(env.call('getUserCars', { token: sam }).data.cars.find((c) => c.carId === car1.id).owner, true);

  assert.equal(liveRows(env).filter((r) => r[8] === samU.id && r[7] === car1.id && r[9] === 'keeper').length, 1, 'legacy keeper row is live before');
  // ticking tidies the old keeper row; unticking removes every live row
  env.call('setMyCarRole', { token: sam, carId: car1.id, owner: true });
  assert.equal(liveRows(env).filter((r) => r[8] === samU.id && r[7] === car1.id && r[9] === 'keeper').length, 0, 'old keeper row retired');
  env.call('setMyCarRole', { token: sam, carId: car1.id, owner: false });
  assert.deepEqual(owners(env, sam, car1), []);
  assert.equal(liveRows(env).filter((r) => r[8] === samU.id && r[7] === car1.id).length, 0, 'no live rows left for that car');
});

test('an owner/custodian who is not an app user can be written on the car', () => {
  const { env, sam } = setup();
  const fields = { registration: 'EXT1', make: 'Ford', model: 'Ranger', year: '2018', ownerOther: '  Acme   Trading Ltd ' };
  const car = env.call('saveCar', { token: sam, fields }).data.car;
  assert.equal(car.ownerOther, 'Acme Trading Ltd');
  assert.equal('keeperOther' in car, false);
  const upd = env.call('saveCar', { token: sam, id: car.id, version: 1, fields: Object.assign({}, fields, { ownerOther: '' }) });
  assert.equal(upd.data.car.ownerOther, '');
});

test('people changes are audited, and the new tab is created by migration', () => {
  const { env, admin, sam, samU, car1 } = setup();
  env.call('setMyCarRole', { token: sam, carId: car1.id, owner: true });
  env.call('saveUserCars', { token: sam, cars: [] });
  env.call('setCarPeople', { token: admin, carId: car1.id, people: [{ userId: samU.id, owner: true }] });
  const rows = env.sheets.Audit._rows.slice(1).filter((r) => r[3] === 'people_changed');
  assert.equal(rows.length, 3);
  assert.match(rows[1][6], /Sam: no cars/);
  assert.match(rows[2][6], /owners\/custodians Sam/);

  delete env.sheets.CarPeople;
  env.props.SCHEMA_VERSION = '4';
  assert.equal(env.call('listCars', { token: sam }).ok, true);
  assert.deepEqual(env.sheets.CarPeople._rows[0].slice(-3), ['car_id', 'user_id', 'role']);
  assert.equal(env.props.SCHEMA_VERSION, String(vm.runInContext('SCHEMA_VERSION', env.ctx)));
});
