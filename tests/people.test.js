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

const people = (env, token, car) => env.call('getCar', { token, id: car.id }).data.people;

test('people actions need a session; setCarPeople needs an admin', () => {
  const { env, sam, car1 } = setup();
  assert.equal(env.call('getUserCars').error, 'unauthorized');
  assert.equal(env.call('saveUserCars', { cars: [] }).error, 'unauthorized');
  assert.equal(env.call('setMyCarRole', { carId: car1.id, owner: true }).error, 'unauthorized');
  assert.equal(env.call('setCarPeople', { token: sam, carId: car1.id, people: [] }).error, 'forbidden');
});

test('a user can mark themselves as owner and/or registered keeper of a car', () => {
  const { env, sam, ann, car1 } = setup();
  let r = env.call('setMyCarRole', { token: sam, carId: car1.id, owner: true, keeper: false });
  assert.deepEqual(r.data.people.owners.map((x) => x.name), ['Sam']);
  assert.deepEqual(r.data.people.keepers, []);
  r = env.call('setMyCarRole', { token: ann, carId: car1.id, owner: true, keeper: true });
  assert.deepEqual(r.data.people.owners.map((x) => x.name), ['Ann', 'Sam'], 'several owners, sorted');
  assert.deepEqual(r.data.people.keepers.map((x) => x.name), ['Ann']);
  assert.deepEqual(people(env, sam, car1).owners.map((x) => x.name), ['Ann', 'Sam']);
});

test('clearing and re-ticking reuses the same row (no duplicates)', () => {
  const { env, sam, car1 } = setup();
  env.call('setMyCarRole', { token: sam, carId: car1.id, owner: true });
  env.call('setMyCarRole', { token: sam, carId: car1.id, owner: false });
  assert.deepEqual(people(env, sam, car1).owners, []);
  env.call('setMyCarRole', { token: sam, carId: car1.id, owner: true });
  assert.equal(people(env, sam, car1).owners.length, 1);
  assert.equal(env.sheets.CarPeople._rows.length, 2, 'header + one row');
});

test('setMyCarRole rejects unknown or deleted cars', () => {
  const { env, admin, sam, car1 } = setup();
  assert.equal(env.call('setMyCarRole', { token: sam, carId: 'nope', owner: true }).error, 'not_found');
  env.call('deleteCar', { token: admin, id: car1.id });
  assert.equal(env.call('setMyCarRole', { token: sam, carId: car1.id, owner: true }).error, 'not_found');
});

test('getUserCars lists every car with my roles; saveUserCars replaces them', () => {
  const { env, sam, car1, car2 } = setup();
  let r = env.call('saveUserCars', { token: sam, cars: [{ carId: car1.id, owner: true }, { carId: car2.id, keeper: true }] });
  assert.equal(r.ok, true);
  const by = (res) => Object.fromEntries(res.data.cars.map((c) => [c.registration, [c.owner, c.keeper]]));
  assert.deepEqual(by(r), { CAR1: [true, false], CAR2: [false, true] });

  // CAR2 left out entirely: its link is removed. CAR1 gains keeper.
  r = env.call('saveUserCars', { token: sam, cars: [{ carId: car1.id, owner: true, keeper: true }] });
  assert.deepEqual(by(r), { CAR1: [true, true], CAR2: [false, false] });
  assert.deepEqual(by(env.call('getUserCars', { token: sam })), { CAR1: [true, true], CAR2: [false, false] });
});

test('only real booleans count, and unknown cars are rejected', () => {
  const { env, sam, car1 } = setup();
  const r = env.call('saveUserCars', { token: sam, cars: [{ carId: car1.id, owner: 'true', keeper: 1 }] });
  assert.deepEqual(r.data.cars.map((c) => [c.owner, c.keeper]), [[false, false], [false, false]]);
  assert.equal(env.call('saveUserCars', { token: sam, cars: [{ carId: 'nope', owner: true }] }).error, 'not_found');
  assert.equal(env.call('saveUserCars', { token: sam, cars: 'x' }).error, 'invalid_input');
});

test('users can only change their own links; admins can change anyone\'s', () => {
  const { env, admin, sam, annU, samU, car1 } = setup();
  assert.equal(env.call('getUserCars', { token: sam, userId: annU.id }).error, 'forbidden');
  assert.equal(env.call('saveUserCars', { token: sam, userId: annU.id, cars: [{ carId: car1.id, owner: true }] }).error, 'forbidden');
  const r = env.call('saveUserCars', { token: admin, userId: samU.id, cars: [{ carId: car1.id, keeper: true }] });
  assert.equal(r.ok, true);
  assert.equal(r.data.user.name, 'Sam');
  assert.deepEqual(people(env, sam, car1).keepers.map((x) => x.name), ['Sam']);
  assert.equal(env.call('getUserCars', { token: admin, userId: 'nope' }).error, 'not_found');
});

test('pending or revoked users cannot be given cars', () => {
  const { env, admin, car1 } = setup();
  const pending = env.seedUser({ email: 'new@example.com', status: 'Pending', name: 'New' });
  assert.equal(env.call('saveUserCars', { token: admin, userId: pending.id, cars: [{ carId: car1.id, owner: true }] }).error, 'not_found');
  assert.equal(env.call('setCarPeople', { token: admin, carId: car1.id, people: [{ userId: pending.id, owner: true }] }).error, 'not_found');
});

test('admin sets all owners and keepers of a car at once', () => {
  const { env, admin, samU, annU, car1 } = setup();
  let r = env.call('setCarPeople', { token: admin, carId: car1.id, people: [
    { userId: samU.id, owner: true }, { userId: annU.id, owner: true, keeper: true },
  ] });
  assert.deepEqual(r.data.people.owners.map((x) => x.name), ['Ann', 'Sam']);
  assert.deepEqual(r.data.people.keepers.map((x) => x.name), ['Ann']);
  // Sam left out: removed. Ann stays keeper only.
  r = env.call('setCarPeople', { token: admin, carId: car1.id, people: [{ userId: annU.id, keeper: true }] });
  assert.deepEqual(r.data.people.owners, []);
  assert.deepEqual(r.data.people.keepers.map((x) => x.name), ['Ann']);
  assert.equal(env.call('setCarPeople', { token: admin, carId: 'nope', people: [] }).error, 'not_found');
  assert.equal(env.call('setCarPeople', { token: admin, carId: car1.id, people: 'x' }).error, 'invalid_input');
});

test('the fleet list marks my cars', () => {
  const { env, sam, ann, car1, car2 } = setup();
  env.call('setMyCarRole', { token: sam, carId: car1.id, owner: true });
  env.call('setMyCarRole', { token: sam, carId: car2.id, keeper: true });
  assert.deepEqual(env.call('listCars', { token: sam }).data.mine, {
    [car1.id]: { owner: true, keeper: false },
    [car2.id]: { owner: false, keeper: true },
  });
  assert.deepEqual(env.call('listCars', { token: ann }).data.mine, {}, 'other users see none');
});

test('an owner or keeper who is not an app user can be written on the car', () => {
  const { env, sam } = setup();
  const fields = { registration: 'EXT1', make: 'Ford', model: 'Ranger', year: '2018', ownerOther: 'Acme Trading Ltd', keeperOther: '  Grace   Nakato ' };
  const car = env.call('saveCar', { token: sam, fields }).data.car;
  assert.equal(car.ownerOther, 'Acme Trading Ltd');
  assert.equal(car.keeperOther, 'Grace Nakato');
  const upd = env.call('saveCar', { token: sam, id: car.id, version: 1, fields: Object.assign({}, fields, { ownerOther: '' }) });
  assert.equal(upd.data.car.ownerOther, '');
  assert.equal(upd.data.car.keeperOther, 'Grace Nakato');
});

test('people changes are audited, and the new tab is created by migration', () => {
  const { env, admin, sam, samU, car1 } = setup();
  env.call('setMyCarRole', { token: sam, carId: car1.id, owner: true });
  env.call('saveUserCars', { token: sam, cars: [{ carId: car1.id, keeper: true }] });
  env.call('setCarPeople', { token: admin, carId: car1.id, people: [{ userId: samU.id, owner: true }] });
  const rows = env.sheets.Audit._rows.slice(1).filter((r) => r[3] === 'people_changed');
  assert.equal(rows.length, 3);
  assert.match(rows[1][6], /Sam: keeper of CAR1/);

  // a deploy that adds the CarPeople tab: the next request creates it
  delete env.sheets.CarPeople;
  env.props.SCHEMA_VERSION = '4';
  assert.equal(env.call('listCars', { token: sam }).ok, true);
  assert.deepEqual(env.sheets.CarPeople._rows[0].slice(-3), ['car_id', 'user_id', 'role']);
  assert.equal(env.props.SCHEMA_VERSION, String(vm.runInContext('SCHEMA_VERSION', env.ctx)));
});
