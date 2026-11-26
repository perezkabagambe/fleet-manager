'use strict';
// The review screen's thinking (web/report.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../web/report.js');

const code = (c, d) => ({ code: c, description: d, system: 'Air conditioner', status: 'Current' });
const receipt = (data, extra) => Object.assign({ id: 'r1', kind: 'Issue', files: [{ index: 0, mime: 'application/pdf' }], data: Object.assign({ date: '2026-10-05', mileage: 123456, vendor: '', reportRef: 'SCAN-1', issues: [
  { title: 'Solar sensor circuits', codes: [code('B1421', 'Passenger solar sensor circuit'), code('B1424', 'Driver solar sensor circuit')], tip: 'Scan in daylight.' },
  { title: 'Right headlamp swivel motor', codes: [code('B2413', 'Right headlamp swivel motor')] },
  { title: 'Old battery fault', codes: [code('P0562', 'Voltage low')], stored: true },
] }, data || {}) }, extra || {});
const state = (data, extra) => Object.assign(R.fromReading(receipt(data, extra), { currency: 'GBP' }), { carId: 'c1', identifiedBy: 'u1', receiptId: 'r1' });

test('the review starts from the reading: shared details, notes with every code, stored codes unticked, no issue marked as related', () => {
  const s = state();
  assert.deepEqual([s.date, s.mileage, s.issues.length, s.maintenance], ['2026-10-05', '123456', 3, null]);
  assert.equal(s.issues[0].notes, 'Fault codes:\nB1421 · Passenger solar sensor circuit (Air conditioner) [Current]\nB1424 · Driver solar sensor circuit (Air conditioner) [Current]\n\nFrom a report, reference SCAN-1, 2026-10-05.');
  assert.deepEqual(s.issues.map((i) => i.keep), [true, true, false]);
  assert.deepEqual(s.issues.map((i) => Object.keys(i.linkTo)), [[], [], []], 'found together is not the same as related');
  R.setLinked(s, s.issues[0], s.issues[1].key, true);
  R.setLinked(s, s.issues[0], s.issues[2].key, true);
  const p = R.payload(s);
  assert.deepEqual(p.issues.map((i) => i.linkTo), [[1], [0]], 'links only to issues that are being saved');
  assert.deepEqual([p.receiptId, p.carId, p.mileage, p.identifiedBy, p.vendor], ['r1', 'c1', '123456', 'u1', '']);
});

test('a missing date or mileage, no car, or nothing kept stops it being saved', () => {
  const s = state({ date: '', mileage: null });
  s.carId = '';
  assert.deepEqual(R.problems(s), ['Choose the car.', 'Enter the date.', 'Enter the mileage.']);
  s.carId = 'c1'; s.date = '2026-10-05'; s.mileage = '1';
  s.issues.forEach((i) => { i.keep = false; });
  assert.deepEqual(R.problems(s), ['Keep at least one entry.']);
  s.issues[0].keep = true; s.issues[0].title = ' ';
  assert.deepEqual(R.problems(s), ['Give every issue a title.']);
});

test('one fee and one quote for the whole report are shared; typing on one issue takes it out', () => {
  const s = state({ inspectionFee: 60, quotedTotal: 420 });
  assert.deepEqual(s.issues.map((i) => [i.cost, i.sharedFee, i.quoteCost, i.sharedQuote])[0], ['60', true, '420', true]);
  assert.equal(R.isShared(s, s.issues[0], 'sharedFee'), true);
  R.setIssueAmount(s.issues[0], 'fee', '40');
  assert.deepEqual([s.issues[0].cost, s.issues[0].sharedFee, s.issues[1].cost], ['40', false, '60']);
  assert.equal(R.isShared(s, s.issues[1], 'sharedFee'), false, 'only one kept issue left sharing it');
  R.setReportAmount(s, 'fee', '75');
  assert.deepEqual(s.issues.map((i) => i.cost), ['40', '75', '75']);
  const none = state();
  R.setReportAmount(none, 'quote', '100');
  assert.deepEqual(none.issues.map((i) => [i.quoteCost, i.sharedQuote]), [['100', true], ['100', true], ['100', true]]);
});

test('a likely duplicate of an open issue is flagged by fault code or title, and can be appended, created or skipped', () => {
  const existing = [
    { id: 'e1', ref: 'I-0001', type: 'Issue', status: 'Not resolved', title: 'Headlight not turning', notes: 'Code B2413 seen before' },
    { id: 'e2', ref: 'I-0002', type: 'Issue', status: 'Resolved', title: 'Solar sensor circuits', notes: '' },
    { id: 'e3', ref: 'M-0001', type: 'Maintenance', status: '', title: 'Solar sensor circuits', notes: '' },
  ];
  const s = state();
  R.markDuplicates(s, existing);
  assert.deepEqual(s.issues.map((i) => i.duplicate && i.duplicate.ref), [null, 'I-0001', null], 'resolved issues and other entries are not duplicates');
  assert.equal(R.payload(s).issues[1].appendTo, 'e1');
  s.issues[1].duplicateChoice = 'new';
  assert.equal(R.payload(s).issues[1].appendTo, '');
  s.issues[1].duplicateChoice = 'skip';
  assert.equal(R.payload(s).issues.length, 1);
  assert.equal(R.duplicateOf({ title: 'Cracked wing mirror', notes: '', codes: [] }, [{ id: 'x', type: 'Issue', status: 'In-work', title: 'Wing mirror cracked', notes: '' }]).id, 'x');
});

test('two issues can be combined: codes, notes, photos and amounts together', () => {
  const s = state();
  const [a, b] = s.issues;
  a.cost = '10'; b.cost = '15'; b.files = [1];
  R.setLinked(s, s.issues[2], b.key, true);
  R.combine(s, a, b);
  assert.equal(s.issues.length, 2);
  assert.deepEqual([a.codes.map((c) => c.code), a.cost, a.files], [['B1421', 'B1424', 'B2413'], '25', [1]]);
  assert.ok(a.notes.includes('Right headlamp swivel motor:\nFault codes:\nB2413'));
  assert.ok(!(b.key in s.issues[1].linkTo));
});

test('an invoice that also lists faults proposes the maintenance entry too; photos only attach if they are pictures', () => {
  const s = R.fromReading(receipt({ kind: 'Maintenance', title: 'Full service', total: 185, work: 'Oil', vendor: 'City Garage', issues: [{ title: 'Tyre worn', photos: [1, 2] }] }, { kind: 'Maintenance', files: [{ mime: 'application/pdf' }, { mime: 'image/jpeg' }] }), {});
  assert.deepEqual([s.maintenance.title, s.maintenance.total, s.maintenance.vendor], ['Full service', '185', 'City Garage']);
  assert.deepEqual(s.issues[0].files, [1]);
  const added = R.addIssue(s);
  assert.deepEqual(added.linkTo, {});
});
