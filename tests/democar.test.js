'use strict';
// The demo car the user guide links to: created once by an admin, found by anyone, and fully filled in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

function setup() {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  return { env, admin: env.signInAs('admin@example.com'), sam: env.signInAs('sam@example.com') };
}

test('nobody can find a demo car until an admin creates one, and only an admin can create it', () => {
  const { env, admin, sam } = setup();
  assert.equal(env.call('getDemoCar', { token: sam }).data.id, null);
  assert.equal(env.call('createDemoCar', { token: sam }).error, 'forbidden');
  assert.equal(env.call('getDemoCar', {}).error, 'unauthorized');
  const made = env.call('createDemoCar', { token: admin });
  assert.equal(made.ok, true, made.error);
  assert.equal(made.data.created, true);
  assert.equal(env.call('getDemoCar', { token: sam }).data.id, made.data.id);
});

test('creating it again never makes a second one', () => {
  const { env, admin } = setup();
  const a = env.call('createDemoCar', { token: admin }).data;
  const b = env.call('createDemoCar', { token: admin }).data;
  assert.deepEqual([b.created, b.id], [false, a.id]);
  assert.equal(env.call('listCars', { token: admin }).data.cars.filter((c) => c.registration === 'DEMO 001').length, 1);
});

test('some demo entries have a made-up PDF receipt or invoice, made once and valid', () => {
  const { env, admin, sam } = setup();
  const id = env.call('createDemoCar', { token: admin }).data.id;
  const entries = env.call('getCarPage', { token: sam, id }).data.entries;
  const withFiles = entries.filter((e) => e.attachmentCount > 0).map((e) => e.title).sort();
  assert.deepEqual(withFiles, ['Front brake pads and discs', 'Front brakes: pads and discs fitted', 'Full service (invoice)', 'Oil and filter kit']);
  const brakes = entries.find((e) => e.title === 'Front brake pads and discs');
  const detail = env.call('getEntry', { token: sam, id: brakes.id }).data;
  assert.equal(detail.attachments.length, 1);
  assert.equal(detail.attachments[0].mime, 'application/pdf');
  const file = env.call('getAttachment', { token: sam, id: detail.attachments[0].id }).data;
  const text = Buffer.from(file.data, 'base64').toString('latin1');
  assert.match(text, /^%PDF-1\.4/);
  assert.match(text, /Euro Car Parts/);
  assert.match(text, /110\.50/);
  assert.match(text, /startxref\n\d+\n%%EOF\n$/);
  // asking again adds nothing
  const again = env.call('createDemoCar', { token: admin }).data;
  assert.equal(again.receipts, 0);
});

test('creating it again swaps in the current demo picture: still exactly one photo', () => {
  const { env, admin, sam } = setup();
  const id = env.call('createDemoCar', { token: admin }).data.id;
  const first = env.call('getCarPage', { token: sam, id }).data.car.photos;
  const again = env.call('createDemoCar', { token: admin }).data;
  assert.equal(again.photo, true);
  const after = env.call('getCarPage', { token: sam, id }).data.car.photos;
  assert.equal(after.length, 1);
  assert.notEqual(after[0].id, first[0].id);
});

test('the demo car is filled in as fully as possible: details, catalogues, fluids and bulbs, every kind of entry, reminders and a document', () => {
  const { env, admin, sam } = setup();
  const id = env.call('createDemoCar', { token: admin }).data.id;
  const page = env.call('getCarPage', { token: sam, id }).data;
  const car = page.car;
  assert.deepEqual([car.registration, car.make, car.year, car.transmission, car.fuelType, car.driveSide, car.fuelCapacity], ['DEMO 001', 'Example', 2019, 'Manual', 'Diesel', 'RHD', 55]);
  assert.equal(car.vin, 'EXAMPLE0DEMO00001');
  assert.match(car.notes, /demo vehicle for the user guide/);
  assert.equal(car.catalogues.length, 2);
  assert.equal(car.acquisitionCost, 9500);
  assert.equal(car.odometer, 48250);
  // fluids and bulbs, two of them AI suggestions (so the "check these" note shows)
  assert.equal(page.fluids.filter((f) => f.kind !== 'bulb').length, 4);
  assert.equal(page.fluids.filter((f) => f.kind === 'bulb').length, 3);
  assert.equal(page.fluids.filter((f) => /^AI suggestion/.test(f.source)).length, 2);
  // entries of every kind: issues (one resolved by a job, one open), maintenance (itemised and a lump-sum invoice), purchases (one used up)
  const byType = (t) => page.entries.filter((e) => e.type === t);
  assert.equal(byType('Issue').length, 2);
  assert.deepEqual(byType('Issue').map((e) => e.status).sort(), ['Not resolved', 'Resolved']);
  assert.equal(byType('Maintenance').length, 2);
  assert.equal(byType('Purchase').length, 2);
  assert.equal(byType('Compliance').length, 1);
  assert.ok(byType('Purchase').some((e) => e.stockStatus === 'Fitted'), 'the brake parts were fitted');
  assert.ok(byType('Purchase').some((e) => e.stockStatus === 'In stock'), 'the oil kit is still in stock');
  page.entries.forEach((e) => assert.match(e.ref, /^[MIPC]-\d{4}$/));
  assert.ok(page.tasks.length >= 5, 'the standard reminders');
  assert.ok(page.tasks.every((t) => t.active === false && /Demo car/.test(t.pausedReason)), 'paused, so the demo car never emails anyone');
  assert.equal(page.documents.length, 1);
  assert.equal(page.car.photos.length, 1, 'the demo car has a photo');
  assert.equal(page.documents[0].type, 'Logbook');
  // the costs add up from the entries (GBP only)
  const gbp = page.costs.currencies.filter((c) => c.currency === 'GBP')[0];
  assert.ok(gbp && gbp.total > 300, 'costs: ' + JSON.stringify(page.costs.currencies));
});
