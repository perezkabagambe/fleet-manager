'use strict';
// The search over the data saved on the phone (web/search.js): what it looks at, how it matches, and how it ranks.
const test = require('node:test');
const assert = require('node:assert/strict');
const Search = require('../web/search.js');

const saved = {
  listCars: { cars: [
    { id: 'c1', registration: 'MV56 HUH', make: 'BMW', model: 'E92 325i', year: 2006, vin: 'WBAWB12', engineCode: 'N52B25' },
    { id: 'c2', registration: 'UA 132FP', make: 'Kia', model: 'Sorento', year: 2013 },
  ] },
  'getCarPage|c1': {
    entries: [
      { id: 'e1', type: 'Issue', title: 'Faulty ABS pump', ref: 'I-0018', date: '2026-11-18', notes: 'Needs coding in', vendor: 'Perez' },
      { id: 'e2', type: 'Maintenance', title: 'Front brakes: pads fitted', ref: 'M-0012', date: '2026-10-16' },
      { id: 'e3', type: 'Purchase', title: 'Front brake pads', ref: 'P-0071', date: '2026-10-12', partNumber: 'BP1234' },
    ],
    documents: [{ id: 'd1', filename: 'Logbook.pdf', ref: 'A-0004', type: 'Logbook', mime: 'application/pdf' }],
    tasks: [{ id: 't1', name: 'Brake fluid change', kind: 'maintenance', dueDate: '2027-01-12' }, { id: 't2', name: 'MOT', kind: 'compliance', dueDate: '2027-11-17' }],
  },
  'getCarPage|c2': { entries: [{ id: 'e4', type: 'Issue', title: 'Headlight flicker', ref: 'I-0009', date: '2026-05-01' }], documents: [], tasks: [] },
  'getEntry|e3': { attachments: [{ id: 'a1', ref: 'A-0005', filename: 'Euro Car Parts receipt.pdf', mime: 'application/pdf' }] },
};
const read = (action, params) => saved[action === 'getCarPage' ? 'getCarPage|' + params.id : action === 'getEntry' ? 'getEntry|' + params.id : action];
const data = Search.collect(read);

test('everything saved is searchable: cars, entries, files (attachments and documents) and reminders', () => {
  assert.equal(data.cars.length, 2);
  assert.equal(data.entries.length, 4);
  assert.deepEqual(data.files.map((f) => f.id).sort(), ['A-0004', 'A-0005']);
  assert.equal(data.reminders.length, 2);
});

test('fewer than two characters finds nothing', () => {
  assert.equal(Search.find(data, '').total, 0);
  assert.equal(Search.find(data, 'b').total, 0);
});

test('a word is found in titles, notes, garages and part numbers, ignoring capitals', () => {
  assert.deepEqual(Search.find(data, 'BRAKE').entries.map((e) => e.id), ['M-0012', 'P-0071']);
  assert.deepEqual(Search.find(data, 'coding').entries.map((e) => e.id), ['I-0018']);
  assert.deepEqual(Search.find(data, 'perez').entries.map((e) => e.id), ['I-0018']);
  assert.deepEqual(Search.find(data, 'bp1234').entries.map((e) => e.id), ['P-0071']);
});

test('a registration is found with or without its space, and brings that car\'s entries, files and reminders with it', () => {
  const a = Search.find(data, 'mv56huh');
  assert.deepEqual(a.cars.map((c) => c.title), ['MV56 HUH']);
  assert.equal(a.entries.length, 3);
  assert.equal(a.files.length, 2);
  assert.equal(a.reminders.length, 2);
  assert.equal(Search.find(data, 'mv56 huh').cars.length, 1);
  assert.equal(Search.find(data, 'ua132fp').entries.length, 1);
});

test('IDs are searched, with or without the hyphen, and every word of the query must match', () => {
  assert.deepEqual(Search.find(data, 'a-00').files.map((f) => f.id).sort(), ['A-0004', 'A-0005']);
  assert.deepEqual(Search.find(data, 'a0005').files.map((f) => f.id), ['A-0005']);
  assert.deepEqual(Search.find(data, 'i-0018').entries.map((e) => e.title), ['Faulty ABS pump']);
  assert.deepEqual(Search.find(data, 'front pads').entries.map((e) => e.id), ['M-0012', 'P-0071']);
  assert.equal(Search.find(data, 'front kia').entries.length, 0);
  assert.equal(Search.find(data, 'zzz').total, 0);
});

test('results carry what the screen shows and needs to open them', () => {
  const car = Search.find(data, 'sorento').cars[0];
  assert.deepEqual([car.title, car.id, car.sub, car.carId], ['UA 132FP', 'UA 132FP', 'Kia Sorento (2013)', 'c2']);
  const e = Search.find(data, 'abs').entries[0];
  assert.deepEqual([e.id, e.entryId, e.carId, e.sub], ['I-0018', 'e1', 'c1', 'MV56 HUH · 2026-11-18']);
  const f = Search.find(data, 'receipt').files[0];
  assert.deepEqual([f.kind, f.fileId, f.sub], ['attachment', 'a1', 'On P-0071 · MV56 HUH']);
  assert.equal(Search.find(data, 'logbook').files[0].kind, 'document');
  const r = Search.find(data, 'mot').reminders[0];
  assert.deepEqual([r.id, r.taskId], ['', 't2']);
});

test('a title that starts with the query comes before one that only contains it; newer comes before older', () => {
  assert.deepEqual(Search.find(data, 'front').entries.map((e) => e.id), ['M-0012', 'P-0071'], 'both start with it: newer first');
  assert.deepEqual(Search.find(data, 'pads').entries.map((e) => e.id), ['M-0012', 'P-0071'], 'neither starts with it: newer first');
  assert.equal(Search.find(data, 'i-00').entries[0].id, 'I-0018', 'an ID that starts with it leads');
  assert.deepEqual(Search.find(data, 'brake').reminders.map((r) => r.title), ['Brake fluid change']);
});

test('nothing saved yet is simply an empty search', () => {
  const none = Search.collect(() => undefined);
  assert.equal(Search.find(none, 'anything').total, 0);
});
