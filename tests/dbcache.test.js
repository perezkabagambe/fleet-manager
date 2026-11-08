'use strict';
// The table cache and the one-request car page must be invisible to everyone: same answers, fewer reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { createEnv } = require('./harness');

const D = '2025-04-10';
// a few checks are about the cache itself, so they do not apply when the whole suite is run with it switched off
const cacheOnly = process.env.FLEET_DB_CACHE === 'off' ? { skip: 'the table cache is switched off for this run' } : {};

function setup(opts) {
  const env = createEnv();
  if (opts && opts.cache === 'off') env.props.DB_CACHE = 'off';
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam Smith', email: 'sam@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  const car = env.call('saveCar', { token: sam, fields: { registration: 'AB12 CDE', make: 'Toyota', model: 'Hilux', year: '2015', odometer: '50000' } }).data.car;
  const add = (type, fields, extra) => env.call('saveEntry', Object.assign({ token: sam, carId: car.id, type, fields }, extra || {}));
  const list = (token) => env.call('listEntries', { token: token || sam, carId: car.id }).data.entries;
  const db = (code) => vm.runInContext(code, env.ctx);
  return { env, admin, sam, car, add, list, db };
}

const reads = (env) => Object.keys(env.sheets).reduce((o, k) => { o[k] = env.sheets[k].reads; return o; }, {});

// ---------- fewer reads, same answers ----------

test('a table is read from the sheet once, then served from the cache until something changes', cacheOnly, () => {
  const { env, sam, car, add } = setup();
  add('Maintenance', { title: 'First', date: D });
  env.call('listEntries', { token: sam, carId: car.id }); // warms the cache
  const before = reads(env).Entries;
  for (let i = 0; i < 5; i++) assert.equal(env.call('listEntries', { token: sam, carId: car.id }).data.entries.length, 1);
  assert.equal(reads(env).Entries, before, 'no further reads of the Entries tab');
  add('Maintenance', { title: 'Second', date: D });
  assert.equal(env.call('listEntries', { token: sam, carId: car.id }).data.entries.length, 2, 'a write is seen at once');
});

test('with the cache switched off every request reads the sheet, and answers are the same', () => {
  const on = setup();
  const off = setup({ cache: 'off' });
  [on, off].forEach((s) => { s.add('Maintenance', { title: 'First', date: D, labourCost: '50' }); s.add('Issue', { title: 'Noise', date: D }); });
  const b = reads(off.env).Entries;
  off.env.call('listEntries', { token: off.sam, carId: off.car.id });
  off.env.call('listEntries', { token: off.sam, carId: off.car.id });
  assert.ok(reads(off.env).Entries >= b + 2, 'off: reads every time');
  const strip = (e) => e.map((x) => JSON.stringify([x.type, x.title, x.date, x.labourCost, x.jobCost])).sort();
  assert.deepEqual(strip(on.list()), strip(off.list()));
});

test('one request reads each table at most once, even when the code asks for it many times', () => {
  const { env, sam, car, add } = setup({ cache: 'off' });
  add('Maintenance', { title: 'A', date: D, labourCost: '10' });
  const before = reads(env);
  env.call('getCarPage', { token: sam, id: car.id });
  const after = reads(env);
  ['Entries', 'Cars', 'Users', 'Attachments', 'CarDocuments', 'PartUsage', 'Tasks', 'CarPeople', 'FluidSpecs', 'Guests'].forEach((t) => {
    assert.ok(after[t] - before[t] <= 1, t + ' read ' + (after[t] - before[t]) + ' times in one request');
  });
});

test('a warm request needs only a couple of round trips to the cache and none to the sheets', cacheOnly, () => {
  const { env, sam, car, add } = setup();
  add('Maintenance', { title: 'A', date: D, labourCost: '10' });
  env.call('getCarPage', { token: sam, id: car.id });
  env.call('getCarPage', { token: sam, id: car.id }); // everything is now remembered
  const sheetsBefore = reads(env);
  const callsBefore = env.state.cacheCalls;
  const page = env.call('getCarPage', { token: sam, id: car.id });
  assert.equal(page.ok, true);
  assert.deepEqual(reads(env), sheetsBefore, 'no sheet was read at all');
  const calls = env.state.cacheCalls - callsBefore;
  assert.ok(calls <= 6, 'a handful of cache round trips for the whole page, got ' + calls);
});

test('a cold table is read from its sheet in a single call', cacheOnly, () => {
  const { env, sam, car, add } = setup();
  add('Maintenance', { title: 'A', date: D });
  env.invalidate();
  const before = env.sheets.Entries.reads;
  env.call('listEntries', { token: sam, carId: car.id });
  assert.equal(env.sheets.Entries.reads - before, 1);
});

test('a big table with one missing piece is not trusted', cacheOnly, () => {
  const { env, sam, car, db } = setup();
  const long = 'y'.repeat(1900);
  db("(() => { const c = '" + car.id + "'; for (let i = 0; i < 60; i++) Db.insert('Entries', { id: 'b' + i, car_id: c, type: 'Maintenance', title: 'B ' + i, notes: '" + long + "', date: '2025-01-01', deleted: false, version: 1, created_by: 'x', created_at: '2025-01-01T00:00:00Z' }); })()");
  env.call('listEntries', { token: sam, carId: car.id });
  const second = Object.keys(env.cache).find((k) => /^db:\d+:Entries:.*:1$/.test(k));
  assert.ok(second, 'the table is in more than one piece');
  delete env.cache[second];
  const entries = env.call('listEntries', { token: sam, carId: car.id }).data.entries;
  assert.equal(entries.length, 60);
  assert.ok(entries.every((e) => e.notes === long));
});

test('rows handed out are private copies: changing one changes nothing for the next caller', () => {
  const { env, car, add, db } = setup();
  add('Maintenance', { title: 'Original', date: D });
  db("(() => { const rows = Db.all('Entries'); rows.forEach((r) => { r.title = 'TAMPERED'; r.deleted = 'TRUE'; }); rows.length = 0; })()");
  const again = db("Db.all('Entries').map((r) => r.title + '|' + r.deleted)");
  assert.deepEqual(again, ['Original|FALSE']);
  assert.ok(car);
});

// ---------- consistency ----------

test('every kind of write is visible immediately to the next read', () => {
  const { env, admin, sam, car, add } = setup();
  const e = add('Issue', { title: 'Noise', date: D }).data.entry;
  const read = () => env.call('getEntry', { token: sam, id: e.id }).data.entry;
  assert.equal(read().status, 'Not resolved');
  env.call('setIssueStatus', { token: sam, id: e.id, status: 'Resolved' });
  assert.equal(read().status, 'Resolved');
  env.call('updateOdometer', { token: sam, id: car.id, odometer: '51000' });
  assert.equal(env.call('getCar', { token: sam, id: car.id }).data.car.odometer, 51000);
  const t = env.call('saveTask', { token: sam, carId: car.id, fields: { name: 'Oil', intervalMonths: '6' } }).data.task;
  assert.equal(env.call('listTasks', { token: sam, carId: car.id }).data.tasks.length, 1);
  env.call('deleteTask', { token: admin, id: t.id });
  assert.equal(env.call('listTasks', { token: sam, carId: car.id }).data.tasks.length, 0);
  env.call('deleteEntry', { token: admin, id: e.id });
  assert.equal(env.call('getEntry', { token: sam, id: e.id }).error, 'not_found');
  env.call('deleteCar', { token: admin, id: car.id });
  assert.equal(env.call('getCar', { token: sam, id: car.id }).error, 'not_found');
  assert.equal(env.call('getCarPage', { token: sam, id: car.id }).error, 'not_found');
  env.call('restoreCar', { token: admin, id: car.id });
  assert.equal(env.call('getCarPage', { token: sam, id: car.id }).ok, true);
});

test('security changes take effect at once even with a warm cache', () => {
  const { env, admin, sam, car } = setup();
  const samUser = env.call('listUsers', { token: admin }).data.users.find((u) => u.email === 'sam@example.com');
  env.call('getCarPage', { token: sam, id: car.id });
  env.call('getCarPage', { token: sam, id: car.id });
  assert.equal(env.call('setUserRole', { token: admin, userId: samUser.id, role: 'admin' }).ok, true);
  assert.equal(env.call('listUsers', { token: sam }).ok, true, 'promoted at once');
  env.call('setUserRole', { token: admin, userId: samUser.id, role: 'user' });
  assert.equal(env.call('listUsers', { token: sam }).error, 'forbidden', 'demoted at once');
  assert.equal(env.call('setUserStatus', { token: admin, userId: samUser.id, status: 'Revoked' }).ok, true);
  assert.equal(env.call('getCarPage', { token: sam, id: car.id }).error, 'unauthorized', 'revoked at once');
});

test('guest blocking, switch-off and secret replacement take effect at once with a warm cache', () => {
  const { env, admin, sam, car } = setup();
  const secret = env.call('getCar', { token: sam, id: car.id }).data.car.guestSecret;
  const g = env.call('guestJoin', { carId: car.id, secret, name: 'Bob Builder' }).data.guestToken;
  const guestList = () => env.call('guestListEntries', { guestToken: g });
  assert.equal(guestList().ok, true);
  assert.equal(guestList().ok, true);
  const gid = env.call('listGuests', { token: admin, carId: car.id }).data.guests[0].id;
  env.call('setGuestBlocked', { token: admin, id: gid, blocked: true });
  assert.equal(guestList().error, 'guest_unauthorized');
  env.call('setGuestBlocked', { token: admin, id: gid, blocked: false });
  assert.equal(guestList().ok, true);
  env.call('setGuestAccess', { token: admin, carId: car.id, enabled: false });
  assert.equal(guestList().error, 'guest_disabled');
  env.call('setGuestAccess', { token: admin, carId: car.id, enabled: true });
  const fresh = env.call('replaceGuestSecret', { token: admin, carId: car.id }).data.secret;
  assert.equal(env.call('guestInfo', { carId: car.id, secret }).error, 'guest_unavailable');
  assert.equal(env.call('guestInfo', { carId: car.id, secret: fresh }).ok, true);
});

test('an edit made by hand in the sheet shows up within ten minutes, or at once after a schema change', cacheOnly, () => {
  const { env, sam, car, add } = setup();
  add('Maintenance', { title: 'Before', date: D });
  env.call('listEntries', { token: sam, carId: car.id }); // cached
  const col = env.sheets.Entries._rows[0].indexOf('title');
  env.sheets.Entries._rows[1][col] = 'Edited by hand';
  assert.equal(env.call('listEntries', { token: sam, carId: car.id }).data.entries[0].title, 'Before', 'still the remembered copy');
  env.advance(5 * 60 * 1000);
  assert.equal(env.call('listEntries', { token: sam, carId: car.id }).data.entries[0].title, 'Before', 'five minutes on: still the remembered copy');
  env.advance(6 * 60 * 1000);
  assert.equal(env.call('listEntries', { token: sam, carId: car.id }).data.entries[0].title, 'Edited by hand', 'after the time limit');
  env.sheets.Entries._rows[1][col] = 'Edited again';
  env.invalidate();
  assert.equal(env.call('listEntries', { token: sam, carId: car.id }).data.entries[0].title, 'Edited again');
});

test('a lost or evicted cache entry is harmless', cacheOnly, () => {
  const { env, sam, car, add } = setup();
  add('Maintenance', { title: 'One', date: D });
  env.call('listEntries', { token: sam, carId: car.id });
  Object.keys(env.cache).filter((k) => /^dbgen:/.test(k)).forEach((k) => delete env.cache[k]); // generation markers evicted
  assert.equal(env.call('listEntries', { token: sam, carId: car.id }).data.entries.length, 1);
  add('Maintenance', { title: 'Two', date: D });
  Object.keys(env.cache).filter((k) => /^db:/.test(k)).forEach((k) => delete env.cache[k]); // data evicted
  assert.equal(env.call('listEntries', { token: sam, carId: car.id }).data.entries.length, 2);
  // a half-evicted table (one chunk missing) is never trusted
  env.call('listEntries', { token: sam, carId: car.id });
  const chunk = Object.keys(env.cache).find((k) => /^db:\d+:Entries:.*:0$/.test(k));
  assert.ok(chunk);
  delete env.cache[chunk];
  assert.equal(env.call('listEntries', { token: sam, carId: car.id }).data.entries.length, 2);
});

test('if the cache service itself fails, everything still works', () => {
  const { env, sam, car, add } = setup();
  add('Maintenance', { title: 'One', date: D });
  env.state.cacheBroken = true;
  assert.equal(env.call('listEntries', { token: sam, carId: car.id }).data.entries.length, 1);
  assert.equal(add('Maintenance', { title: 'Two', date: D }).ok, true);
  assert.equal(env.call('getCarPage', { token: sam, id: car.id }).data.entries.length, 2);
  env.state.cacheBroken = false;
});

test('big tables are cached in several pieces; huge ones are simply read each time', cacheOnly, () => {
  const { env, sam, car, db } = setup();
  const long = 'x'.repeat(1900);
  db("(() => { const c = '" + car.id + "'; for (let i = 0; i < 160; i++) Db.insert('Entries', { id: 'big' + i, car_id: c, type: 'Maintenance', title: 'Big ' + i, notes: '" + long + "', date: '2025-01-01', deleted: false, version: 1, created_by: 'x', created_at: '2025-01-01T00:00:00Z' }); })()");
  env.call('listEntries', { token: sam, carId: car.id });
  const pieces = Object.keys(env.cache).filter((k) => /^db:\d+:Entries:.*:\d+$/.test(k));
  assert.ok(pieces.length >= 2, 'more than one piece: ' + pieces.length);
  const before = env.sheets.Entries.reads;
  const entries = env.call('listEntries', { token: sam, carId: car.id }).data.entries;
  assert.equal(entries.length, 160);
  assert.equal(env.sheets.Entries.reads, before, 'served from the pieces');
  assert.equal(entries.filter((e) => e.notes === long).length, 160, 'and the data is intact');
  // far too big to keep
  db("(() => { const c = '" + car.id + "'; for (let i = 160; i < 1500; i++) Db.insert('Entries', { id: 'big' + i, car_id: c, type: 'Maintenance', title: 'Big ' + i, notes: '" + long + "', date: '2025-01-01', deleted: false, version: 1, created_by: 'x', created_at: '2025-01-01T00:00:00Z' }); })()");
  assert.equal(env.call('listEntries', { token: sam, carId: car.id }).data.entries.length, 1500);
  const b2 = env.sheets.Entries.reads;
  env.call('listEntries', { token: sam, carId: car.id });
  assert.ok(env.sheets.Entries.reads > b2, 'too big for the cache: read from the sheet each time');
});

test('accents, pound signs and emoji do not break the cache (it counts bytes, not characters)', cacheOnly, () => {
  const { env, sam, car, db } = setup();
  const odd = '£é' + 'ŋ'.repeat(900) + '😀';
  db("(() => { const c = '" + car.id + "'; for (let i = 0; i < 120; i++) Db.insert('Entries', { id: 'odd' + i, car_id: c, type: 'Maintenance', title: 'Odd ' + i, notes: '" + odd + "', date: '2025-01-01', deleted: false, version: 1, created_by: 'x', created_at: '2025-01-01T00:00:00Z' }); })()");
  env.call('listEntries', { token: sam, carId: car.id });
  const before = env.sheets.Entries.reads;
  const entries = env.call('listEntries', { token: sam, carId: car.id }).data.entries;
  assert.equal(entries.length, 120);
  assert.equal(env.sheets.Entries.reads, before, 'multi-byte text was still cached');
  assert.ok(entries.every((e) => e.notes === odd), 'and came back exactly as stored');
});

test('security tabs and the audit log are never cached, and rows are never deleted from cached tabs', cacheOnly, () => {
  const { env, sam, car, add, db } = setup();
  add('Maintenance', { title: 'One', date: D });
  env.call('getCarPage', { token: sam, id: car.id });
  const keys = Object.keys(env.cache).filter((k) => /^db:/.test(k));
  assert.ok(keys.length > 0);
  ['Tokens', 'Sessions', 'Audit', 'Locks', 'Settings'].forEach((t) => assert.ok(!keys.some((k) => k.includes(':' + t + ':')), t + ' must not be cached'));
  assert.throws(() => db("Db.prune('Entries', () => true)"), /not allowed/);
  assert.doesNotThrow(() => db("Db.prune('Tokens', () => false)"));
});

test('cached copies are kept apart per schema version', cacheOnly, () => {
  const { env, sam, car } = setup();
  env.call('listEntries', { token: sam, carId: car.id });
  const v = vm.runInContext('SCHEMA_VERSION', env.ctx);
  assert.ok(Object.keys(env.cache).some((k) => k.startsWith('db:' + v + ':Entries:')));
});

// ---------- the one-request car page ----------

test('getCarPage returns exactly what the separate requests return', () => {
  const { env, admin, sam, car, add } = setup();
  const issue = add('Issue', { title: 'Noise', date: D, cost: '20' }).data.entry;
  add('Maintenance', { title: 'Brakes', date: D, labourCost: '90', linkedIssueId: issue.id }, { parts: [{ name: 'Pads', quantity: '1', unitCost: '45' }] });
  add('Purchase', { title: 'Oil', date: D, quantity: '5', unitCost: '10' });
  env.call('addStandardTasks', { token: sam, carId: car.id });
  env.call('saveFluids', { token: sam, carId: car.id, fluids: [{ fluid: 'Engine oil', specification: '5W-30', capacity: '5 L' }] });
  [sam, admin].forEach((token) => {
    const page = env.call('getCarPage', { token, id: car.id });
    assert.equal(page.ok, true);
    const car1 = env.call('getCar', { token, id: car.id }).data;
    assert.deepEqual(page.data.car, car1.car);
    assert.deepEqual(page.data.fluids, car1.fluids);
    assert.deepEqual(page.data.people, car1.people);
    assert.deepEqual(page.data.entries, env.call('listEntries', { token, carId: car.id }).data.entries);
    assert.deepEqual(page.data.tasks, env.call('listTasks', { token, carId: car.id }).data.tasks);
    assert.deepEqual(page.data.costs, env.call('getCarCosts', { token, carId: car.id }).data);
    assert.equal(page.data.entries.length, 4, 'issue, maintenance, two purchases');
    assert.ok(page.data.tasks.length >= 10);
  });
});

test('getCarPage needs a normal sign-in, and unknown cars are not found', () => {
  const { env, sam, car } = setup();
  assert.equal(env.call('getCarPage', { id: car.id }).error, 'unauthorized');
  assert.equal(env.call('getCarPage', { token: 'nope', id: car.id }).error, 'unauthorized');
  assert.equal(env.call('getCarPage', { guestToken: 'nope', id: car.id }).error, 'unauthorized');
  assert.equal(env.call('getCarPage', { token: sam, id: 'does-not-exist' }).error, 'not_found');
  assert.equal(env.call('getCarPage', { token: sam }).error, 'not_found');
});

test('a guest cannot use the car page request or see the secret through it', () => {
  const { env, sam, car } = setup();
  const secret = env.call('getCar', { token: sam, id: car.id }).data.car.guestSecret;
  const g = env.call('guestJoin', { carId: car.id, secret, name: 'Bob Builder' }).data.guestToken;
  assert.equal(env.call('getCarPage', { token: g, id: car.id }).error, 'unauthorized');
  assert.equal(env.call('getCarPage', { guestToken: g, id: car.id }).error, 'unauthorized');
});

// ---------- server timing ----------

test('server time is reported for signed-in requests but never for the public sign-in actions', () => {
  const { env, sam, car } = setup();
  assert.equal(typeof env.call('getCarPage', { token: sam, id: car.id }).ms, 'number');
  assert.equal(typeof env.call('ping').ms, 'number');
  assert.equal('ms' in env.call('requestLogin', { email: 'sam@example.com' }), false);
  assert.equal('ms' in env.call('requestLogin', { email: 'nobody@example.com' }), false);
  assert.equal('ms' in env.call('guestInfo', { carId: car.id, secret: 'x' }), false);
});

// ---------- the weekly job and migrations use the same tables ----------

test('the weekly reminder job sees fresh data and its writes are seen by the app', () => {
  const { env, sam, car } = setup();
  env.call('saveTask', { token: sam, carId: car.id, fields: { name: 'Oil', intervalMonths: '6', dueDate: '2000-01-01' } });
  env.call('listTasks', { token: sam, carId: car.id }); // warm
  assert.equal(env.ctx.sendWeeklyReminders(), 1);
  const col = env.sheets.Tasks._rows[0].indexOf('last_reminded_at');
  assert.ok(env.sheets.Tasks._rows[1][col], 'the job wrote last_reminded_at');
  env.call('saveTask', { token: sam, carId: car.id, fields: { name: 'Tyres', intervalMonths: '6', dueDate: '2000-01-01' } });
  assert.equal(env.ctx.sendWeeklyReminders(), 1, 'it still sees the new task straight away');
  assert.equal(env.outbox.filter((m) => /overdue/.test(m.subject)).pop().body.includes('Tyres'), true);
});

// ---------- the strongest check: cache on and cache off must always give identical answers ----------

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function normaliser() {
  const ids = new Map();
  return (value) => {
    let text = JSON.stringify(value);
    text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => { if (!ids.has(m)) ids.set(m, '#' + ids.size); return ids.get(m); });
    text = text.replace(/\b[0-9a-f]{32,64}\b/g, 'HEX');
    text = text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, 'TS');
    return text.replace(/"ms":\d+,?/g, '');
  };
}

function runScenario(cache, seed, steps) {
  const env = createEnv();
  if (cache === 'off') env.props.DB_CACHE = 'off';
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam Smith', email: 'sam@example.com', role: 'user' });
  env.seedUser({ name: 'Ann Other', email: 'ann@example.com', role: 'user' });
  const tok = { admin: env.signInAs('admin@example.com'), sam: env.signInAs('sam@example.com'), ann: env.signInAs('ann@example.com') };
  const userIds = env.call('listUsers', { token: tok.admin }).data.users.map((u) => u.id);
  const norm = normaliser();
  const log = [];
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const cars = []; const entries = []; const tasks = []; const guests = [];
  const who = () => pick(['sam', 'ann', 'admin']);
  const D = () => '2025-0' + (1 + Math.floor(rand() * 9)) + '-1' + Math.floor(rand() * 9);

  function step(i) {
    env.advance(2000);
    const r = rand();
    let res;
    if (cars.length < 2 || r < 0.06) {
      res = env.call('saveCar', { token: tok[who()], fields: { registration: 'CAR ' + i, make: 'Make', model: 'Model', year: '2015', odometer: String(1000 * i) } });
      if (res.ok && res.data.saved) cars.push(res.data.car.id);
    } else if (r < 0.34) {
      const type = pick(['Maintenance', 'Maintenance', 'Issue', 'Purchase', 'Compliance']);
      const f = { title: type + ' ' + i, date: D(), mileage: String(500 * i), notes: 'n' + i };
      if (type === 'Maintenance') Object.assign(f, { labourCost: String(10 + i), costMode: pick(['itemised', 'lump']), lumpSumCost: '99' });
      if (type === 'Purchase') Object.assign(f, { quantity: '3', unitCost: '12' });
      if (type === 'Compliance') Object.assign(f, { expiryDate: '2099-01-01', cost: '50' });
      const extra = {};
      if (type === 'Maintenance' && entries.length && rand() < 0.4) extra.parts = [{ name: 'Part ' + i, quantity: '1', unitCost: '5' }];
      res = env.call('saveEntry', Object.assign({ token: tok[who()], carId: pick(cars), type, fields: f }, extra));
      if (res.ok) entries.push(res.data.entry.id);
    } else if (r < 0.42 && entries.length) {
      const id = pick(entries);
      const cur = env.call('getEntry', { token: tok.admin, id });
      if (cur.ok) res = env.call('saveEntry', { token: tok[who()], id, version: cur.data.entry.version, fields: Object.assign({}, cur.data.entry, { title: 'Edited ' + i, date: cur.data.entry.date }) });
    } else if (r < 0.48 && entries.length) {
      res = env.call('deleteEntry', { token: tok.admin, id: pick(entries) });
    } else if (r < 0.54 && entries.length) {
      res = env.call('setIssueStatus', { token: tok[who()], id: pick(entries), status: pick(['In-work', 'Resolved', 'Ignored']) });
    } else if (r < 0.6) {
      res = env.call('updateOdometer', { token: tok[who()], id: pick(cars), odometer: String(100000 + i) });
    } else if (r < 0.68) {
      res = env.call('saveTask', { token: tok[who()], carId: pick(cars), fields: { name: 'Task ' + i, intervalMonths: '6', dueDate: pick(['2000-01-01', '2099-01-01']) } });
      if (res.ok) tasks.push(res.data.task.id);
    } else if (r < 0.72) {
      res = env.call('addStandardTasks', { token: tok[who()], carId: pick(cars) });
    } else if (r < 0.75 && tasks.length) {
      res = env.call('deleteTask', { token: tok.admin, id: pick(tasks) });
    } else if (r < 0.8) {
      res = env.call('setCarPeople', { token: tok.admin, carId: pick(cars), owners: [pick(userIds)] });
    } else if (r < 0.84) {
      const c = pick(cars);
      const secret = env.call('getCar', { token: tok.admin, id: c }).data.car.guestSecret;
      res = env.call('guestJoin', { carId: c, secret, name: 'Guest ' + i });
      if (res.ok) guests.push({ token: res.data.guestToken, carId: c });
    } else if (r < 0.9 && guests.length) {
      const g = pick(guests);
      res = env.call('guestSaveEntry', { guestToken: g.token, type: pick(['Maintenance', 'Purchase']), fields: { title: 'G' + i, date: D(), quantity: '1', unitCost: '4' } });
    } else if (r < 0.93 && guests.length) {
      const listed = env.call('listGuests', { token: tok.admin, carId: pick(cars) }).data.guests;
      res = listed.length ? env.call('setGuestBlocked', { token: tok.admin, id: listed[0].id, blocked: rand() < 0.5 }) : { skipped: true };
    } else if (r < 0.96) {
      res = env.call('setGuestAccess', { token: tok.admin, carId: pick(cars), enabled: rand() < 0.7 });
    } else if (r < 0.98 && cars.length > 2) {
      res = env.call('deleteCar', { token: tok.admin, id: pick(cars) });
    } else {
      res = env.call('restoreCar', { token: tok.admin, id: pick(cars) });
    }
    log.push(norm(['op', i, res]));
    // after every operation, read everything a person could look at
    cars.forEach((c) => {
      log.push(norm(env.call('getCarPage', { token: tok.sam, id: c })));
      log.push(norm(env.call('getCarPage', { token: tok.admin, id: c })));
      log.push(norm(env.call('listGuests', { token: tok.admin, carId: c })));
    });
    log.push(norm(env.call('listCars', { token: tok.ann })));
    log.push(norm(env.call('listCars', { token: tok.admin })));
    entries.forEach((id) => log.push(norm(env.call('getEntry', { token: tok.sam, id }))));
    guests.forEach((g) => log.push(norm(env.call('guestListEntries', { guestToken: g.token }))));
    log.push(norm(env.call('listUsers', { token: tok.admin })));
    log.push(norm(env.call('listPurchases', { token: tok.sam, carId: cars[0] })));
  }
  for (let i = 0; i < steps; i++) step(i);
  return log;
}

test('a long random run of changes and reads gives identical answers with the cache on and off', () => {
  // more seeds and steps can be asked for when hunting: FLEET_DIFF_SEEDS=1,2,3,4 FLEET_DIFF_STEPS=150
  const seeds = (process.env.FLEET_DIFF_SEEDS || '1,2,3').split(',').map(Number);
  const steps = Number(process.env.FLEET_DIFF_STEPS || 70);
  seeds.forEach((seed) => {
    const on = runScenario('on', seed, steps);
    const off = runScenario('off', seed, steps);
    assert.equal(on.length, off.length);
    for (let i = 0; i < on.length; i++) {
      if (on[i] !== off[i]) {
        let k = 0;
        while (on[i][k] === off[i][k]) k++;
        assert.fail('seed ' + seed + ' diverged at read ' + i + ' (character ' + k + ')\n cache on : ...' + on[i].slice(Math.max(0, k - 150), k + 150) + '\n cache off: ...' + off[i].slice(Math.max(0, k - 150), k + 150));
      }
    }
    assert.ok(on.length > 500, 'a real amount of work was compared');
  });
});
