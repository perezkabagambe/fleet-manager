'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const D = '2025-04-10';

function setup(opts) {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam Smith', email: 'sam@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  const car = env.call('saveCar', { token: sam, fields: { registration: 'AB12 CDE', make: 'Toyota', model: 'Hilux', year: '2015', odometer: '50000' } }).data.car;
  const other = env.call('saveCar', { token: sam, fields: { registration: 'ZZ99 ZZZ', make: 'Ford', model: 'Ka', year: '2010' } }).data.car;
  const secretOf = (c, token) => env.call('getCar', { token: token || sam, id: c.id }).data.car.guestSecret;
  const secret = secretOf(car);
  if (opts && opts.on === false) env.call('setGuestAccess', { token: admin, carId: car.id, enabled: false });
  const join = (name, extra) => env.call('guestJoin', Object.assign({ carId: car.id, secret, name }, extra || {}));
  const as = (action, guestToken, params) => env.call(action, Object.assign({ guestToken }, params || {}));
  const staffAdd = (type, fields, extra) => env.call('saveEntry', Object.assign({ token: sam, carId: car.id, type, fields }, extra || {}));
  const jpeg = (size) => { const b = Buffer.alloc(size, 5); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0; return b.toString('base64'); };
  return { env, admin, sam, car, other, secret, secretOf, join, as, staffAdd, jpeg };
}

const job = (extra) => Object.assign({ title: 'Oil and filter change', date: D, mileage: '50500', notes: 'Used 5W-30' }, extra);

// ---------- off by default, secrets, switching ----------

test('guest access is on by default for new cars; every car has its own secret; admins can switch it off and on', () => {
  const { env, admin, sam, car, other, secret, secretOf, join, as } = setup();
  assert.ok(secret && secret.length >= 32);
  assert.notEqual(secret, secretOf(other));
  assert.equal(env.call('getCar', { token: sam, id: car.id }).data.car.guestEnabled, true, 'on from the start');
  assert.equal(env.call('guestInfo', { carId: car.id, secret }).ok, true, 'works without anyone switching it on');
  assert.equal(env.call('setGuestAccess', { token: sam, carId: car.id, enabled: false }).error, 'forbidden');
  assert.equal(env.call('setGuestAccess', { carId: car.id, enabled: false }).error, 'unauthorized');
  assert.equal(env.call('setGuestAccess', { token: admin, carId: car.id, enabled: false }).data.enabled, false);
  assert.equal(env.call('guestInfo', { carId: car.id, secret }).error, 'guest_unavailable');
  assert.equal(join('Bob').error, 'guest_unavailable');
  assert.equal(env.call('setGuestAccess', { token: admin, carId: car.id, enabled: true }).data.enabled, true);
  const info = env.call('guestInfo', { carId: car.id, secret });
  assert.equal(info.data.car.registration, 'AB12 CDE');
  assert.deepEqual(Object.keys(info.data.car).sort(), ['colour', 'country', 'distanceUnit', 'id', 'make', 'model', 'registration', 'year']);
  assert.equal(join('Bob').ok, true);
  // wrong secret, or another car's secret, never works
  assert.equal(env.call('guestInfo', { carId: car.id, secret: 'nope' }).error, 'guest_unavailable');
  assert.equal(env.call('guestInfo', { carId: car.id, secret: secretOf(other) }).error, 'guest_unavailable');
  assert.equal(env.call('guestInfo', { carId: car.id }).error, 'guest_unavailable');
  assert.equal(as('guestMe', 'x').error, 'guest_unauthorized');
});

test('the QR secret reaches signed-in users only, and not through the car list', () => {
  const { env, sam, car, secret } = setup();
  assert.equal(env.call('getCar', { id: car.id }).error, 'unauthorized');
  const list = JSON.stringify(env.call('listCars', { token: sam }).data);
  assert.ok(!list.includes(secret));
  assert.equal(env.call('listCars', { token: sam }).data.cars.find((c) => c.id === car.id).guestEnabled, true);
});

test('switching access off locks guests out at once; a new secret stops old stickers but not people already in', () => {
  const { env, admin, car, secret, join, as } = setup();
  const g = join('Bob').data.guestToken;
  assert.equal(as('guestMe', g).ok, true);
  const fresh = env.call('replaceGuestSecret', { token: admin, carId: car.id }).data.secret;
  assert.notEqual(fresh, secret);
  assert.equal(env.call('guestInfo', { carId: car.id, secret }).error, 'guest_unavailable', 'old sticker');
  assert.equal(env.call('guestInfo', { carId: car.id, secret: fresh }).ok, true);
  assert.equal(as('guestMe', g).ok, true, 'a guest already in keeps their session');
  env.call('setGuestAccess', { token: admin, carId: car.id, enabled: false });
  assert.equal(as('guestMe', g).error, 'guest_disabled');
  assert.equal(as('guestListEntries', g).error, 'guest_disabled');
  env.call('setGuestAccess', { token: admin, carId: car.id, enabled: true });
  assert.equal(as('guestMe', g).ok, true, 'back on, same guest');
});

// ---------- names ----------

test('guest names are unique, never an existing user, never reused', () => {
  const { env, car, secret, join } = setup();
  assert.equal(join('').error, 'guest_name_required');
  assert.equal(join(' - ').error, 'guest_name_required');
  assert.equal(join('A').error, 'guest_name_required');
  assert.equal(join('Bob’s Garage').ok, true);
  assert.equal(join('bobs  garage').error, 'guest_name_taken', 'ignores case, spaces and punctuation');
  assert.equal(join('BOB’S-GARAGE!').error, 'guest_name_taken');
  assert.equal(join('sam smith').error, 'guest_name_taken', 'an app user');
  assert.equal(join('Admin  One').error, 'guest_name_taken');
  assert.equal(join('Guest: Fred').error, 'guest_name_taken');
  assert.equal(join('Jo').ok, true);
  // taken across cars too, and still taken after the session has ended
  assert.equal(env.call('guestJoin', { carId: car.id, secret, name: 'Jo' }).error, 'guest_name_taken');
  env.advance(15 * 24 * 3600 * 1000);
  assert.equal(join('Jo').error, 'guest_name_taken', 'cannot be reused after a session ends');
  assert.equal(join('Jo 2').ok, true);
});

test('a filled-in honeypot field is refused', () => {
  const { join } = setup();
  assert.equal(join('Bot', { website: 'http://spam' }).error, 'guest_unavailable');
  assert.equal(join('Bot').ok, true, 'the same name is not burned by the refused attempt');
});

test('new guest names are capped per car per hour, and across the whole app per day', () => {
  const { env, admin, car, other, secret, secretOf, join } = setup();
  for (let i = 0; i < 20; i++) assert.equal(join('Visitor ' + String.fromCharCode(97 + i)).ok, true, 'name ' + i);
  assert.equal(join('One too many').error, 'try_later');
  // the daily cap is across all cars
  env.call('setGuestAccess', { token: admin, carId: other.id, enabled: true });
  const joinOther = (name) => env.call('guestJoin', { carId: other.id, secret: secretOf(other), name });
  for (let i = 0; i < 10; i++) assert.equal(joinOther('Other ' + String.fromCharCode(97 + i)).ok, true, 'other ' + i);
  assert.equal(joinOther('Other extra').error, 'try_later');
  assert.ok(car && secret);
});

test('a guest session lasts 14 days', () => {
  const { env, join, as } = setup();
  const j = join('Bob').data;
  assert.ok(Math.abs(Date.parse(j.expiresAt) - Date.now() - 14 * 86400000) < 5000);
  env.advance(13 * 86400000);
  assert.equal(as('guestMe', j.guestToken).ok, true);
  env.advance(2 * 86400000);
  assert.equal(as('guestMe', j.guestToken).error, 'guest_unauthorized');
});

// ---------- keeping the two kinds of login apart ----------

test('a guest token is useless for normal actions, and a user token is useless for guest actions', () => {
  const { env, car, sam, join, as } = setup();
  const g = join('Bob').data.guestToken;
  ['listCars', 'getCar', 'listEntries', 'saveEntry', 'deleteEntry', 'getCarCosts', 'listTasks', 'getAttachment', 'me'].forEach((a) => {
    assert.equal(env.call(a, { token: g, carId: car.id, id: car.id }).error, 'unauthorized', a);
    assert.equal(env.call(a, { guestToken: g, carId: car.id, id: car.id }).error, 'unauthorized', a);
  });
  ['setGuestAccess', 'replaceGuestSecret', 'listGuests', 'setGuestBlocked', 'listUsers'].forEach((a) => {
    assert.equal(env.call(a, { token: g, carId: car.id }).error, 'unauthorized', a);
  });
  ['guestMe', 'guestListEntries', 'guestSaveEntry', 'guestDeleteEntry', 'guestUploadAttachment', 'guestGetAttachment'].forEach((a) => {
    assert.equal(env.call(a, { guestToken: sam, token: sam }).error, 'guest_unauthorized', a);
    assert.equal(env.call(a, { token: g }).error, 'guest_unauthorized', a + ' (token in the wrong field)');
  });
});

// ---------- adding ----------

test('a guest can add maintenance and purchases only, and only the allowed fields count', () => {
  const { env, sam, car, staffAdd, join, as } = setup();
  const g = join('Bob').data.guestToken;
  const m = as('guestSaveEntry', g, { type: 'Maintenance', fields: job({ vendor: 'Bob Garage', totalCost: '120', totalCurrency: 'USD' }) });
  assert.equal(m.ok, true);
  assert.equal(m.data.entry.mine, true);
  assert.equal(m.data.entry.totalCost, 120);
  assert.equal(m.data.entry.totalCurrency, 'USD');
  const p = as('guestSaveEntry', g, { type: 'Purchase', fields: { title: 'Brake pads', date: D, quantity: '2', unitCost: '30', currency: 'GBP', partNumber: 'BP-1' } });
  assert.equal(p.ok, true);
  assert.equal(p.data.entry.quantity, 2);
  ['Issue', 'Compliance', 'Repair', 'Nonsense', ''].forEach((t) => assert.equal(as('guestSaveEntry', g, { type: t, fields: job() }).error, 'invalid_type', t));
  assert.equal(as('guestSaveEntry', g, { type: 'Maintenance', fields: job({ title: '' }) }).error, 'title_required');
  assert.equal(as('guestSaveEntry', g, { type: 'Maintenance', fields: job({ date: '2999-01-01' }) }).ok, false, 'no future dates');

  // staff see it flagged with the guest's name, and it is stored against the guest
  const staff = env.call('listEntries', { token: sam, carId: car.id }).data.entries;
  const mine = staff.find((e) => e.id === m.data.entry.id);
  assert.equal(mine.guestName, 'Bob');
  assert.ok(String(mine.createdBy).startsWith('guest:'));
});

test('a guest cannot smuggle in parts, an issue link, a reminder, an odometer change or another car', () => {
  const { env, sam, car, other, staffAdd, join, as } = setup();
  const issue = staffAdd('Issue', { title: 'Noise', date: D }).data.entry;
  const stock = staffAdd('Purchase', { title: 'Oil', date: D, quantity: '5', unitCost: '10' }).data.entry;
  const g = join('Bob').data.guestToken;
  const r = as('guestSaveEntry', g, {
    type: 'Maintenance', carId: other.id, taskId: 'x', resolveIssue: true, updateOdometer: true,
    parts: [{ purchaseId: stock.id, quantity: '3' }],
    fields: job({ mileage: '99999', linkedIssueId: issue.id, labourCost: '500', costMode: 'itemised', carId: other.id }),
  });
  assert.equal(r.ok, true);
  const saved = env.call('getEntry', { token: sam, id: r.data.entry.id }).data;
  assert.equal(saved.entry.carId, car.id, 'always the guest\'s own car');
  assert.equal(saved.entry.linkedIssueId, '');
  assert.equal(saved.entry.labourCost, null);
  assert.equal(saved.parts.length, 0, 'no parts');
  assert.equal(env.call('getCar', { token: sam, id: car.id }).data.car.odometer, 50000, 'odometer untouched');
  assert.equal(env.call('getEntry', { token: sam, id: issue.id }).data.entry.status, 'Not resolved');
  assert.equal(env.call('listEntries', { token: sam, carId: other.id }).data.entries.length, 0);
});

test('guests cannot edit: there is no way to change an entry', () => {
  const { env, join, as } = setup();
  const g = join('Bob').data.guestToken;
  const e = as('guestSaveEntry', g, { type: 'Maintenance', fields: job() }).data.entry;
  const again = as('guestSaveEntry', g, { type: 'Maintenance', id: e.id, version: 1, fields: job({ title: 'Changed' }) });
  assert.equal(again.data.entry.id !== e.id, true, 'an id is ignored: it just adds a new entry');
  assert.equal(as('guestListEntries', g).data.entries.find((x) => x.id === e.id).title, 'Oil and filter change');
});

// ---------- seeing ----------

test('a guest sees maintenance history and their own entries, and never costs or other purchases', () => {
  const { env, sam, car, staffAdd, join, as } = setup();
  staffAdd('Maintenance', { title: 'Brake job', date: D, labourCost: '90', labourCurrency: 'GBP', otherCost: '15', vendor: 'City Garage', notes: 'Rear pads' },
    { parts: [{ name: 'Pads', quantity: '1', unitCost: '45' }] });
  staffAdd('Maintenance', { title: 'Big invoice', date: D, costMode: 'lump', lumpSumCost: '777', lumpCurrency: 'GBP' });
  staffAdd('Issue', { title: 'Parking sensor', date: D, cost: '25' });
  staffAdd('Purchase', { title: 'Secret purchase', date: D, quantity: '1', unitCost: '999' });
  staffAdd('Compliance', { title: 'MOT passed', date: D, cost: '54.85', expiryDate: '2099-01-01' });
  const a = join('Alice').data.guestToken;
  const b = join('Bert').data.guestToken;
  as('guestSaveEntry', a, { type: 'Purchase', fields: { title: 'Alice wipers', date: D, quantity: '1', unitCost: '8' } });
  as('guestSaveEntry', a, { type: 'Maintenance', fields: job({ title: 'Alice service', totalCost: '60' }) });

  const seen = as('guestListEntries', b).data;
  const titles = seen.entries.map((e) => e.title).sort();
  assert.deepEqual(titles, ['Alice service', 'Big invoice', 'Brake job'], 'maintenance only: no issues, purchases, compliance');
  const text = JSON.stringify(seen);
  ['999', '777', '54.85', 'Secret purchase', 'Alice wipers', 'Pads', 'Parking sensor', 'MOT passed'].forEach((w) => assert.ok(!text.includes(w), 'leaked: ' + w));
  ['"cost"', 'labour', 'unitCost', 'lumpSumCost', 'jobCost', 'totalCost'].forEach((w) => assert.ok(!text.includes(w), 'cost field leaked: ' + w));
  assert.ok(!/:60[,}]/.test(text), "Alice's own invoice total is hidden from Bert");
  const brake = seen.entries.find((e) => e.title === 'Brake job');
  assert.equal(brake.mine, false);
  assert.equal(brake.notes, 'Rear pads');
  assert.equal(brake.vendor, 'City Garage');
  assert.equal(seen.entries.find((e) => e.title === 'Alice service').guestName, 'Alice');

  // Alice sees her own purchase and what she entered on her own entries
  const mine = as('guestListEntries', a).data.entries;
  assert.deepEqual(mine.map((e) => e.title).sort(), ['Alice service', 'Alice wipers', 'Big invoice', 'Brake job']);
  assert.equal(mine.find((e) => e.title === 'Alice service').totalCost, 60);
  assert.equal(mine.find((e) => e.title === 'Alice wipers').unitCost, 8);
  assert.equal(mine.find((e) => e.title === 'Brake job').totalCost, undefined);
  // and nothing about owners, people or fluids is reachable
  ['getCar', 'listFluids', 'getCarCosts', 'listPurchases', 'getEntry'].forEach((x) => assert.equal(env.call(x, { guestToken: a, id: car.id, carId: car.id }).ok, false, x));
});

test('guests on one car see nothing of another car', () => {
  const { env, sam, other, join, as } = setup();
  env.call('saveEntry', { token: sam, carId: other.id, type: 'Maintenance', fields: job({ title: 'Other car job' }) });
  const g = join('Bob').data.guestToken;
  assert.ok(!JSON.stringify(as('guestListEntries', g).data).includes('Other car job'));
});

// ---------- deleting ----------

test('a guest may delete only their own entries; admins can delete any', () => {
  const { env, admin, sam, car, staffAdd, join, as } = setup();
  const staffJob = staffAdd('Maintenance', { title: 'Staff job', date: D }).data.entry;
  const a = join('Alice').data.guestToken;
  const b = join('Bert').data.guestToken;
  const mineA = as('guestSaveEntry', a, { type: 'Maintenance', fields: job({ title: 'A job' }) }).data.entry;
  const mineB = as('guestSaveEntry', b, { type: 'Maintenance', fields: job({ title: 'B job' }) }).data.entry;
  assert.equal(as('guestDeleteEntry', a, { id: staffJob.id }).error, 'not_found', 'not staff entries');
  assert.equal(as('guestDeleteEntry', a, { id: mineB.id }).error, 'not_found', 'not another garage\'s');
  assert.equal(as('guestDeleteEntry', a, { id: 'nope' }).error, 'not_found');
  assert.equal(as('guestDeleteEntry', a, { id: mineA.id }).ok, true);
  const left = env.call('listEntries', { token: sam, carId: car.id }).data.entries.map((e) => e.title).sort();
  assert.deepEqual(left, ['B job', 'Staff job']);
  assert.equal(env.call('deleteEntry', { token: admin, id: mineB.id }).ok, true, 'an admin can delete a guest entry');
  const audit = env.sheets.Audit._rows.slice(1).filter((r) => r[3] === 'entry_deleted');
  assert.equal(audit.length, 2);
  assert.ok(audit.some((r) => String(r[1]).startsWith('guest:') && /Alice/.test(r[2])), 'the audit trail names the guest');
});

test('a guest cannot delete a purchase that has already been used', () => {
  const { env, sam, car, join, as } = setup();
  const g = join('Bob').data.guestToken;
  const p = as('guestSaveEntry', g, { type: 'Purchase', fields: { title: 'Filter', date: D, quantity: '1', unitCost: '12' } }).data.entry;
  env.call('saveEntry', { token: sam, carId: car.id, type: 'Maintenance', fields: job({ title: 'Fit filter' }), parts: [{ purchaseId: p.id, quantity: '1' }] });
  assert.equal(as('guestDeleteEntry', g, { id: p.id }).error, 'purchase_in_use');
});

// ---------- photos ----------

test('guests attach JPEG photos to their own entries: three at most, no PDFs, nobody else\'s', () => {
  const { env, sam, car, staffAdd, jpeg, join, as } = setup();
  const a = join('Alice').data.guestToken;
  const b = join('Bert').data.guestToken;
  const e = as('guestSaveEntry', a, { type: 'Maintenance', fields: job() }).data.entry;
  const up = (token, entryId, extra) => as('guestUploadAttachment', token, Object.assign({ entryId, mime: 'image/jpeg', data: jpeg(300), filename: 'p.jpg' }, extra || {}));
  const first = up(a, e.id);
  assert.equal(first.ok, true);
  assert.equal(up(a, e.id).ok, true);
  assert.equal(up(a, e.id).ok, true);
  assert.equal(up(a, e.id).error, 'too_many_attachments');
  assert.equal(up(a, e.id, { mime: 'application/pdf', data: Buffer.from('%PDF-1.4 hello').toString('base64') }).error, 'invalid_attachment');
  assert.equal(up(b, e.id).error, 'not_found', 'not on someone else\'s entry');
  const staffEntry = staffAdd('Maintenance', { title: 'Staff job', date: D }).data.entry;
  assert.equal(up(a, staffEntry.id).error, 'not_found', 'not on a staff entry');
  assert.equal(up(a, e.id, { data: jpeg(2000000) }).ok, false);

  assert.equal(as('guestGetAttachment', a, { id: first.data.attachment.id }).data.mime, 'image/jpeg');
  assert.equal(as('guestGetAttachment', b, { id: first.data.attachment.id }).error, 'not_found');
  assert.equal(as('guestListAttachments', a, { entryId: e.id }).data.attachments.length, 3);
  assert.equal(as('guestListEntries', a).data.entries.find((x) => x.id === e.id).attachmentCount, 3);
  // staff attachments are never served to a guest (they may be invoices)
  const sa = env.call('uploadAttachment', { token: sam, entryId: staffEntry.id, mime: 'image/jpeg', data: jpeg(300), filename: 'invoice.jpg' }).data.attachment;
  assert.equal(as('guestGetAttachment', a, { id: sa.id }).error, 'not_found');
  assert.equal(as('guestListEntries', a).data.entries.find((x) => x.id === staffEntry.id).attachmentCount, 0);
});

// ---------- admin tools ----------

test('admins can list and block guests; a blocked guest is out at once and keeps the name', () => {
  const { env, admin, sam, car, join, as } = setup();
  const g = join('Mallory').data.guestToken;
  as('guestSaveEntry', g, { type: 'Maintenance', fields: job() });
  assert.equal(env.call('listGuests', { token: sam, carId: car.id }).error, 'forbidden');
  const list = env.call('listGuests', { token: admin, carId: car.id }).data.guests;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Mallory');
  assert.equal(list[0].entries, 1);
  assert.equal(list[0].active, true);
  assert.ok(!JSON.stringify(list).includes(g), 'tokens are never listed');
  assert.equal(env.call('setGuestBlocked', { token: sam, id: list[0].id, blocked: true }).error, 'forbidden');
  assert.equal(env.call('setGuestBlocked', { token: admin, id: list[0].id, blocked: true }).ok, true);
  assert.equal(as('guestListEntries', g).error, 'guest_unauthorized');
  assert.equal(join('Mallory').error, 'guest_name_taken');
  assert.equal(env.call('listGuests', { token: admin, carId: car.id }).data.guests[0].blocked, true);
  env.call('setGuestBlocked', { token: admin, id: list[0].id, blocked: false });
  assert.equal(as('guestListEntries', g).ok, true);
  assert.equal(env.call('setGuestBlocked', { token: admin, id: 'nope', blocked: true }).error, 'not_found');
});

test('guest tokens are stored only as hashes, and the audit trail records guests', () => {
  const { env, admin, join, as } = setup();
  const j = join('Bob').data;
  as('guestSaveEntry', j.guestToken, { type: 'Maintenance', fields: job() });
  const rows = env.sheets.Guests._rows;
  assert.ok(!JSON.stringify(rows).includes(j.guestToken));
  const actions = env.sheets.Audit._rows.slice(1).map((r) => r[3]);
  ['guest_joined', 'entry_created'].forEach((a) => assert.ok(actions.includes(a), a));
  const created = env.sheets.Audit._rows.find((r) => r[3] === 'entry_created');
  assert.equal(created[2], 'guest: Bob');
  env.call('setGuestAccess', { token: admin, carId: env.sheets.Cars._rows[1][0], enabled: false });
});

test('a guest can only add so much in an hour', () => {
  const { join, as } = setup();
  const g = join('Bob').data.guestToken;
  for (let i = 0; i < 30; i++) assert.equal(as('guestSaveEntry', g, { type: 'Maintenance', fields: job({ title: 'Job ' + i }) }).ok, true, 'job ' + i);
  assert.equal(as('guestSaveEntry', g, { type: 'Maintenance', fields: job({ title: 'Too many' }) }).error, 'try_later');
});

test('older cars are given a QR secret by the migration', () => {
  const { env, sam, car, admin } = setup();
  const col = env.sheets.Cars._rows[0].indexOf('guest_secret');
  env.sheets.Cars._rows.forEach((r, i) => { if (i > 0) r[col] = ''; });
  env.props.SCHEMA_VERSION = '9';
  const got = env.call('getCar', { token: sam, id: car.id }).data.car;
  assert.ok(got.guestSecret.length >= 32);
  assert.ok(admin);
});

test('the migration switches guest access on for existing cars once, and later switch-offs are kept', () => {
  const { env, sam, admin, car, other } = setup();
  const col = env.sheets.Cars._rows[0].indexOf('guest_enabled');
  env.sheets.Cars._rows.forEach((r, i) => { if (i > 0) r[col] = 'FALSE'; }); // how cars looked before: off
  env.props.SCHEMA_VERSION = '10';
  assert.equal(env.call('getCar', { token: sam, id: car.id }).data.car.guestEnabled, true);
  assert.equal(env.call('getCar', { token: sam, id: other.id }).data.car.guestEnabled, true);
  env.call('setGuestAccess', { token: admin, carId: car.id, enabled: false });
  assert.equal(env.call('getCar', { token: sam, id: car.id }).data.car.guestEnabled, false, 'an admin\'s choice sticks (the migration does not run again)');
});

test('a guest sees the maintenance history in the same order as signed-in users', () => {
  const { env, sam, car, join, as } = setup();
  const add = (title, date) => env.call('saveEntry', { token: sam, carId: car.id, type: 'Maintenance', fields: { title, date } });
  add('Old job', '2025-01-10');
  add('Same day, first', '2025-03-05');
  add('Newest day', '2025-06-01');
  env.advance(1000);
  add('Same day, second', '2025-03-05');
  env.advance(1000);
  add('Same day, third', '2025-03-05');
  const g = join('Bob').data.guestToken;
  as('guestSaveEntry', g, { type: 'Maintenance', fields: { title: 'Guest job, same day', date: '2025-03-05' } });
  const staff = env.call('listEntries', { token: sam, carId: car.id }).data.entries.map((e) => e.title);
  const guest = as('guestListEntries', g).data.entries.map((e) => e.title);
  assert.deepEqual(guest, staff, 'identical order');
  assert.equal(guest[0], 'Newest day');
  assert.equal(guest[1], 'Guest job, same day');
  assert.equal(guest[guest.length - 1], 'Old job');
});
