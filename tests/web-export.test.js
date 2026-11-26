'use strict';
// The vehicle data export: the PDF writer, the ZIP writer and the report that goes in the PDF.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const zlib = require('zlib');

require('../web/pdfkit.js');
require('../web/zipkit.js');
require('../web/exportreport.js');
const { PdfKit, ZipKit, ExportReport } = globalThis;

// a JPEG with a valid header (enough for the size to be read) and a recognisable body
function fakeJpeg(w, h, comps) {
  const body = Buffer.alloc(200, 7);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, comps || 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), body, Buffer.from([0xff, 0xd9])]));
}

/** The text of every page, in order: what a reader would see, one string per page. */
function pdfText(bytes) {
  const s = Buffer.from(bytes).toString('latin1');
  const pages = [];
  const re = /stream\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(s))) {
    if (!/BT /.test(m[1])) continue;
    const parts = [];
    const tj = /\((?:\\.|[^\\)])*\) Tj/g;
    let t;
    while ((t = tj.exec(m[1]))) parts.push(t[0].slice(1, -4).replace(/\\([0-7]{3})/g, (x, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\([()\\])/g, '$1'));
    pages.push(parts.join(' ').replace(/\s+/g, ' '));
  }
  return pages;
}

function checkStructure(bytes) {
  const s = Buffer.from(bytes).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'), 'header');
  assert.ok(s.trimEnd().endsWith('%%EOF'), 'trailer');
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)[1]);
  assert.ok(s.slice(startxref).startsWith('xref\n'), 'startxref points at the table');
  const lines = s.slice(startxref).split('\n');
  const size = Number(lines[1].split(' ')[1]);
  assert.equal(lines[2], '0000000000 65535 f ');
  for (let id = 1; id < size; id++) {
    const off = Number(lines[2 + id].slice(0, 10));
    assert.ok(s.slice(off).startsWith(id + ' 0 obj\n'), 'object ' + id + ' is where the table says');
  }
  const pages = Number(/\/Count (\d+)/.exec(s)[1]);
  assert.equal((s.match(/\/Type \/Page /g) || []).length, pages);
  // every stream's declared length is right
  const re = /<< \/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(s))) assert.equal(s.slice(m.index + m[0].length + Number(m[1])).startsWith('endstream'), true, 'stream length');
  return { pages, size };
}

// ---------- PDF writer ----------
test('the PDF is well formed: header, objects where the table says, right stream lengths, page numbers', () => {
  const doc = PdfKit.create({ footer: 'Footer text' });
  doc.heading('Title', 1);
  for (let i = 0; i < 160; i++) doc.text('Line number ' + i + ' of some text that runs for a while so it wraps onto more than one line when the page is full of it', { size: 10 });
  const bytes = doc.finish({ title: 'Test' });
  const { pages } = checkStructure(bytes);
  assert.ok(pages >= 3, 'long content flows onto more pages: ' + pages);
  const text = pdfText(bytes);
  assert.equal(text.length, pages);
  text.forEach((t, i) => assert.ok(t.includes('Page ' + (i + 1) + ' of ' + pages), 'page ' + (i + 1) + ' is numbered'));
  assert.ok(text[0].includes('Footer text'));
});

test('text is wrapped to the page, long words are split, and characters outside the fonts become ?', () => {
  assert.equal(PdfKit.encode('£12.50 – café · ×2'), '£12.50 \u0096 café · ×2');
  assert.equal(PdfKit.encode('Oil 💧 bulb 💡'), 'Oil  bulb ');
  assert.equal(PdfKit.encode('日本'), '??');
  const doc = PdfKit.create();
  doc.text('x'.repeat(400)); // one enormous word
  doc.text('(brackets) and \\ backslash');
  const bytes = doc.finish();
  checkStructure(bytes);
  const t = pdfText(bytes)[0];
  assert.ok(t.includes('(brackets) and \\ backslash'), 'special characters survive');
  assert.ok(PdfKit.textWidth('iiii', 'F1', 10) < PdfKit.textWidth('WWWW', 'F1', 10), 'real character widths are used');
});

test('JPEGs are embedded as they are, with pictures and captions placed on the page', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(PdfKit.jpegInfo(fakeJpeg(320, 240)))), { width: 320, height: 240, components: 3 });
  assert.equal(PdfKit.jpegInfo(new Uint8Array([1, 2, 3, 4, 5])), null);
  const doc = PdfKit.create();
  doc.image(fakeJpeg(1280, 960), { maxWidth: 300, maxHeight: 200 });
  doc.pictures([{ bytes: fakeJpeg(320, 240), caption: 'A-0001' }, { bytes: fakeJpeg(240, 320), caption: 'A-0002' }, { bytes: new Uint8Array([9, 9, 9]), caption: 'A-0003' }]);
  const bytes = doc.finish();
  const { size } = checkStructure(bytes);
  const s = Buffer.from(bytes).toString('latin1');
  assert.equal((s.match(/\/Filter \/DCTDecode/g) || []).length, 3, 'three usable pictures, the broken one is skipped');
  assert.ok(s.includes('/Width 1280 /Height 960'));
  assert.ok(pdfText(bytes)[0].includes('A-0001') && pdfText(bytes)[0].includes('A-0002') && !pdfText(bytes)[0].includes('A-0003'));
  assert.ok(size > 8);
});

// ---------- ZIP writer ----------
test('the ZIP opens with the standard tools, with folders, UTF-8 names and the right contents', () => {
  const zip = ZipKit.create(new Date(2026, 10, 21, 9, 30, 0));
  const pdf = new Uint8Array(Buffer.from('%PDF-1.4 hello'));
  const photo = new Uint8Array(Buffer.alloc(5000, 3));
  zip.add('Vehicle data - AB12 CDE.pdf', pdf);
  zip.add('A-0001/photo one.jpg', photo);
  zip.add('A-0002/Café invoice £5.pdf', new Uint8Array(Buffer.from('%PDF second')));
  zip.add('A-0003/empty.txt', new Uint8Array(0));
  const bytes = zip.finish();
  assert.equal(zip.count(), 4);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipcheck-'));
  const file = path.join(dir, 'out.zip');
  fs.writeFileSync(file, bytes);
  const test = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
  assert.equal(test.status, 0, test.stdout + test.stderr);
  assert.match(test.stdout, /No errors detected/);
  const py = spawnSync('python3', ['-c', `
import zipfile, sys, json
z = zipfile.ZipFile(sys.argv[1])
out = {n: len(z.read(n)) for n in z.namelist()}
print(json.dumps({'names': z.namelist(), 'sizes': out, 'bad': z.testzip()}, ensure_ascii=False))
`, file], { encoding: 'utf8' });
  const got = JSON.parse(py.stdout);
  assert.equal(got.bad, null);
  assert.deepEqual(got.names, ['Vehicle data - AB12 CDE.pdf', 'A-0001/photo one.jpg', 'A-0002/Café invoice £5.pdf', 'A-0003/empty.txt']);
  assert.equal(got.sizes['A-0001/photo one.jpg'], 5000);
  fs.rmSync(dir, { recursive: true });
});

test('crc32 matches the standard one, and file names are made safe', () => {
  const data = new Uint8Array(Buffer.from('The quick brown fox jumps over the lazy dog'));
  assert.equal(ZipKit.crc32(data), zlib.crc32 ? zlib.crc32(Buffer.from(data)) : 0x414fa339);
  assert.equal(ZipKit.safeName('a/b\\c:d*e?.pdf'), 'a_b_c_d_e_.pdf');
  assert.equal(ZipKit.safeName('..hidden'), 'hidden');
  assert.equal(ZipKit.safeName('', 'file'), 'file');
  assert.ok(ZipKit.safeName('x'.repeat(300)).length <= 120);
});

// ---------- the report ----------
function sample() {
  const car = { id: 'c1', registration: 'AB12 CDE', make: 'Toyota', model: 'Land Cruiser', year: 2015, colour: 'White', vin: 'JTMHV05J604123456', engineCode: '1VD', gearboxCode: '', country: 'UG', market: 'European', driveSide: 'RHD', engineSize: 4.5, fuelCapacity: 93, importDate: '2026-05', acquisitionDate: '2021-03', acquisitionCost: 4500.5, acquisitionCurrency: 'USD', currency: 'UGX', status: 'Active', odometer: 51200, odometerUpdatedAt: '2026-11-01T10:00:00Z', notes: 'Spare key with Sam.', guestEnabled: true, partsouqUrl: 'https://partsouq.com/en/catalog/genuine/', updatedAt: '2026-11-02T09:00:00Z', ownerOther: '' };
  const m = { id: 'e1', ref: 'M-0007', type: 'Maintenance', title: 'Front brake pads', date: '2026-10-02', mileage: 50100, vendor: 'Joe\'s Garage', currency: 'GBP', costMode: 'itemised', labourCost: 90, labourCurrency: 'GBP', labourNote: 'Joe', labourHours: 1.5, otherCost: 5, otherCurrency: 'GBP', otherNote: 'disposal', notes: 'Used the Bosch pads', guestName: '' };
  const i = { id: 'e2', ref: 'I-0003', type: 'Issue', title: 'Squeaky brakes', date: '2026-09-20', mileage: 50000, status: 'Resolved', cost: 0, currency: 'GBP', notes: '' };
  const p = { id: 'e3', ref: 'P-0002', type: 'Purchase', title: 'Pads (front)', date: '2026-09-25', quantity: 1, unitCost: 60, currency: 'GBP', partNumber: '04465-60320', productUrl: 'https://example.com/pads', shippingCost: 4 };
  const details = {
    e1: { entry: m, car: { id: 'c1' }, attachments: [{ id: 'a1', ref: 'A-0001', filename: 'invoice.pdf', mime: 'application/pdf', size: 20480 }, { id: 'a2', ref: 'A-0002', filename: 'pads.jpg', mime: 'image/jpeg', size: 300000 }, { id: 'a3', ref: 'A-0003', filename: 'quote.xlsx', mime: 'application/octet-stream', size: 5000 }],
      parts: [{ name: 'Pads (front)', partNumber: '04465-60320', quantity: 1, cost: 64, currency: 'GBP' }], jobCost: { GBP: 159 }, linkedIssues: [{ id: 'e2', ref: 'I-0003', title: 'Squeaky brakes', resolves: true }], reminder: { id: 't1', name: 'Brake check' } },
    e2: { entry: i, car: { id: 'c1' }, attachments: [], fixedBy: [{ id: 'e1', title: 'Front brake pads', date: '2026-10-02' }], foundWith: [{ date: '2026-10-01', issues: [{ id: 'e9', ref: 'I-0004', title: 'Loose trim' }] }] },
    e3: { entry: p, car: { id: 'c1' }, attachments: [], stock: { used: 1, remaining: 0, status: 'Fitted', total: 64 }, usedIn: [{ id: 'e1', title: 'Front brake pads', quantity: 1 }] },
  };
  return {
    car, people: { owners: [{ userId: 'u1', name: 'Sam' }] }, entries: [m, i, p], details,
    fluids: [{ fluid: 'Engine oil', specification: '0W-20', capacity: '9.0 L', notes: 'Check', kind: '' }, { fluid: 'Dipped beam', specification: 'D4S', capacity: '2', notes: '', kind: 'bulb' }],
    tasks: [{ name: 'MOT', kind: 'compliance', active: true, text: 'Due 1 Jan 2027', status: 'ok', repeatText: '12 months', dueDate: '2027-01-01', lastDoneDate: '2026-01-02', lastDoneDistance: 48000 }],
    costs: { currencies: [{ currency: 'GBP', total: 159, categories: { labour: 90, parts: 64, other: 5 }, years: [{ year: '2026', total: 159, categories: { labour: 90, parts: 64, other: 5 } }] }] },
    documents: [{ id: 'd1', ref: 'A-0004', type: 'Logbook', note: 'V5C', filename: 'logbook.pdf', mime: 'application/pdf', size: 90000, createdAt: '2026-11-01T10:00:00Z' }],
    carPhoto: fakeJpeg(1280, 960), thumbs: { a2: fakeJpeg(320, 240) }, missing: { a3: true },
    exportedBy: 'Perez Kabagambe', exportedAt: new Date('2026-11-21T10:00:00Z'),
  };
}

test('the report opens with the short explanation, then every section in full', () => {
  const bytes = ExportReport.build(Object.assign(sample(), { include: { buyCost: true } }));
  checkStructure(bytes);
  const pages = pdfText(bytes);
  const all = pages.join(' ');
  // the explanation is at the top of the first page, in the agreed words
  const first = pages[0];
  assert.ok(first.indexOf('Vehicle data export') < first.indexOf('This is an export of your vehicle'));
  assert.ok(first.includes('This is an export of your vehicle\'s data from Fleet Manager by Potentia Motus.'));
  assert.ok(first.includes('Every document, photo or PDF listed here has been saved in its own folder, named after its unique reference in this document.'));
  assert.ok(first.includes('For example, the file A-0002 is in the folder A-0002.'));
  assert.ok(ExportReport.INTRO.length < 330, 'and it is short');
  assert.ok(first.includes('Exported on 21 Nov 2026 by Perez Kabagambe'));

  for (const heading of ['Vehicle details', 'Odometer Log', 'Maintenance & Issues Log', 'Reminders', 'Fluids, Bulbs & Specifications', 'Documents', 'Costs']) assert.ok(all.includes(heading), heading);
  for (const bit of ['JTMHV05J604123456', 'Uganda', 'Right-hand drive (RHD)', '93 litres', '4.5 litres', 'May 2026', 'US$4,500.50', 'Owner / custodian Sam', '51,200 mi', '1 Nov 2026']) assert.ok(all.includes(bit), bit);
  // entries: reference, type-specific fields and the costs
  for (const bit of ['M-0007', 'Front brake pads', '£90.00 (Joe)', ', 1.5 h', 'Pads (front) [04465-60320] x 1 = £64.00', 'Total job cost £159.00', 'Related issues I-0003 Squeaky brakes (resolved by this)', 'Reminder Brake check', 'Used the Bosch pads',
    'I-0003', 'Fixed by Front brake pads (2 Oct 2026)', 'Found at the same time Report of 1 Oct 2026: I-0004 Loose trim (the faults are not necessarily related)', 'P-0002', 'Fitted (used 1, 0 left)', 'Used in Front brake pads x 1']) assert.ok(all.includes(bit), bit);
  // files: every one by its ID and folder, pictures captioned, a file that could not be saved marked
  assert.ok(all.includes('A-0001 invoice.pdf · PDF · 20 KB · folder A-0001'));
  assert.ok(all.includes('A-0002 pads.jpg · Photo · 293 KB · folder A-0002'));
  assert.ok(all.includes('A-0003 quote.xlsx · File · 5 KB · NOT INCLUDED'));
  assert.ok(all.includes('A-0004 Logbook') && all.includes('Folder A-0004'));
  // fluids, reminders, costs
  for (const bit of ['Engine oil', '0W-20', 'Dipped beam', 'D4S', 'MOT (compliance)', 'Repeats every 12 months', 'Spent in GBP: £159.00', 'Labour £90.00']) assert.ok(all.includes(bit), bit);
  const raw = Buffer.from(bytes).toString('latin1');
  assert.equal((raw.match(/\/Filter \/DCTDecode/g) || []).length, 2, 'the car photo and the one entry picture');
});

/** The whole PDF as one string, for a sample with these ticks changed from how the export options open. */
function exported(include, change) {
  const s = Object.assign(sample(), { include });
  if (change) change(s);
  const bytes = ExportReport.build(s);
  checkStructure(bytes);
  return pdfText(bytes).join(' ');
}
const has = (all, bits) => bits.forEach((bit) => assert.ok(all.includes(bit), 'missing: ' + bit));
const hasNot = (all, bits) => bits.forEach((bit) => assert.ok(!all.includes(bit), 'should be left out: ' + bit));
const withTip = (s) => { s.details.e2.entry.aiTips = [{ id: 't1', text: 'Clean the pads before replacing them.', source: 'report', date: '2026-09-20' }]; };

test('the export options open with everything ticked but AI tips and what the car cost to buy', () => {
  assert.deepEqual(Object.keys(ExportReport.DEFAULTS).filter((k) => !ExportReport.DEFAULTS[k]).sort(), ['aiTips', 'buyCost']);
  assert.equal(Object.keys(ExportReport.DEFAULTS).length, 12);
  const all = exported(undefined, withTip);
  has(all, ['Vehicle details', 'Spent in GBP: £159.00', '£90.00 (Joe)']);
  hasNot(all, ['US$4,500.50', 'Acquisition cost', 'Clean the pads', 'These totals cover only']);
});

test('AI tips and the cost of buying the car are printed only when ticked', () => {
  has(exported({ aiTips: true, buyCost: true }, withTip), ['AI tip Clean the pads before replacing them. (AI\'s own advice, not from a report or garage. It can be wrong.)', 'Acquisition cost US$4,500.50']);
  hasNot(exported({ aiTips: true, issues: false }, withTip), ['Clean the pads']);
  const alone = exported({ vehicle: false, buyCost: true });
  has(alone, ['What the car cost to buy', 'US$4,500.50']);
  hasNot(alone, ['Vehicle details', 'JTMHV05J604123456', 'Car details last changed']);
});

test('each section and entry type can be left out, along with lines that point at what is left out', () => {
  const noSections = exported({ odometer: false, reminders: false, fluids: false, carFiles: false });
  hasNot(noSections, ['Odometer Log', 'Repeats every', 'Reminder Brake check', 'Fluids, Bulbs', 'Engine oil', 'A-0004', 'logbook.pdf']);
  has(noSections, ['M-0007', 'A-0001 invoice.pdf']);
  const noIssues = exported({ issues: false });
  hasNot(noIssues, ['I-0003', 'Related issues', 'Found at the same time']);
  has(noIssues, ['M-0007', 'P-0002', '2 entries, newest first.']);
  hasNot(exported({ maintenance: false }), ['M-0007', 'Fixed by', 'Used in']);
  hasNot(exported({ purchases: false }), ['P-0002']);
  hasNot(exported({ issues: false, maintenance: false, purchases: false }), ['Maintenance & Issues Log']);
});

test('running totals add up only what is in the export, and say so', () => {
  const noPurchases = exported({ purchases: false });
  has(noPurchases, ['Spent in GBP: £95.00', 'These totals cover only Issues, Maintenance and reminder renewals. Not included: Purchased items.']);
  hasNot(noPurchases, ['Spent in GBP: £159.00', 'Parts £64.00', 'parts £64.00']);
  has(exported({ maintenance: false }), ['Spent in GBP: £64.00', 'Not included: Maintenance.']);
  const none = exported({ issues: false, maintenance: false, purchases: false, reminders: false });
  has(none, ['No costs recorded for what is in this export.', 'There are no totals']);
  assert.deepEqual(ExportReport.totalsCover({}), { all: true, none: false, covers: 'Issues, Maintenance, Purchased items and reminder renewals', leftOut: '' });
  const f = ExportReport.filterCosts({ currencies: [{ currency: 'GBP', total: 35.3, categories: { compliance: 35.3 }, years: [{ year: '2026', total: 35.3, categories: { compliance: 35.3 } }] }] }, { reminders: false });
  assert.deepEqual(f, { currencies: [] });
});

test('with running costs unticked no amount is printed anywhere, but the work itself still is', () => {
  const s = () => { const x = sample(); x.details.e2.entry.cost = 60; x.details.e2.entry.quoteCost = 420; return x; };
  const all = pdfText(ExportReport.build(Object.assign(s(), { include: { costs: false } }))).join(' ');
  assert.ok(!/[£$]\s?\d|US\$|UGX\s?\d/.test(all), 'no money: ' + (all.match(/.{30}[£$]\s?\d.{10}/) || [''])[0]);
  hasNot(all, ['Spent in', 'Invoice total', 'Total job cost', 'Unit cost', 'Shipping', 'Inspection fee', 'Quoted repair', 'Each cost is counted']);
  has(all, ['Labour (Joe), 1.5 h', 'Other work disposal', 'Pads (front) [04465-60320] x 1', 'Fitted (used 1, 0 left)']);
  const items = exported({ costs: false }, (x) => { x.details.e3 = { entry: x.entries[2], attachments: [], items: [{ id: 'i1', name: 'Brake pads', quantity: 2, unitCost: 30, lineTotal: 60, used: 1, remaining: 1 }], stock: { used: 1, remaining: 1, status: 'Partly used', total: 60 } }; });
  has(items, ['Brake pads · quantity 2 · used 1, 1 left']);
});

test('without any files the PDF doesn\'t talk about folders, and the download is a PDF', () => {
  const all = exported({ carFiles: false, entryFiles: false });
  hasNot(all, ['saved in its own folder', 'Files (3)', 'A-0001', 'A-0004']);
  has(all, [ExportReport.ABOUT]);
  assert.equal(ExportReport.effective({ carFiles: false, entryFiles: false }).files, false);
  assert.equal(ExportReport.effective({ carFiles: false, issues: false, maintenance: false, purchases: false }).files, false, 'entry files need entries');
  const nothing = {};
  Object.keys(ExportReport.DEFAULTS).forEach((k) => { nothing[k] = false; });
  assert.equal(ExportReport.effective(nothing).content, false);
  assert.equal(ExportReport.effective(Object.assign(nothing, { aiTips: true, entryFiles: true })).content, false);
});

test('the export never includes who created the car or an entry', () => {
  const s = sample();
  s.car.createdByName = 'Zebediah Creator'; s.car.createdAt = '2026-01-05T09:00:00Z';
  s.entries.forEach((e) => { e.createdByName = 'Zebediah Creator'; e.createdAt = '2026-01-06T09:00:00Z'; e.createdBy = 'user-id-123'; });
  Object.values(s.details).forEach((d) => { d.entry.createdByName = 'Zebediah Creator'; d.entry.createdBy = 'user-id-123'; });
  const all = pdfText(ExportReport.build(s)).join(' ');
  assert.ok(!all.includes('Zebediah'), 'no creator name');
  assert.ok(!all.includes('user-id-123'), 'no creator id');
  assert.ok(!/(Created|Logged) by/i.test(all), 'no created-by or logged-by line');
});

test('a purchase with several items lists every item, its quantity, price and use', () => {
  const s = sample();
  s.details.e3 = { entry: s.entries[2], car: { id: 'c1' }, attachments: [], items: [
    { id: 'i1', name: 'Brake pads', partNumber: 'BP-1', quantity: 2, unitCost: 30, lineTotal: 60, used: 1, remaining: 1 },
    { id: 'i2', name: 'Brake discs', partNumber: '', quantity: 2, unitCost: 45.5, lineTotal: 91, used: 0, remaining: 2 }],
    stock: { used: 1, remaining: 3, status: 'Partly used', total: 151, perUnit: null }, usedIn: [{ id: 'e1', title: 'Front brake pads', quantity: 1, item: 'Brake pads' }] };
  const t = pdfText(ExportReport.build(s)).join(' ');
  for (const bit of ['Item 1 Brake pads [BP-1] · 2 x £30.00 = £60.00 · used 1, 1 left', 'Item 2 Brake discs · 2 x £45.50 = £91.00 · used 0, 2 left', 'Total £151.00', 'Partly used (used 1, 3 left)', 'Used in Front brake pads x 1 (Brake pads)']) assert.ok(t.includes(bit), bit);
});

test('the guest QR secret never appears, and an empty car still makes a valid document', () => {
  const s = sample();
  s.car.guestSecret = 'SECRET-SECRET-SECRET';
  assert.ok(!Buffer.from(ExportReport.build(s)).toString('latin1').includes('SECRET-SECRET'));
  const empty = { car: Object.assign({}, s.car, { notes: '', vin: '', acquisitionCost: null, odometer: null, odometerUpdatedAt: '' }), people: { owners: [] }, entries: [], details: {}, fluids: [], tasks: [], costs: { currencies: [] }, documents: [], carPhoto: null, thumbs: {}, missing: {} };
  const bytes = ExportReport.build(empty);
  checkStructure(bytes);
  const t = pdfText(bytes).join(' ');
  for (const bit of ['No entries.', 'No reminders.', 'None recorded.', 'No documents.', 'No costs recorded.', 'Not recorded', 'Not set']) assert.ok(t.includes(bit), bit);
});

test('a big car (200 entries, many files) flows over many pages and stays well formed', () => {
  const s = sample();
  s.entries = []; s.details = {};
  for (let n = 0; n < 200; n++) {
    const e = { id: 'x' + n, ref: 'M-' + String(n + 1).padStart(4, '0'), type: 'Maintenance', title: 'Job ' + n, date: '2026-10-02', mileage: 1000 + n, currency: 'GBP', costMode: 'lump', lumpSumCost: 10, lumpCurrency: 'GBP', notes: 'Notes for job ' + n + ' '.repeat(2) + 'word '.repeat(40) };
    s.entries.push(e);
    s.details['x' + n] = { entry: e, car: { id: 'c1' }, attachments: [{ id: 'at' + n, ref: 'A-' + String(n + 10).padStart(4, '0'), filename: 'p' + n + '.jpg', mime: 'image/jpeg', size: 1000 }], jobCost: { GBP: 10 } };
    s.thumbs['at' + n] = fakeJpeg(320, 240);
  }
  const bytes = ExportReport.build(s);
  const { pages } = checkStructure(bytes);
  assert.ok(pages > 20);
  assert.ok(pdfText(bytes).join(' ').includes('Job 199'));
});
