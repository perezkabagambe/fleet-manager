'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

function setup() {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  return { env, admin, sam };
}

const CAR = { registration: 'ab12 cde', make: 'Toyota', model: 'Land Cruiser', year: '2015', vin: 'jtmhv05j604123456', colour: 'White' };

function addCar(env, token, fields, extra) {
  return env.call('saveCar', Object.assign({ token, fields: Object.assign({}, CAR, fields || {}) }, extra || {}));
}

// ---------- access ----------

test('car actions need a session; delete and restore need an admin', () => {
  const { env, sam } = setup();
  assert.equal(env.call('listCars').error, 'unauthorized');
  assert.equal(env.call('saveCar', { fields: CAR }).error, 'unauthorized');
  const car = addCar(env, sam).data.car;
  assert.equal(env.call('deleteCar', { token: sam, id: car.id }).error, 'forbidden');
  assert.equal(env.call('restoreCar', { token: sam, id: car.id }).error, 'forbidden');
});

// ---------- create / validate ----------

test('any user can add a car; values are normalised', () => {
  const { env, sam } = setup();
  const r = addCar(env, sam);
  assert.equal(r.ok, true);
  assert.equal(r.data.saved, true);
  const c = r.data.car;
  assert.equal(c.registration, 'AB12 CDE');
  assert.equal(c.vin, 'JTMHV05J604123456');
  assert.equal(c.year, 2015);
  assert.equal(c.country, 'UK');
  assert.equal(c.currency, 'GBP');
  assert.equal(c.distanceUnit, 'mi');
  assert.equal(c.status, 'Active');
  assert.equal(c.version, 1);
  const list = env.call('listCars', { token: sam }).data;
  assert.equal(list.cars.length, 1);
  assert.deepEqual(list.deleted, []);
});

test('Uganda cars default to UGX and km', () => {
  const { env, sam } = setup();
  const c = addCar(env, sam, { country: 'UG', registration: 'UBA 123X' }).data.car;
  assert.equal(c.currency, 'UGX');
  assert.equal(c.distanceUnit, 'km');
});

test('required fields and formats are enforced', () => {
  const { env, sam } = setup();
  const bad = (fields, code) => assert.equal(addCar(env, sam, fields).error, code, code);
  bad({ registration: '  ' }, 'registration_required');
  bad({ make: '' }, 'make_required');
  bad({ model: '' }, 'model_required');
  bad({ year: '' }, 'year_required');
  bad({ year: '   ' }, 'year_required');
  bad({ year: '1850' }, 'invalid_year');
  bad({ year: 'abcd' }, 'invalid_year');
  bad({ vin: 'no good!' }, 'invalid_vin');
  bad({ country: 'FR' }, 'invalid_country');
  bad({ currency: 'XYZ' }, 'invalid_currency');
  bad({ distanceUnit: 'parsecs' }, 'invalid_unit');
  bad({ status: 'Stolen' }, 'invalid_status');
  bad({ odometer: '-5' }, 'invalid_odometer');
  bad({ odometer: '12.5' }, 'invalid_odometer');
  bad({ odometer: '99999999' }, 'invalid_odometer');
  assert.equal(env.call('listCars', { token: sam }).data.cars.length, 0);
});

test('acquisition cost and date are optional but validated', () => {
  const { env, sam } = setup();
  const none = addCar(env, sam, { registration: 'NOCOST1', vin: '' }).data.car;
  assert.equal(none.acquisitionCost, null);
  assert.equal(none.acquisitionDate, '');

  const ok = addCar(env, sam, { registration: 'COST1', vin: '', acquisitionCost: '£4,500.50', acquisitionDate: '2021-03-12' }).data.car;
  assert.equal(ok.acquisitionCost, 4500.5);
  assert.equal(ok.acquisitionDate, '2021-03-12');
  assert.equal(addCar(env, sam, { registration: 'COST2', vin: '', acquisitionCost: '0' }).data.car.acquisitionCost, 0);

  const bad = (fields, code) => assert.equal(addCar(env, sam, Object.assign({ registration: 'BAD' + Math.random(), vin: '' }, fields)).error, code, code);
  bad({ acquisitionCost: '-5' }, 'invalid_cost');
  bad({ acquisitionCost: '12.345' }, 'invalid_cost');
  bad({ acquisitionCost: 'lots' }, 'invalid_cost');
  bad({ acquisitionCost: '1'.repeat(13) }, 'invalid_cost');
  bad({ acquisitionDate: '2021-02-30' }, 'invalid_date');
  bad({ acquisitionDate: '31/02/2021' }, 'invalid_date');
  bad({ acquisitionDate: '12/13/2021' }, 'invalid_date');
  bad({ acquisitionDate: '2021-13' }, 'invalid_date');
  bad({ acquisitionDate: '13/2021' }, 'invalid_date');
  bad({ acquisitionDate: '1850' }, 'invalid_date');
  bad({ acquisitionDate: '2999' }, 'invalid_date');
  bad({ acquisitionDate: 'Mar 2999' }, 'invalid_date');
  bad({ acquisitionDate: '2999-01-01' }, 'invalid_date');
  bad({ acquisitionDate: 'next week' }, 'invalid_date');
  bad({ acquisitionDate: 'Marzipan 2021' }, 'invalid_date');
  bad({ acquisitionDate: '12 Foo 2021' }, 'invalid_date');
});

test('acquisition date accepts a year, a month and year, or a full date, and keeps the precision', () => {
  const { env, sam } = setup();
  const cases = [
    ['2021', '2021'],
    ['Mar 2021', '2021-03'],
    ['march 2021', '2021-03'],
    ['Sept 2019', '2019-09'],
    ['03/2021', '2021-03'],
    ['3/2021', '2021-03'],
    ['2021-03', '2021-03'],
    ['12/03/2021', '2021-03-12'],
    ['5.4.2020', '2020-04-05'],
    ['12 March 2021', '2021-03-12'],
    ['1st Jan 2018', '2018-01-01'],
    ['2021-03-12', '2021-03-12'],
    ['  12 Mar, 2021 ', '2021-03-12'],
  ];
  cases.forEach(([input, expected], i) => {
    const r = addCar(env, sam, { registration: 'DATE' + i, vin: '', acquisitionDate: input });
    assert.equal(r.data.car.acquisitionDate, expected, input);
  });
  // day-first (UK) reading: 03/04/2021 is 3 April
  assert.equal(addCar(env, sam, { registration: 'UKDAY', vin: '', acquisitionDate: '03/04/2021' }).data.car.acquisitionDate, '2021-04-03');
  // this year and this month are fine, later months of this year are not
  const now = new Date();
  assert.equal(addCar(env, sam, { registration: 'THISYR', vin: '', acquisitionDate: String(now.getFullYear()) }).ok, true);
  assert.equal(addCar(env, sam, { registration: 'NEXTYR', vin: '', acquisitionDate: String(now.getFullYear() + 1) }).error, 'invalid_date');
});

test('acquisition cost can be in GBP, UGX, USD or KES, independent of the car currency', () => {
  const { env, sam } = setup();
  // no currency given: falls back to the car's own currency
  const a = addCar(env, sam, { registration: 'CUR0', vin: '', country: 'UG', acquisitionCost: '1000' }).data.car;
  assert.equal(a.currency, 'UGX');
  assert.equal(a.acquisitionCurrency, 'UGX');
  // each supported currency, on a car running in UGX
  ['GBP', 'UGX', 'USD', 'KES'].forEach((cur, i) => {
    const c = addCar(env, sam, { registration: 'CUR' + (i + 1), vin: '', country: 'UG', acquisitionCost: '5000', acquisitionCurrency: cur }).data.car;
    assert.equal(c.currency, 'UGX');
    assert.equal(c.acquisitionCurrency, cur);
  });
  assert.equal(addCar(env, sam, { registration: 'CUR9', vin: '', acquisitionCost: '5000', acquisitionCurrency: 'XYZ' }).error, 'invalid_currency');
  // KES also works as a car currency
  assert.equal(addCar(env, sam, { registration: 'KESCAR', vin: '', currency: 'KES' }).data.car.currency, 'KES');
  // no cost means no stored currency; older cars read back as the car currency
  const none = addCar(env, sam, { registration: 'NOCUR', vin: '', acquisitionCurrency: 'USD' }).data.car;
  assert.equal(none.acquisitionCost, null);
  assert.equal(none.acquisitionCurrency, none.currency);
});

test('acquisition details can be added later and changes are audited', () => {
  const { env, sam } = setup();
  const car = addCar(env, sam).data.car;
  const r = env.call('saveCar', { token: sam, id: car.id, version: 1, fields: Object.assign({}, CAR, { acquisitionCost: '12000', acquisitionDate: '2019-06-01' }) });
  assert.equal(r.data.car.acquisitionCost, 12000);
  assert.equal(r.data.car.acquisitionDate, '2019-06-01');
  const row = env.sheets.Audit._rows.slice(1).find((x) => x[3] === 'car_updated');
  assert.match(row[6], /acquisition_cost/);
  const cleared = env.call('saveCar', { token: sam, id: car.id, version: 2, fields: CAR });
  assert.equal(cleared.data.car.acquisitionCost, null);
});

test('PartSouq link must be an https partsouq.com address', () => {
  const { env, sam } = setup();
  ['http://partsouq.com/x', 'https://evil.example/partsouq.com', 'javascript:alert(1)', 'https://partsouq.com.evil.example/', 'https://partsouq.com/a b']
    .forEach((u) => assert.equal(addCar(env, sam, { partsouqUrl: u, registration: 'X' + Math.random() }).error, 'invalid_partsouq_url', u));
  const ok = addCar(env, sam, { partsouqUrl: 'https://partsouq.com/en/catalog/genuine/unit?c=Toyota&vid=1' });
  assert.equal(ok.ok, true);
  assert.ok(addCar(env, sam, { partsouqUrl: 'https://www.partsouq.com/', registration: 'ZZ99' }).ok);
});

test('notes keep line breaks but lose control characters; text is length-capped', () => {
  const { env, sam } = setup();
  const c = addCar(env, sam, { notes: 'line1\r\nline2\u0007\n\n\n\nline3', nickname: 'x'.repeat(100) }).data.car;
  assert.equal(c.notes, 'line1\nline2 \n\nline3');
  assert.equal(c.nickname.length, 40);
});

// ---------- duplicates ----------

test('duplicate registration or VIN warns without saving; force saves anyway', () => {
  const { env, sam } = setup();
  addCar(env, sam);
  const regDupe = addCar(env, sam, { registration: 'AB12CDE', vin: '' });
  assert.equal(regDupe.data.saved, false);
  assert.equal(regDupe.data.warnings[0].type, 'registration');
  const vinDupe = addCar(env, sam, { registration: 'NEW1' });
  assert.equal(vinDupe.data.saved, false);
  assert.equal(vinDupe.data.warnings[0].type, 'vin');
  assert.equal(env.call('listCars', { token: sam }).data.cars.length, 1);
  assert.equal(addCar(env, sam, { registration: 'NEW1' }, { force: true }).data.saved, true);
  assert.equal(env.call('listCars', { token: sam }).data.cars.length, 2);
});

// ---------- update / conflicts ----------

test('update needs the current version; a stale version is a conflict', () => {
  const { env, admin, sam } = setup();
  const car = addCar(env, sam).data.car;
  const f = Object.assign({}, CAR, { colour: 'Black' });
  const a = env.call('saveCar', { token: sam, id: car.id, version: car.version, fields: f });
  assert.equal(a.data.car.colour, 'Black');
  assert.equal(a.data.car.version, 2);
  const stale = env.call('saveCar', { token: admin, id: car.id, version: 1, fields: Object.assign({}, CAR, { colour: 'Red' }) });
  assert.equal(stale.error, 'conflict');
  assert.equal(env.call('getCar', { token: admin, id: car.id }).data.car.colour, 'Black');
});

test('saving with no changes does not bump the version', () => {
  const { env, sam } = setup();
  const car = addCar(env, sam).data.car;
  const r = env.call('saveCar', { token: sam, id: car.id, version: 1, fields: CAR });
  assert.equal(r.data.unchanged, true);
  assert.equal(r.data.car.version, 1);
});

test('editing a car does not trigger a duplicate warning against itself', () => {
  const { env, sam } = setup();
  const car = addCar(env, sam).data.car;
  const r = env.call('saveCar', { token: sam, id: car.id, version: 1, fields: Object.assign({}, CAR, { colour: 'Blue' }) });
  assert.equal(r.data.saved, true);
});

// ---------- odometer ----------

test('odometer can go up but not down; only an admin can force a correction', () => {
  const { env, admin, sam } = setup();
  const car = addCar(env, sam, { odometer: '50,000' }).data.car;
  assert.equal(car.odometer, 50000);
  assert.equal(env.call('updateOdometer', { token: sam, id: car.id, odometer: '51200' }).data.car.odometer, 51200);
  assert.equal(env.call('updateOdometer', { token: sam, id: car.id, odometer: '40000' }).error, 'odometer_lower');
  assert.equal(env.call('updateOdometer', { token: sam, id: car.id, odometer: '40000', forceOdometer: true }).error, 'odometer_lower');
  assert.equal(env.call('updateOdometer', { token: admin, id: car.id, odometer: '40000' }).error, 'odometer_lower');
  assert.equal(env.call('updateOdometer', { token: admin, id: car.id, odometer: '40000', forceOdometer: true }).data.car.odometer, 40000);
  assert.equal(env.call('updateOdometer', { token: sam, id: car.id, odometer: '' }).error, 'invalid_odometer');
});

test('lowering the odometer through the edit form follows the same rule', () => {
  const { env, sam } = setup();
  const car = addCar(env, sam, { odometer: '1000' }).data.car;
  const r = env.call('saveCar', { token: sam, id: car.id, version: 1, fields: Object.assign({}, CAR, { odometer: '900' }) });
  assert.equal(r.error, 'odometer_lower');
});

// ---------- delete / restore ----------

test('admin deletes a car (soft) and can restore it; users never see deleted cars', () => {
  const { env, admin, sam } = setup();
  const car = addCar(env, sam).data.car;
  assert.equal(env.call('deleteCar', { token: admin, id: car.id }).ok, true);
  assert.equal(env.call('listCars', { token: sam }).data.cars.length, 0);
  assert.deepEqual(env.call('listCars', { token: sam }).data.deleted, []);
  assert.equal(env.call('getCar', { token: sam, id: car.id }).error, 'not_found');
  const adminList = env.call('listCars', { token: admin }).data;
  assert.equal(adminList.cars.length, 0);
  assert.equal(adminList.deleted.length, 1);
  assert.equal(env.call('getCar', { token: admin, id: car.id }).ok, true);
  assert.equal(env.call('saveCar', { token: sam, id: car.id, version: 2, fields: CAR }).error, 'not_found');
  assert.equal(env.call('restoreCar', { token: admin, id: car.id }).ok, true);
  assert.equal(env.call('listCars', { token: sam }).data.cars.length, 1);
  assert.equal(env.call('restoreCar', { token: admin, id: car.id }).error, 'not_found', 'already restored');
});

test('deleted cars do not trigger duplicate warnings', () => {
  const { env, admin, sam } = setup();
  const car = addCar(env, sam).data.car;
  env.call('deleteCar', { token: admin, id: car.id });
  assert.equal(addCar(env, sam).data.saved, true);
});

// ---------- fluids ----------

test('fluids: add, change, remove; ids stay stable', () => {
  const { env, sam } = setup();
  const car = addCar(env, sam).data.car;
  let r = env.call('saveFluids', { token: sam, carId: car.id, fluids: [
    { fluid: 'Engine oil', specification: '5W-30 ACEA C2', capacity: '6.5 L' },
    { fluid: 'Coolant', specification: 'Toyota Super Long Life', capacity: '8 L' },
  ] });
  assert.equal(r.data.fluids.length, 2);
  const oil = r.data.fluids[0];
  assert.equal(r.data.fluids[1].fluid, 'Coolant');

  r = env.call('saveFluids', { token: sam, carId: car.id, fluids: [
    { id: oil.id, fluid: 'Engine oil', specification: '0W-20', capacity: '6.5 L' },
    { fluid: 'Brake fluid', specification: 'DOT 4' },
  ] });
  const names = r.data.fluids.map((f) => f.fluid);
  assert.deepEqual(names.sort(), ['Brake fluid', 'Engine oil']);
  assert.equal(r.data.fluids.find((f) => f.fluid === 'Engine oil').id, oil.id);
  assert.equal(r.data.fluids.find((f) => f.fluid === 'Engine oil').specification, '0W-20');
  assert.equal(env.call('getCar', { token: sam, id: car.id }).data.fluids.length, 2);
});

test('fluid validation and limits', () => {
  const { env, sam } = setup();
  const car = addCar(env, sam).data.car;
  assert.equal(env.call('saveFluids', { token: sam, carId: car.id, fluids: [{ fluid: ' ' }] }).error, 'fluid_name_required');
  assert.equal(env.call('saveFluids', { token: sam, carId: car.id, fluids: 'nope' }).error, 'invalid_input');
  const many = Array.from({ length: 41 }, (_, i) => ({ fluid: 'F' + i }));
  assert.equal(env.call('saveFluids', { token: sam, carId: car.id, fluids: many }).error, 'invalid_input');
  assert.equal(env.call('saveFluids', { token: sam, carId: 'nope', fluids: [] }).error, 'not_found');
});

test("fluid ids from another car cannot be hijacked", () => {
  const { env, sam } = setup();
  const a = addCar(env, sam).data.car;
  const b = addCar(env, sam, { registration: 'OTHER1', vin: '' }).data.car;
  const fa = env.call('saveFluids', { token: sam, carId: a.id, fluids: [{ fluid: 'Engine oil', specification: 'A' }] }).data.fluids[0];
  env.call('saveFluids', { token: sam, carId: b.id, fluids: [{ id: fa.id, fluid: 'Engine oil', specification: 'B' }] });
  assert.equal(env.call('getCar', { token: sam, id: a.id }).data.fluids[0].specification, 'A');
});

// ---------- audit + profile ----------

test('car changes are audited', () => {
  const { env, admin, sam } = setup();
  const car = addCar(env, sam).data.car;
  env.call('saveCar', { token: sam, id: car.id, version: 1, fields: Object.assign({}, CAR, { colour: 'Black' }) });
  env.call('updateOdometer', { token: sam, id: car.id, odometer: '100' });
  env.call('saveFluids', { token: sam, carId: car.id, fluids: [{ fluid: 'Engine oil' }] });
  env.call('deleteCar', { token: admin, id: car.id });
  env.call('restoreCar', { token: admin, id: car.id });
  const actions = env.sheets.Audit._rows.slice(1).map((r) => r[3]);
  ['car_created', 'car_updated', 'odometer_updated', 'fluids_saved', 'car_deleted', 'car_restored'].forEach((a) => assert.ok(actions.includes(a), a));
});

test('users can change their own display name', () => {
  const { env, sam } = setup();
  assert.equal(env.call('updateMyName', { token: sam, name: '  Samuel   K  ' }).data.user.name, 'Samuel K');
  assert.equal(env.call('me', { token: sam }).data.user.name, 'Samuel K');
  assert.equal(env.call('updateMyName', { token: sam, name: '   ' }).error, 'invalid_name');
});

// ---------- schema migration ----------

test('a request after a deploy adds missing columns automatically', () => {
  const { env, sam } = setup();
  const header = env.sheets.Cars._rows[0];
  const idx = header.indexOf('photo_thumb_file_id');
  assert.ok(idx > -1);
  header.splice(idx, 1);              // simulate the older schema
  env.props.SCHEMA_VERSION = '1';
  const r = env.call('listCars', { token: sam });
  assert.equal(r.ok, true);
  assert.ok(env.sheets.Cars._rows[0].includes('photo_thumb_file_id'));
  assert.equal(env.props.SCHEMA_VERSION, String(require('vm').runInContext('SCHEMA_VERSION', env.ctx)));
});
