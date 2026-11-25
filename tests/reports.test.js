'use strict';
// Inspection and diagnostic reports: reading them into issues, and saving what the person approved on the review screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const CAR = { registration: 'AB57 XYZ', make: 'Example', model: 'Saloon', year: '2008', odometer: '100000' };
const jpeg = (n) => { const b = Buffer.alloc(n || 50, 5); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0; return b.toString('base64'); };
const pdf = (n) => { const b = Buffer.alloc(n || 50, 32); Buffer.from('%PDF-1.4\n').copy(b); return b.toString('base64'); };
const answer = (obj) => ({ code: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } });

const code = (c, d, s) => ({ code: c, description: d, system: s, status: 'Current' });
// The shape of a real diagnostic scan (made-up car and no personal details): ten codes that are six problems.
const SCAN = {
  documentType: 'inspection_report', vendor: '', date: '2026-10-05', total: null, mileage: 123456, vehicleRegistration: 'AB57 XYZ', reportReference: 'SCAN-0001', confidence: 'high',
  issues: [
    { title: 'Variable gear ratio steering: lost contact with the steering angle sensor', codes: [code('C1595', 'Lost communication with steering angle sensor module', 'VGRS'), code('C1289', 'VGRS control system fault', 'ABS/VSC/TRC')] },
    { title: 'Air conditioning: solar sensor circuits', codes: [code('B1421', 'Passenger solar sensor circuit', 'Air conditioner'), code('B1424', 'Driver solar sensor circuit', 'Air conditioner'), code('B1428', 'Rear solar sensor circuit', 'Air conditioner')], tip: 'These can be set when scanned in the dark.' },
    { title: 'Air conditioning: communication fault', codes: [code('B1497', 'Communication fault (bus IC)', 'Air conditioner')] },
    { title: 'Radar cruise: brake faults', codes: [code('C1A50', 'Brake system', 'Radar cruise'), code('C1A51', 'Electric parking brake', 'Radar cruise')] },
    { title: 'Front parking sensors', codes: [code('C1AEC', 'Front sensor communication circuit', 'Clearance sonar')] },
    { title: 'Right headlamp swivel motor', codes: [code('B2413', 'Right headlamp swivel motor', 'AFS')], notes: 'Call 07700 900123 or email someone@example.com about it.' },
  ],
};

function setup() {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  env.props.GEMINI_API_KEY = 'AIza-test-key';
  const car = env.call('saveCar', { token: sam, fields: CAR }).data.car;
  const db = (js) => require('vm').runInContext(js, env.ctx);
  const samId = db("Db.all('Users').filter((u) => u.email === 'sam@example.com')[0].id");
  const upload = (extra) => env.call('uploadReceipt', Object.assign({ token: sam, mime: 'application/pdf', data: pdf(), filename: 'scan.pdf', carId: car.id, kind: 'Issue' }, extra || {}));
  const read = (id, extra) => env.call('readReceipt', Object.assign({ token: sam, id }, extra || {}));
  const get = (id) => env.call('getEntry', { token: sam, id }).data;
  const list = () => env.call('listEntries', { token: sam, carId: car.id }).data.entries;
  const spent = () => env.call('getCarCosts', { token: sam, carId: car.id }).data.currencies.map((x) => [x.currency, x.total]);
  const save = (payload, token) => env.call('saveReport', Object.assign({ token: token || sam, carId: car.id, date: '2026-10-05', mileage: '123456', identifiedBy: samId }, payload));
  return { env, admin, sam, car, db, samId, upload, read, get, list, spent, save };
}
const issueIn = (title, extra) => Object.assign({ title, notes: '', status: 'Not resolved', cost: '', currency: 'GBP', quoteCost: '', quoteCurrency: 'GBP' }, extra || {});

test('a report is read into issues, with the person\'s choice of type passed to the AI and no contact details kept', () => {
  const { env, upload, read, car } = setup();
  env.state.gemini = () => answer(SCAN);
  const up = upload().data.receipt;
  assert.deepEqual([up.chosenKind, up.kind, up.files.length], ['Issue', 'Issue', 1]);
  const r = read(up.id).data.receipt;
  assert.deepEqual([r.status, r.kind, r.carId, r.date, r.issueCount, r.data.mileage, r.data.reportRef], ['Pending', 'Issue', car.id, '2026-10-05', 6, 123456, 'SCAN-0001']);
  assert.deepEqual(r.data.issues.map((i) => i.codes.length), [2, 3, 1, 2, 1, 1]);
  assert.equal(r.data.issues[1].tip, 'These can be set when scanned in the dark.');
  assert.ok(!/07700|example\.com/.test(JSON.stringify(r.data)), 'phone numbers and email addresses are taken out');
  const sent = env.state.geminiRequests[0].body;
  assert.match(sent.contents[0].parts[0].text, /The person says it is an issue/);
  assert.match(sent.systemInstruction.parts[0].text, /ONE issue per real problem/);
  assert.ok(sent.generationConfig.responseSchema.properties.issues);
});

test('several photos are one item: all are shown to the AI, numbered, and it can be read again as another type', () => {
  const { env, sam, upload, read } = setup();
  env.state.gemini = () => answer({ documentType: 'inspection_report', vendor: '', date: '', total: null, issues: [{ title: 'Cracked mirror', photos: [2, 9] }] });
  const up = upload({ mime: 'image/jpeg', data: jpeg(), filename: 'a.jpg', thumb: jpeg(30) }).data.receipt;
  const add = (extra) => env.call('addReceiptFile', Object.assign({ token: sam, id: up.id, mime: 'image/jpeg', data: jpeg(80), filename: 'b.jpg' }, extra || {}));
  assert.equal(add().data.receipt.files.length, 2);
  assert.equal(add({ mime: 'text/plain' }).error, 'invalid_attachment');
  for (let i = 0; i < 6; i++) assert.equal(add().ok, true);
  assert.equal(add().error, 'too_many_files');
  const r = read(up.id).data.receipt;
  assert.deepEqual(r.data.issues[0].photos, [2], 'a photo number that does not exist is dropped');
  const parts = env.state.geminiRequests[0].body.contents[0].parts;
  assert.equal(parts.filter((x) => x.inline_data).length, 8);
  assert.equal(parts[1].text, 'File 1:');
  assert.equal(add().error, 'receipt_closed', 'no more once it has been read');
  assert.equal(env.call('getReceiptFile', { token: sam, id: up.id, index: 1 }).data.filename, 'b.jpg');
  assert.equal(env.call('getReceiptFile', { token: sam, id: up.id, index: 20 }).error, 'not_found');
  assert.equal(read(up.id, { kind: 'Purchase' }).data.receipt.kind, 'Purchase');
  assert.match(env.state.geminiRequests[1].body.contents[0].parts[0].text, /The person says it is a purchase receipt/);
  assert.equal(read(up.id, { kind: 'Nonsense' }).error, 'invalid_type');
});

test('saving the review makes one issue per problem, same date and mileage, linked to each other, with the report on every one', () => {
  const { env, sam, samId, upload, read, get, list, save, car } = setup();
  env.state.gemini = () => answer(SCAN);
  const up = upload().data.receipt;
  read(up.id);
  const all = [0, 1, 2, 3, 4, 5];
  const r = save({ receiptId: up.id, updateOdometer: true, issues: SCAN.issues.map((x, i) => issueIn(x.title, { notes: 'Codes: ' + x.codes.map((c) => c.code).join(', '), linkTo: all.filter((n) => n !== i) })) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.entries.length, 6);
  const saved = list();
  assert.equal(saved.length, 6);
  assert.deepEqual([...new Set(saved.map((e) => e.date + '|' + e.mileage + '|' + e.identifiedBy + '|' + e.vendor))], ['2026-10-05|123456|' + samId + '|Sam']);
  assert.equal(new Set(saved.map((e) => e.ref)).size, 6);
  const first = get(r.data.entries[0].id);
  assert.equal(first.linkedIssues.length, 5);
  assert.deepEqual(first.attachments.map((a) => a.filename), ['scan.pdf']);
  const refs = r.data.entries.map((e) => get(e.id).attachments[0].ref);
  assert.equal(new Set(refs).size, 6, 'each entry has its own attachment ID');
  assert.equal(env.call('getCar', { token: sam, id: car.id }).data.car.odometer, 123456);
  assert.equal(env.call('getInboxItem', { token: sam, id: up.id }).data.receipt.status, 'Approved');
  assert.equal(save({ receiptId: up.id, issues: [issueIn('Again')] }).error, 'receipt_closed');
});

test('one report file on several entries is stored once, and removing it from one leaves it for the others', () => {
  const { env, admin, upload, db, get, save } = setup();
  const up = upload().data.receipt;
  const r = save({ receiptId: up.id, issues: [issueIn('A'), issueIn('B')] });
  const ids = r.data.entries.map((e) => e.id);
  const drive = db("Db.all('Attachments').map((a) => a.drive_file_id)");
  assert.equal(drive.length, 2);
  assert.equal(drive[0], drive[1]);
  const trashed = () => db("DriveApp.getFileById('" + drive[0] + "').isTrashed()");
  env.call('deleteAttachment', { token: admin, id: get(ids[0]).attachments[0].id });
  assert.equal(trashed(), false, 'the other issue still has it');
  env.call('deleteAttachment', { token: admin, id: get(ids[1]).attachments[0].id });
  assert.equal(trashed(), true);
});

test('a fee or quote for the whole report is shared: shown on each, the fee counted once, until one is changed', () => {
  const { env, sam, get, list, spent, save } = setup();
  const shared = { cost: '60', quoteCost: '420', sharedFee: true, sharedQuote: true };
  const r = save({ issues: [issueIn('Pads', shared), issueIn('Discs', shared), issueIn('Wiper', { cost: '5' })] });
  assert.equal(r.ok, true, r.error);
  const by = (t) => list().find((e) => e.title === t);
  assert.deepEqual(['Pads', 'Discs', 'Wiper'].map((t) => [by(t).cost, by(t).feeShared, by(t).quoteCost, by(t).quoteShared]),
    [[60, true, 420, true], [60, true, 420, true], [5, false, null, false]]);
  assert.deepEqual(spent(), [['GBP', 65]], 'the shared fee once, plus the other fee; the quote never');
  // saving an issue without changing the amounts keeps it in the group
  const fields = (e, extra) => Object.assign({ title: e.title, date: e.date, mileage: String(e.mileage), cost: String(e.cost), currency: e.currency, quoteCost: String(e.quoteCost), quoteCurrency: e.quoteCurrency }, extra);
  const edit = (t, extra) => env.call('saveEntry', { token: sam, id: by(t).id, version: by(t).version, fields: fields(by(t), extra) });
  assert.equal(edit('Pads', { notes: 'just a note' }).ok, true);
  assert.equal(by('Pads').feeShared, true);
  // changing the amount on one takes it out: its new amount counts on its own, the others keep theirs
  assert.equal(edit('Pads', { cost: '40' }).ok, true);
  assert.deepEqual([by('Pads').cost, by('Pads').feeShared, by('Pads').quoteShared, by('Discs').cost, by('Discs').feeShared], [40, false, true, 60, false]);
  assert.deepEqual(spent(), [['GBP', 105]]);
  assert.equal(get(by('Discs').id).entry.quoteShared, true);
});

test('deleting an issue with a shared fee leaves the fee, still counted once', () => {
  const { env, admin, spent, save } = setup();
  const r = save({ issues: ['A', 'B', 'C'].map((t) => issueIn(t, { cost: '60', sharedFee: true })) });
  env.call('deleteEntry', { token: admin, id: r.data.entries[0].id });
  assert.deepEqual(spent(), [['GBP', 60]]);
});

test('a possible duplicate can be added to the existing issue instead, and new issues can be linked to existing ones', () => {
  const { sam, env, car, upload, get, list, save } = setup();
  const old = env.call('saveEntry', { token: sam, carId: car.id, type: 'Issue', fields: { title: 'Headlamp not moving', date: '2026-10-01', mileage: '181000', notes: 'Noticed at night.' } }).data.entry;
  const up = upload().data.receipt;
  const r = save({ receiptId: up.id, issues: [issueIn('Right headlamp swivel motor', { notes: 'B2413 Right headlamp swivel motor', appendTo: old.id }), issueIn('Parking sensor', { linkIds: [old.id] })] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.entries.map((e) => e.created), [false, true]);
  assert.equal(list().length, 2);
  const d = get(old.id);
  assert.match(d.entry.notes, /^Noticed at night\.\n\nAdded from a report dated 5 Oct 2026 at 123,456 mi: Right headlamp swivel motor\nB2413/);
  assert.deepEqual([d.entry.date, d.entry.mileage, d.entry.title], ['2026-10-01', 181000, 'Headlamp not moving']);
  assert.equal(d.attachments.length, 1);
  assert.deepEqual(d.linkedIssues.map((x) => x.title), ['Parking sensor']);
});

test('an invoice with faults saves the maintenance entry too; photos go to their own issue and the rest everywhere', () => {
  const { env, sam, upload, get, save, spent } = setup();
  const up = upload({ mime: 'application/pdf' }).data.receipt;
  env.call('addReceiptFile', { token: sam, id: up.id, mime: 'image/jpeg', data: jpeg(), filename: 'tyre.jpg', thumb: jpeg(20) });
  const r = save({ receiptId: up.id, vendor: 'City Garage', identifiedBy: '', issues: [issueIn('Rear tyre worn', { files: [1] })], maintenance: { title: 'Full service', total: '185', currency: 'GBP', notes: 'Oil and filters', vendor: 'City Garage' } });
  assert.equal(r.ok, true, r.error);
  const [issue, job] = r.data.entries;
  assert.deepEqual([issue.type, job.type, job.lumpSumCost, issue.vendor], ['Issue', 'Maintenance', 185, 'City Garage']);
  assert.deepEqual(get(issue.id).attachments.map((a) => [a.filename, a.thumb]).sort(), [['scan.pdf', false], ['tyre.jpg', true]]);
  assert.deepEqual(get(job.id).attachments.map((a) => a.filename), ['scan.pdf']);
  assert.deepEqual(spent(), [['GBP', 185]]);
});

test('everything is checked before anything is saved: date, mileage, titles, amounts and links', () => {
  const { env, sam, list, save, car } = setup();
  const ok = issueIn('Fine');
  assert.equal(save({ date: '', issues: [ok] }).error, 'date_required');
  assert.equal(save({ date: '2999-01-01', issues: [ok] }).error, 'invalid_date');
  assert.equal(save({ mileage: '', issues: [ok] }).error, 'mileage_required');
  assert.equal(save({ mileage: 'lots', issues: [ok] }).error, 'invalid_odometer');
  assert.equal(save({ issues: [] }).error, 'nothing_to_save');
  assert.equal(save({ issues: [ok, issueIn('  ')] }).error, 'title_required');
  assert.equal(save({ issues: [ok, issueIn('B', { cost: 'free' })] }).error, 'invalid_cost');
  assert.equal(save({ issues: [ok, issueIn('B', { appendTo: 'nope' })] }).error, 'not_found');
  assert.equal(save({ issues: [ok, issueIn('B', { linkIds: ['nope'] })] }).error, 'not_found');
  assert.equal(save({ issues: [ok], maintenance: { title: '', total: '1' } }).error, 'title_required');
  assert.equal(save({ carId: 'nope', issues: [ok] }).error, 'not_found');
  assert.equal(env.call('saveReport', { carId: car.id, issues: [ok] }).error, 'unauthorized');
  assert.equal(list().length, 0, 'nothing was written by any of those');
  assert.ok(sam);
});

test('adding to an existing issue never loses a fee: it takes it where it has none, otherwise the amount is written in its notes', () => {
  const { sam, env, car, list, spent, save } = setup();
  const make = (title, extra) => env.call('saveEntry', { token: sam, carId: car.id, type: 'Issue', fields: Object.assign({ title, date: '2026-10-01' }, extra || {}) }).data.entry;
  const free = make('No fee yet');
  const paid = make('Has a fee', { cost: '25', currency: 'GBP' });
  const shared = { cost: '60', quoteCost: '420', sharedFee: true, sharedQuote: true };
  const r = save({ issues: [issueIn('A', Object.assign({ appendTo: free.id }, shared)), issueIn('B', Object.assign({ appendTo: paid.id }, shared)), issueIn('C', shared)] });
  assert.equal(r.ok, true, r.error);
  const by = (t) => list().find((e) => e.title === t);
  assert.deepEqual([by('No fee yet').cost, by('No fee yet').feeShared, by('C').cost, by('C').feeShared], [60, true, 60, true]);
  assert.equal(by('Has a fee').cost, 25, 'its own fee is not overwritten');
  assert.match(by('Has a fee').notes, /Inspection fee on this report: GBP 60/);
  assert.equal(by('Has a fee').quoteCost, 420, 'it had no quote, so it takes this one');
  assert.deepEqual(spent(), [['GBP', 85]], 'the report fee once, and the old one');
});
