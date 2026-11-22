'use strict';
// A purchase can hold several items; its price is the total of its items; stock is tracked per item.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const CAR = { registration: 'AB12 CDE', make: 'Toyota', model: 'Hilux', year: '2015', odometer: '50000' };

function setup() {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  const car = env.call('saveCar', { token: sam, fields: CAR }).data.car;
  const car2 = env.call('saveCar', { token: sam, fields: Object.assign({}, CAR, { registration: 'ZZ99 ZZZ' }) }).data.car;
  const order = (items, fields, extra) => env.call('saveEntry', Object.assign({ token: sam, carId: car.id, type: 'Purchase', fields: Object.assign({ date: '2026-10-01', vendor: 'Euro Car Parts', currency: 'GBP' }, fields || {}), items }, extra || {}));
  const get = (id) => env.call('getEntry', { token: sam, id });
  const list = () => env.call('listEntries', { token: sam, carId: car.id }).data.entries;
  const job = (parts, fields) => env.call('saveEntry', { token: sam, carId: car.id, type: 'Maintenance', fields: Object.assign({ title: 'Brake job', date: '2026-10-05', labourCost: '50' }, fields || {}), parts });
  return { env, admin, sam, car, car2, order, get, list, job };
}
const ITEMS = [
  { name: 'Brake pads', partNumber: 'BP-1', quantity: '2', unitCost: '30' },
  { name: 'Brake discs', partNumber: 'BD-9', quantity: '2', unitCost: '45.50' },
  { name: 'Brake fluid', partNumber: '', quantity: '1', unitCost: '8.25' },
];

test('one purchase holds several items; its price is the total of its items', () => {
  const s = setup();
  const r = s.order(ITEMS, { title: 'Euro Car Parts order' });
  assert.equal(r.ok, true);
  const e = r.data.entry;
  assert.match(e.ref, /^P-\d{4}$/);
  assert.equal(e.title, 'Euro Car Parts order');
  const d = s.get(e.id).data;
  assert.deepEqual(d.items.map((i) => [i.name, i.partNumber, i.quantity, i.unitCost, i.lineTotal]), [
    ['Brake pads', 'BP-1', 2, 30, 60], ['Brake discs', 'BD-9', 2, 45.5, 91], ['Brake fluid', '', 1, 8.25, 8.25]]);
  assert.equal(d.stock.total, 159.25, '60 + 91 + 8.25');
  assert.deepEqual([d.stock.status, d.stock.used, d.stock.perUnit], ['In stock', 0, null]);
  const row = s.list().find((x) => x.id === e.id);
  assert.deepEqual([row.total, row.itemCount, row.stockStatus], [159.25, 3, 'In stock']);
  assert.equal(s.env.call('getCarCosts', { token: s.sam, carId: s.car.id }).data.currencies[0].total, 159.25, 'costs count the purchase once, as the total');
});

test('with no name given the purchase is named after its items; one item is just its own name', () => {
  const s = setup();
  assert.equal(s.order(ITEMS).data.entry.title, 'Brake pads + 2 more');
  assert.equal(s.order([ITEMS[0]]).data.entry.title, 'Brake pads');
  assert.equal(s.order([ITEMS[0], ITEMS[1]]).data.entry.title, 'Brake pads + 1 more');
});

test('a single item purchase behaves exactly like before (its own id is the item id)', () => {
  const s = setup();
  const e = s.order([ITEMS[0]]).data.entry;
  assert.deepEqual([e.partNumber, e.quantity, e.unitCost], ['BP-1', 2, 30], 'the purchase mirrors its only item');
  const d = s.get(e.id).data;
  assert.equal(d.items[0].id, e.id);
  assert.deepEqual([d.stock.total, d.stock.perUnit], [60, 30]);
  assert.equal(s.job([{ purchaseId: e.id, quantity: '1' }]).ok, true, 'parts can be used by the purchase id');
});

test('an older app that sends one item in the fields still works, and editing it keeps its usage', () => {
  const s = setup();
  const r = s.env.call('saveEntry', { token: s.sam, carId: s.car.id, type: 'Purchase', fields: { title: 'Wipers', date: '2026-10-01', quantity: '2', unitCost: '8', partNumber: 'W-1' } });
  assert.equal(r.ok, true);
  const e = r.data.entry;
  assert.equal(s.job([{ purchaseId: e.id, quantity: '1' }]).ok, true);
  const edit = s.env.call('saveEntry', { token: s.sam, id: e.id, version: e.version, fields: { title: 'Wipers (front)', date: '2026-10-01', quantity: '3', unitCost: '8', partNumber: 'W-1' } });
  assert.equal(edit.ok, true, 'quantity above what is used');
  assert.deepEqual([s.get(e.id).data.stock.used, s.get(e.id).data.stock.remaining], [1, 2]);
});

test('each item is a separate line of stock: parts are used from one item without touching the others', () => {
  const s = setup();
  const e = s.order(ITEMS).data.entry;
  const items = s.get(e.id).data.items;
  const pads = items[0]; const discs = items[1];
  const purchases = s.env.call('listPurchases', { token: s.sam, carId: s.car.id }).data.purchases;
  assert.deepEqual(purchases.map((p) => [p.name, p.available, p.from]).sort(), [['Brake discs', 2, e.ref + ' Brake pads + 2 more'], ['Brake fluid', 1, e.ref + ' Brake pads + 2 more'], ['Brake pads', 2, e.ref + ' Brake pads + 2 more']].sort());

  const j = s.job([{ purchaseId: pads.id, quantity: '2' }, { purchaseId: discs.id, quantity: '1' }]);
  assert.equal(j.ok, true);
  const jd = s.get(j.data.entry.id).data;
  assert.deepEqual(jd.parts.map((p) => [p.name, p.quantity, p.cost]), [['Brake pads', 2, 60], ['Brake discs', 1, 45.5]]);
  assert.deepEqual(jd.jobCost, { GBP: 155.5 }, 'labour 50 + 60 + 45.50');

  const d = s.get(e.id).data;
  assert.deepEqual(d.items.map((i) => [i.name, i.used, i.remaining, i.status]), [['Brake pads', 2, 0, 'Fitted'], ['Brake discs', 1, 1, 'Partly used'], ['Brake fluid', 0, 1, 'In stock']]);
  assert.deepEqual([d.stock.used, d.stock.remaining, d.stock.status], [3, 2, 'Partly used']);
  assert.deepEqual(d.usedIn.map((u) => [u.title, u.item, u.quantity]), [['Brake job', 'Brake pads', 2], ['Brake job', 'Brake discs', 1]]);
  assert.equal(s.job([{ purchaseId: pads.id, quantity: '1' }], { title: 'Another' }).error, 'not_enough_stock', 'pads are all used');

  // use the rest: the whole purchase is Fitted
  assert.equal(s.job([{ purchaseId: discs.id, quantity: '1' }, { purchaseId: items[2].id, quantity: '1' }], { title: 'Rest' }).ok, true);
  assert.equal(s.get(e.id).data.stock.status, 'Fitted');
  assert.equal(s.list().find((x) => x.id === e.id).stockStatus, 'Fitted');
});

test('editing a purchase: change, add and remove items; used items are protected', () => {
  const s = setup();
  const e = s.order(ITEMS).data.entry;
  const [pads, discs, fluid] = s.get(e.id).data.items;
  s.job([{ purchaseId: pads.id, quantity: '1' }]);
  const save = (items, extra) => s.env.call('saveEntry', Object.assign({ token: s.sam, id: e.id, version: s.get(e.id).data.entry.version, fields: { title: 'Order', date: '2026-10-01', vendor: 'Euro Car Parts', currency: 'GBP' }, items }, extra || {}));

  assert.equal(save([{ id: pads.id, name: 'Brake pads', quantity: '0.5', unitCost: '30' }, { id: discs.id, name: 'Brake discs', quantity: '2', unitCost: '45.5' }]).error, 'quantity_below_used', 'cannot buy fewer than were used');
  assert.equal(save([{ id: discs.id, name: 'Brake discs', quantity: '2', unitCost: '45.5' }]).error, 'item_in_use', 'a used item cannot be removed');

  const r = save([
    { id: pads.id, name: 'Brake pads (front)', partNumber: 'BP-1', quantity: '4', unitCost: '31' },
    { id: discs.id, name: 'Brake discs', partNumber: 'BD-9', quantity: '2', unitCost: '45.5' },
    { name: 'Wiper blades', quantity: '1', unitCost: '12' },
  ]); // the fluid is removed (unused), wipers added
  assert.equal(r.ok, true);
  const d = s.get(e.id).data;
  assert.deepEqual(d.items.map((i) => [i.name, i.quantity, i.unitCost, i.used]), [['Brake pads (front)', 4, 31, 1], ['Brake discs', 2, 45.5, 0], ['Wiper blades', 1, 12, 0]]);
  assert.equal(d.items[0].id, pads.id, 'an item keeps its id, so its usage stays');
  assert.equal(d.stock.total, 4 * 31 + 91 + 12);
  assert.ok(!d.items.some((i) => i.id === fluid.id));
  assert.equal(s.env.call('getCarCosts', { token: s.sam, carId: s.car.id }).data.currencies[0].total, 4 * 31 + 91 + 12 + 50, 'purchase + the 50 labour');
  assert.equal(save([]).error, 'invalid_input');
  assert.equal(save([{ name: '', quantity: '1', unitCost: '1' }]).error, 'item_name_required');
  assert.equal(save([{ name: 'X', quantity: '0', unitCost: '1' }]).error, 'invalid_quantity');
  assert.equal(save([{ name: 'X', quantity: '1', unitCost: '' }]).error, 'unit_cost_required');
  assert.equal(save(Array.from({ length: 31 }, (_, i) => ({ name: 'i' + i, quantity: '1', unitCost: '1' }))).error, 'invalid_input');
});

test('an older single-item purchase (no item rows) can be edited into a multi-item one, keeping its usage and shipping', () => {
  const s = setup();
  // an older purchase: written straight into the sheet, with a shipping cost and no PurchaseItems
  const e = s.env.call('saveEntry', { token: s.sam, carId: s.car.id, type: 'Purchase', fields: { title: 'Pads', date: '2026-10-01', quantity: '2', unitCost: '30' } }).data.entry;
  const ent = s.env.sheets.Entries._rows;
  const col = (n) => ent[0].indexOf(n);
  ent.find((r) => r[0] === e.id)[col('shipping_cost')] = '6';
  s.env.sheets.PurchaseItems._rows.length = 1; // no rows: how every purchase looked before items existed
  s.env.invalidate();
  assert.equal(s.get(e.id).data.stock.total, 66, 'shipping counts');
  assert.equal(s.job([{ purchaseId: e.id, quantity: '1' }]).ok, true);

  const d0 = s.get(e.id).data;
  const r = s.env.call('saveEntry', { token: s.sam, id: e.id, version: d0.entry.version, fields: { title: 'Order', date: '2026-10-01' }, items: [
    { id: d0.items[0].id, name: 'Pads', quantity: '2', unitCost: '30' }, { name: 'Discs', quantity: '2', unitCost: '45' }] });
  assert.equal(r.ok, true);
  const d = s.get(e.id).data;
  assert.equal(d.items.length, 2);
  assert.deepEqual([d.items[0].id, d.items[0].used], [e.id, 1], 'the old item keeps its id and its usage');
  assert.equal(d.stock.total, 66 + 90, 'the old shipping stays with its item');
});

test('deleting a purchase is refused while any of its items has been used', () => {
  const s = setup();
  const e = s.order(ITEMS).data.entry;
  const [, discs] = s.get(e.id).data.items;
  s.job([{ purchaseId: discs.id, quantity: '1' }]);
  assert.equal(s.env.call('deleteEntry', { token: s.admin, id: e.id }).error, 'purchase_in_use');
  const free = s.order(ITEMS).data.entry;
  assert.equal(s.env.call('deleteEntry', { token: s.admin, id: free.id }).ok, true);
  assert.equal(s.env.call('listPurchases', { token: s.sam, carId: s.car.id }).data.purchases.some((p) => p.from && p.from.includes(free.ref)), false, 'its items leave the picker');
});

test('a guest\'s purchase (one item in the fields) works, and the phones see item changes', () => {
  const s = setup();
  const secret = s.env.call('getCar', { token: s.sam, id: s.car.id }).data.car.guestSecret;
  const g = s.env.call('guestJoin', { carId: s.car.id, secret, name: 'Alice' }).data.guestToken;
  const r = s.env.call('guestSaveEntry', { guestToken: g, type: 'Purchase', fields: { title: 'Oil filter', date: '2026-10-03', quantity: '1', unitCost: '9' } });
  assert.equal(r.ok, true);
  assert.equal(s.get(r.data.entry.id).data.items.length, 1);

  const e = s.order(ITEMS).data.entry;
  const before = s.env.call('getChanges', { token: s.sam }).data.cars[s.car.id];
  s.env.call('saveEntry', { token: s.sam, id: e.id, version: s.get(e.id).data.entry.version, fields: { title: 'Order', date: '2026-10-01' }, items: [ITEMS[0], ITEMS[1]] });
  assert.notEqual(s.env.call('getChanges', { token: s.sam }).data.cars[s.car.id], before, 'changing items changes the car\'s revision');
});

test('the car bundle matches the separate screens for a multi-item purchase', () => {
  const s = setup();
  const e = s.order(ITEMS).data.entry;
  const b = s.env.call('getCarBundle', { token: s.sam, carId: s.car.id }).data;
  assert.deepEqual(b.details[e.id], s.get(e.id).data);
  assert.deepEqual({ entries: b.page.entries }, s.env.call('listEntries', { token: s.sam, carId: s.car.id }).data);
});
