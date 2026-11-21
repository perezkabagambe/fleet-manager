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

test('a second photo is added next to the first, which stays the main one; all photos share one folder', () => {
  const { env, sam, car } = setup();
  const first = upload(env, sam, car.id).data;
  const second = upload(env, sam, car.id, { full: jpeg(6000, 3), thumb: jpeg(900, 4) }).data;
  assert.equal(second.car.photoId, first.car.photoId, 'the first photo is still the main one');
  assert.deepEqual(second.car.photos.map((x) => x.id), [first.photo.id, second.photo.id]);
  assert.equal(Object.values(env.files).filter((f) => f.trashed).length, 0, 'nothing was thrown away');
  assert.equal(Object.keys(env.folders).length, 1);
  assert.equal(env.call('listCars', { token: sam }).data.cars[0].photos.length, 2);
});

test('a car can have up to 15 photos, and no more', () => {
  const { env, sam, car } = setup();
  for (let i = 0; i < 15; i++) assert.equal(upload(env, sam, car.id).ok, true, 'photo ' + (i + 1));
  assert.equal(upload(env, sam, car.id).error, 'too_many_photos');
  assert.equal(env.call('getCar', { token: sam, id: car.id }).data.car.photos.length, 15);
  // removing one makes room
  const id = env.call('getCar', { token: sam, id: car.id }).data.car.photos[7].id;
  env.call('removeCarPhoto', { token: sam, carId: car.id, photoId: id });
  assert.equal(upload(env, sam, car.id).ok, true);
});

test('any of the photos can be read, by its own id and only for its own car', () => {
  const { env, sam, car } = setup();
  const a = upload(env, sam, car.id, { full: jpeg(5000, 1), thumb: jpeg(800, 2) }).data.photo.id;
  const b = upload(env, sam, car.id, { full: jpeg(5000, 5), thumb: jpeg(800, 6) }).data.photo.id;
  const full = (id) => env.call('getPhoto', { token: sam, carId: car.id, kind: 'full', photoId: id });
  assert.equal(Buffer.from(full(a).data.data, 'base64')[10], 1);
  assert.equal(Buffer.from(full(b).data.data, 'base64')[10], 5);
  assert.equal(Buffer.from(env.call('getPhoto', { token: sam, carId: car.id, kind: 'thumb', photoId: b }).data.data, 'base64')[10], 6);
  assert.equal(Buffer.from(env.call('getPhoto', { token: sam, carId: car.id, kind: 'full' }).data.data, 'base64')[10], 1, 'no id: the main photo');
  const other = env.call('saveCar', { token: sam, fields: Object.assign({}, CAR, { registration: 'ZZ99 ZZZ' }) }).data.car;
  assert.equal(env.call('getPhoto', { token: sam, carId: other.id, kind: 'full', photoId: a }).error, 'no_photo', 'another car\'s photo id does not work');
  assert.equal(env.call('getPhoto', { token: sam, carId: car.id, kind: 'full', photoId: 'nope' }).error, 'no_photo');
});

test('make a photo the main one: the car\'s own photo, the fleet list and the order all follow', () => {
  const { env, sam, car } = setup();
  const a = upload(env, sam, car.id).data;
  const b = upload(env, sam, car.id, { full: jpeg(6000, 3), thumb: jpeg(900, 4) }).data;
  const r = env.call('setCoverPhoto', { token: sam, carId: car.id, photoId: b.photo.id });
  assert.deepEqual(r.data.car.photos.map((x) => x.id), [b.photo.id, a.photo.id]);
  assert.notEqual(r.data.car.photoId, a.car.photoId);
  assert.equal(env.call('listCars', { token: sam }).data.cars[0].photoThumbId, r.data.car.photoThumbId);
  assert.equal(env.call('setCoverPhoto', { token: sam, carId: car.id, photoId: 'nope' }).error, 'no_photo');
  assert.equal(env.call('setCoverPhoto', { carId: car.id, photoId: a.photo.id }).error, 'unauthorized');
});

test('removing the main photo promotes the next one; removing without an id removes the main one', () => {
  const { env, sam, car } = setup();
  const a = upload(env, sam, car.id).data;
  const b = upload(env, sam, car.id, { full: jpeg(6000, 3), thumb: jpeg(900, 4) }).data;
  const r = env.call('removeCarPhoto', { token: sam, carId: car.id });
  assert.deepEqual(r.data.car.photos.map((x) => x.id), [b.photo.id]);
  assert.notEqual(r.data.car.photoId, a.car.photoId);
  assert.ok(env.files[a.car.photoId].trashed && env.files[a.car.photoThumbId].trashed);
  assert.ok(!env.files[r.data.car.photoId].trashed);
  assert.equal(env.call('removeCarPhoto', { token: sam, carId: car.id, photoId: b.photo.id }).data.car.photoId, '');
  assert.equal(env.call('removeCarPhoto', { token: sam, carId: car.id }).error, 'no_photo');
});

test('a phone is told the car changed when only a non-main photo changes', () => {
  const { env, sam, car } = setup();
  upload(env, sam, car.id);
  const rev = () => env.call('getChanges', { token: sam }).data.cars[car.id];
  const r0 = rev();
  const b = upload(env, sam, car.id, { full: jpeg(6000, 3), thumb: jpeg(900, 4) }).data;
  const r1 = rev();
  env.call('removeCarPhoto', { token: sam, carId: car.id, photoId: b.photo.id });
  assert.notEqual(r0, r1);
  assert.notEqual(r1, rev());
});

test('a car that already had a photo before the list existed keeps it as its first photo (migration)', () => {
  const { env, sam, car } = setup();
  const up = upload(env, sam, car.id).data.car;
  const Db = require('vm').runInContext('Db', env.ctx);
  Db.all('CarPhotos').forEach((r) => Db.update('CarPhotos', r._row, { deleted: true })); // as if the list had never been made
  env.invalidate();
  require('vm').runInContext('listExistingCarPhotos_()', env.ctx);
  const photos = env.call('getCar', { token: sam, id: car.id }).data.car.photos;
  assert.equal(photos.length, 1);
  assert.equal(env.call('getPhoto', { token: sam, carId: car.id, kind: 'full', photoId: photos[0].id }).data.fileId, up.photoId);
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
  ['photo_added', 'photo_removed'].forEach((a) => assert.ok(actions.includes(a), a));
});
