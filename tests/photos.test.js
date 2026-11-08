'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const CAR = { registration: 'AB12 CDE', make: 'Toyota', model: 'Land Cruiser', year: '2015' };

function setup() {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  const car = env.call('saveCar', { token: sam, fields: CAR }).data.car;
  return { env, admin, sam, car };
}

/** A fake JPEG: correct FF D8 FF header, then `size - 4` filler bytes. */
function jpeg(size, fill) {
  const b = Buffer.alloc(size, fill === undefined ? 7 : fill);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  return b.toString('base64');
}
function png() {
  const b = Buffer.alloc(200, 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(b);
  return b.toString('base64');
}

function upload(env, token, carId, extra) {
  return env.call('uploadCarPhoto', Object.assign({ token, carId, full: jpeg(5000, 1), thumb: jpeg(800, 2) }, extra || {}));
}

test('photo actions need a session', () => {
  const { env, car } = setup();
  assert.equal(env.call('uploadCarPhoto', { carId: car.id, full: jpeg(100), thumb: jpeg(100) }).error, 'unauthorized');
  assert.equal(env.call('getPhoto', { carId: car.id, kind: 'thumb' }).error, 'unauthorized');
  assert.equal(env.call('removeCarPhoto', { carId: car.id }).error, 'unauthorized');
});

test('upload stores two private files in a per-car folder and links them to the car', () => {
  const { env, sam, car } = setup();
  assert.equal(car.photoId, '');
  const r = upload(env, sam, car.id);
  assert.equal(r.ok, true);
  assert.ok(r.data.car.photoId && r.data.car.photoThumbId);
  assert.notEqual(r.data.car.photoId, r.data.car.photoThumbId);
  const names = Object.values(env.files).map((f) => f.name);
  assert.ok(names.some((n) => /^photo-\d+\.jpg$/.test(n)));
  assert.ok(names.some((n) => /^thumb-\d+\.jpg$/.test(n)));
  assert.equal(Object.keys(env.folders).length, 1);
  assert.equal(Object.values(env.folders)[0].name, car.id);
  assert.equal(Object.values(env.folders)[0].parent, 'uploads');
  assert.equal(env.call('listCars', { token: sam }).data.cars[0].photoThumbId, r.data.car.photoThumbId);
});

test('photo can be read back, and only through the car record', () => {
  const { env, admin, sam, car } = setup();
  const full = jpeg(5000, 1);
  const thumb = jpeg(800, 2);
  upload(env, sam, car.id, { full, thumb });
  assert.equal(env.call('getPhoto', { token: admin, carId: car.id, kind: 'full' }).data.data, full);
  assert.equal(env.call('getPhoto', { token: sam, carId: car.id, kind: 'thumb' }).data.data, thumb);
  // a caller-supplied file id is ignored; unknown cars give not_found
  const r = env.call('getPhoto', { token: sam, carId: car.id, kind: 'thumb', fileId: 'logs-file' });
  assert.equal(r.data.data, thumb);
  assert.equal(env.call('getPhoto', { token: sam, carId: 'nope', kind: 'thumb' }).error, 'not_found');
});

test('a car with no photo says so', () => {
  const { env, sam, car } = setup();
  assert.equal(env.call('getPhoto', { token: sam, carId: car.id, kind: 'thumb' }).error, 'no_photo');
  assert.equal(env.call('removeCarPhoto', { token: sam, carId: car.id }).error, 'no_photo');
});

test('only real JPEGs within the size limits are accepted', () => {
  const { env, sam, car } = setup();
  assert.equal(upload(env, sam, car.id, { full: png() }).error, 'invalid_photo');
  assert.equal(upload(env, sam, car.id, { thumb: png() }).error, 'invalid_photo');
  assert.equal(upload(env, sam, car.id, { full: '' }).error, 'invalid_photo');
  assert.equal(upload(env, sam, car.id, { full: undefined }).error, 'invalid_photo');
  assert.equal(upload(env, sam, car.id, { full: Buffer.from('<html>not an image</html>').toString('base64') }).error, 'invalid_photo');
  assert.equal(upload(env, sam, car.id, { full: jpeg(1500001) }).error, 'photo_too_large');
  assert.equal(upload(env, sam, car.id, { thumb: jpeg(120001) }).error, 'photo_too_large');
  assert.equal(upload(env, sam, car.id, { full: jpeg(1500000) }).ok, true, 'exactly at the limit is fine');
  assert.equal(Object.values(env.files).filter((f) => /^photo-/.test(f.name)).length, 1, 'rejected uploads leave no files');
});

test('replacing a photo trashes the old files and keeps one folder per car', () => {
  const { env, sam, car } = setup();
  const first = upload(env, sam, car.id).data.car;
  const second = upload(env, sam, car.id).data.car;
  assert.notEqual(first.photoId, second.photoId);
  const trashed = Object.entries(env.files).filter(([, f]) => f.trashed).map(([id]) => id).sort();
  assert.deepEqual(trashed, [first.photoId, first.photoThumbId].sort());
  assert.equal(Object.keys(env.folders).length, 1);
});

test('removing a photo clears the car and trashes the files', () => {
  const { env, sam, car } = setup();
  const up = upload(env, sam, car.id).data.car;
  const r = env.call('removeCarPhoto', { token: sam, carId: car.id });
  assert.equal(r.data.car.photoId, '');
  assert.equal(env.call('getPhoto', { token: sam, carId: car.id, kind: 'full' }).error, 'no_photo');
  assert.ok(env.files[up.photoId].trashed && env.files[up.photoThumbId].trashed);
});

test('photos of deleted cars are hidden from users but not admins', () => {
  const { env, admin, sam, car } = setup();
  upload(env, sam, car.id);
  env.call('deleteCar', { token: admin, id: car.id });
  assert.equal(env.call('getPhoto', { token: sam, carId: car.id, kind: 'thumb' }).error, 'not_found');
  assert.equal(upload(env, sam, car.id).error, 'not_found');
  assert.equal(env.call('getPhoto', { token: admin, carId: car.id, kind: 'thumb' }).ok, true);
});

test('changing a photo does not make an open edit form conflict', () => {
  const { env, sam, car } = setup();
  upload(env, sam, car.id);
  const r = env.call('saveCar', { token: sam, id: car.id, version: car.version, fields: Object.assign({}, CAR, { colour: 'Blue' }) });
  assert.equal(r.data.saved, true);
  assert.ok(r.data.car.photoId, 'photo survives a form save');
});

test('photo events are audited', () => {
  const { env, sam, car } = setup();
  upload(env, sam, car.id);
  upload(env, sam, car.id);
  env.call('removeCarPhoto', { token: sam, carId: car.id });
  const actions = env.sheets.Audit._rows.slice(1).map((r) => r[3]);
  ['photo_added', 'photo_replaced', 'photo_removed'].forEach((a) => assert.ok(actions.includes(a), a));
});
