'use strict';
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
  const up = (extra, token) => env.call('uploadCarDocument', Object.assign({ token: token || sam, carId: car.id, type: 'Other', mime: 'application/pdf', data: pdf(2000), filename: 'policy.pdf' }, extra || {}));
  const list = (token) => env.call('listCarDocuments', { token: token || sam, carId: car.id });
  return { env, admin, sam, car, up, list };
}

function jpeg(size) {
  const b = Buffer.alloc(size, 5);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  return b.toString('base64');
}
function pdf(size) {
  const b = Buffer.alloc(size, 32);
  Buffer.from('%PDF-1.4\n').copy(b);
  return b.toString('base64');
}

test('car document actions need a session; only admins remove', () => {
  const { env, sam, car, up } = setup();
  const d = up().data.document;
  ['listCarDocuments', 'uploadCarDocument', 'getCarDocument', 'deleteCarDocument']
    .forEach((a) => assert.equal(env.call(a, { carId: car.id, id: d.id }).error, 'unauthorized', a));
  assert.equal(env.call('deleteCarDocument', { token: sam, id: d.id }).error, 'forbidden');
});

test('a PDF and a photo can be added with a type and note; there is no limit on how many', () => {
  const { sam, up, list } = setup();
  const a = up({ type: 'Logbook', note: '  Original V5C  ', filename: 'v5c' }).data.document;
  assert.equal(a.type, 'Logbook');
  assert.equal(a.note, 'Original V5C');
  assert.equal(a.filename, 'v5c.pdf');
  assert.equal(up({ type: 'Import papers', mime: 'image/jpeg', data: jpeg(3000), filename: 'form.jpg' }).ok, true);
  for (let i = 0; i < 25; i++) assert.equal(up({ type: 'Other', filename: 'extra' + i }).ok, true, 'document ' + i);
  assert.equal(list().data.documents.length, 27);
  assert.equal(list(sam).ok, true);
});

test('every document type is accepted; others are refused', () => {
  const { up } = setup();
  ['Logbook', 'Import papers', 'Other']
    .forEach((t) => assert.equal(up({ type: t }).data.document.type, t, t));
  ['Insurance', 'MOT / inspection', 'Receipt / invoice', 'Love letter'].forEach((t) => assert.equal(up({ type: t }).error, 'invalid_document_type', t + ' is no longer offered'));
  assert.equal(up({ type: '' }).error, 'invalid_document_type');
  assert.equal(up({ type: undefined }).error, 'invalid_document_type');
});

test('a document saved with a type that is no longer offered keeps that type', () => {
  const { env, up, list } = setup();
  const d = up({ type: 'Logbook' }).data.document;
  const header = env.sheets.CarDocuments._rows[0];
  env.sheets.CarDocuments._rows.find((r) => r[0] === d.id)[header.indexOf('doc_type')] = 'Insurance';
  env.invalidate();
  assert.equal(list().data.documents[0].type, 'Insurance');
});

test('JPEGs and PDFs are checked by their first bytes; other files are accepted within the limits', () => {
  const { up, list } = setup();
  assert.equal(up({ mime: 'text/plain', data: Buffer.from('hello').toString('base64'), filename: 'note.txt' }).ok, true, 'any other file');
  assert.equal(up({ mime: 'application/x-msdownload', data: Buffer.from('MZ').toString('base64'), filename: 'run.exe' }).error, 'file_type_not_allowed');
  assert.equal(up({ mime: 'image/jpeg', data: pdf(100) }).error, 'invalid_photo', 'a PDF pretending to be a JPEG');
  assert.equal(up({ mime: 'application/pdf', data: jpeg(100) }).error, 'invalid_attachment', 'a JPEG pretending to be a PDF');
  assert.equal(up({ data: '' }).error, 'invalid_attachment');
  assert.equal(up({ data: pdf(5000001) }).error, 'attachment_too_large');
  assert.equal(up({ mime: 'image/jpeg', data: jpeg(1500001) }).error, 'photo_too_large');
  assert.equal(up({ data: pdf(5000000) }).ok, true, 'exactly at the limit');
  assert.equal(list().data.documents.length, 2, 'refused files leave nothing behind (the text file and the PDF at the limit)');
  assert.equal(up({ note: 'x'.repeat(500) }).data.document.note.length, 200);
});

test('unknown and deleted cars take no documents', () => {
  const { env, admin, car, up } = setup();
  assert.equal(env.call('uploadCarDocument', { token: admin, carId: 'nope', type: 'Other', mime: 'application/pdf', data: pdf(100) }).error, 'not_found');
  assert.equal(env.call('listCarDocuments', { token: admin, carId: 'nope' }).error, 'not_found');
  const d = up().data.document;
  env.call('deleteCar', { token: admin, id: car.id });
  assert.equal(up().error, 'not_found');
  assert.equal(env.call('getCarDocument', { token: admin, id: d.id }).ok, true, 'an admin can still reach a deleted car');
});

test('a document is read back through its record, newest first, and only admins remove it', () => {
  const { env, admin, sam, car, up, list } = setup();
  const data = pdf(4000);
  const a = up({ data, filename: 'first.pdf' }).data.document;
  env.advance(1000);
  const b = up({ filename: 'second.pdf' }).data.document;
  assert.deepEqual(list().data.documents.map((d) => d.id), [b.id, a.id]);
  const back = env.call('getCarDocument', { token: sam, id: a.id }).data;
  assert.equal(back.filename, 'first.pdf');
  assert.equal(back.mime, 'application/pdf');
  assert.equal(back.data, data);
  assert.equal(env.call('getCarDocument', { token: sam, id: 'nope' }).error, 'not_found');
  assert.equal(env.call('getCarDocument', { token: sam, id: a.id, fileId: 'other' }).data.data, data, 'a file id from the caller is ignored');

  assert.equal(env.call('deleteCarDocument', { token: sam, id: a.id }).error, 'forbidden');
  assert.equal(env.call('deleteCarDocument', { token: admin, id: a.id }).ok, true);
  assert.equal(env.call('getCarDocument', { token: sam, id: a.id }).error, 'not_found');
  assert.deepEqual(list().data.documents.map((d) => d.id), [b.id]);
  assert.equal(env.call('deleteCarDocument', { token: admin, id: a.id }).error, 'not_found');
  assert.ok(Object.keys(env.files).some((k) => env.files[k].trashed), 'the file goes to the Drive trash');
  assert.equal(env.call('getCarPage', { token: sam, id: car.id }).data.documents.length, 1);
});

test('the car page carries the documents, and they are not mixed up with entry attachments', () => {
  const { env, sam, car, up } = setup();
  up({ filename: 'policy.pdf' });
  const entry = env.call('saveEntry', { token: sam, carId: car.id, type: 'Maintenance', fields: { title: 'Oil change', date: '2025-04-10', labourCost: '40' } }).data.entry;
  env.call('uploadAttachment', { token: sam, entryId: entry.id, mime: 'application/pdf', data: pdf(500), filename: 'invoice.pdf' });
  const page = env.call('getCarPage', { token: sam, id: car.id }).data;
  assert.equal(page.documents.length, 1);
  assert.equal(page.documents[0].filename, 'policy.pdf');
  assert.equal(page.entries.find((e) => e.id === entry.id).attachmentCount, 1);
  const docId = page.documents[0].id;
  assert.equal(env.call('getAttachment', { token: sam, id: docId }).error, 'not_found', 'a car document is not an entry attachment');
});

test('adding and removing a document is audited', () => {
  const { env, admin, up } = setup();
  const d = up({ type: 'Other', filename: 'policy.pdf' }).data.document;
  env.call('deleteCarDocument', { token: admin, id: d.id });
  const text = env.sheets.Audit._rows.slice(1).map((r) => r[3]).join(' ');
  assert.match(text, /document_added/);
  assert.match(text, /document_removed/);
});

test('guests can never reach car documents', () => {
  const { env, car, up } = setup();
  const d = up().data.document;
  for (const a of ['listCarDocuments', 'getCarDocument', 'uploadCarDocument', 'deleteCarDocument']) {
    assert.notEqual(env.call(a, { guestToken: 'x', carId: car.id, id: d.id }).ok, true, a);
  }
  const page = env.call('guestInfo', { carId: car.id, secret: 'x' });
  assert.equal(JSON.stringify(page).includes('policy.pdf'), false);
});

// ---------- editing ----------

test('anyone signed in can rename a document, change its type and edit its note; its ID and file stay', () => {
  const { env, admin, sam, car, up, list } = setup();
  const d = up({ type: 'Other', note: 'old note', filename: 'policy.pdf' }).data.document;
  const r = env.call('updateCarDocument', { token: sam, id: d.id, version: d.version, filename: 'Logbook 2024', type: 'Logbook', note: 'V5C, valid to 2027' });
  assert.equal(r.ok, true);
  assert.deepEqual([r.data.document.filename, r.data.document.type, r.data.document.note, r.data.document.ref], ['Logbook 2024.pdf', 'Logbook', 'V5C, valid to 2027', d.ref], 'a PDF stays a .pdf; the ID is unchanged');
  assert.equal(r.data.document.version, d.version + 1);
  const got = list().data.documents[0];
  assert.deepEqual([got.id, got.filename, got.type, got.note, got.ref, got.size], [d.id, 'Logbook 2024.pdf', 'Logbook', 'V5C, valid to 2027', d.ref, d.size]);
  assert.equal(env.call('getCarDocument', { token: sam, id: d.id }).data.data, pdf(2000), 'the stored file is untouched');
  assert.equal(env.call('getCarDocument', { token: sam, id: d.id }).data.filename, 'Logbook 2024.pdf', 'and downloads under its new name');
  assert.ok(admin && car);
});

test('only what is sent changes; clearing the note works; nothing sent changes nothing', () => {
  const { env, sam, up, list } = setup();
  const d = up({ type: 'Logbook', note: 'keep me' }).data.document;
  const a = env.call('updateCarDocument', { token: sam, id: d.id, note: '' }).data.document;
  assert.deepEqual([a.note, a.type, a.filename], ['', 'Logbook', 'policy.pdf']);
  const v = list().data.documents[0].version;
  const same = env.call('updateCarDocument', { token: sam, id: d.id, type: 'Logbook', note: '', filename: 'policy.pdf' }).data.document;
  assert.equal(same.version, v, 'no change, no new version');
});

test('a photo keeps its .jpg, a PDF its .pdf, and a program file name is refused', () => {
  const { env, sam, up } = setup();
  const pdfDoc = up().data.document;
  assert.equal(env.call('updateCarDocument', { token: sam, id: pdfDoc.id, filename: 'scan.jpg' }).data.document.filename, 'scan.pdf', 'a PDF cannot be renamed into a photo');
  const photo = up({ mime: 'image/jpeg', data: jpeg(2000), filename: 'front.jpg' }).data.document;
  assert.equal(env.call('updateCarDocument', { token: sam, id: photo.id, filename: 'Front of car.PDF' }).data.document.filename, 'Front of car.jpg');
  assert.equal(env.call('updateCarDocument', { token: sam, id: photo.id, filename: 'x/y\\z:?.jpg' }).data.document.filename, 'x_y_z__.jpg', 'unsafe characters are replaced');
  const other = up({ mime: 'application/octet-stream', data: Buffer.from('hello').toString('base64'), filename: 'sheet.xlsx' }).data.document;
  assert.equal(env.call('updateCarDocument', { token: sam, id: other.id, filename: 'run.exe' }).error, 'file_type_not_allowed');
  assert.equal(env.call('updateCarDocument', { token: sam, id: other.id, filename: 'Costs.xlsx' }).data.document.filename, 'Costs.xlsx');
});

test('bad input is refused: empty name, unknown type, wrong version, missing or removed document, no session', () => {
  const { env, admin, sam, up } = setup();
  const d = up().data.document;
  assert.equal(env.call('updateCarDocument', { token: sam, id: d.id, filename: '   ' }).error, 'filename_required');
  assert.equal(env.call('updateCarDocument', { token: sam, id: d.id, type: 'Receipt/invoice' }).error, 'invalid_document_type', 'a type that is no longer offered cannot be newly chosen');
  assert.equal(env.call('updateCarDocument', { token: sam, id: d.id, type: '' }).error, 'invalid_document_type');
  assert.equal(env.call('updateCarDocument', { token: sam, id: d.id, version: d.version + 5, note: 'x' }).error, 'conflict');
  assert.equal(env.call('updateCarDocument', { token: sam, id: 'nope', note: 'x' }).error, 'not_found');
  assert.equal(env.call('updateCarDocument', { id: d.id, note: 'x' }).error, 'unauthorized');
  env.call('deleteCarDocument', { token: admin, id: d.id });
  assert.equal(env.call('updateCarDocument', { token: sam, id: d.id, note: 'x' }).error, 'not_found');
});

test('a document saved with an older type keeps it when only its note is edited, and can still be re-saved with it', () => {
  const { env, sam, car, up } = setup();
  const d = up().data.document;
  const col = env.sheets.CarDocuments._rows[0].indexOf('doc_type');
  env.sheets.CarDocuments._rows.find((r) => r[0] === d.id)[col] = 'Insurance'; // saved before the list was shortened
  env.invalidate();
  const r = env.call('updateCarDocument', { token: sam, id: d.id, type: 'Insurance', note: 'renews in May' });
  assert.equal(r.ok, true);
  assert.deepEqual([r.data.document.type, r.data.document.note], ['Insurance', 'renews in May']);
  assert.equal(env.call('updateCarDocument', { token: sam, id: d.id, type: 'Logbook' }).data.document.type, 'Logbook', 'it can move to a current type');
  assert.ok(car);
});

test('editing is audited and moves the car\'s revision so phones refresh', () => {
  const { env, sam, car, up } = setup();
  const d = up().data.document;
  const before = env.call('getChanges', { token: sam }).data.cars[car.id];
  env.call('updateCarDocument', { token: sam, id: d.id, note: 'new note' });
  assert.notEqual(env.call('getChanges', { token: sam }).data.cars[car.id], before);
  const audit = env.sheets.Audit._rows.filter((r) => r.includes('document_edited'));
  assert.equal(audit.length, 1);
  assert.ok(audit[0].join(' ').includes(d.ref) && audit[0].join(' ').includes('new note'));
});
