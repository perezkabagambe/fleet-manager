/**
 * Documents kept against a car as a whole (logbook, insurance, import papers...), as opposed to the
 * photos and invoices attached to one entry. The same file rules as entry attachments apply (see Attachments.js),
 * stored in the car's private Drive folder and served only through getCarDocument after a session check.
 * Any signed-in user can add one; only admins remove one (the file goes to the Drive trash). Guests never see them.
 */

const DOCUMENT_TYPES = ['Logbook', 'Insurance', 'MOT / inspection', 'Import papers', 'Receipt / invoice', 'Other'];

function documentShape_(d) {
  return { id: d.id, type: d.doc_type || 'Other', note: d.note || '', filename: d.filename, mime: d.mime, size: Number(d.size) || 0, createdAt: d.created_at };
}

/** The live documents of one car, newest first (a stable order: date added, then position in the sheet). */
function carDocuments_(carId) {
  return Db.all('CarDocuments')
    .filter(function (d) { return d.car_id === carId && !isTrue_(d.deleted); })
    .sort(function (a, b) {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
      return b._row - a._row;
    })
    .map(documentShape_);
}

function listCarDocuments_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), ctx.user.role === 'admin');
  if (!car) fail_('not_found');
  return { documents: carDocuments_(car.id) };
}

function uploadCarDocument_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const type = oneOf_(p.type, DOCUMENT_TYPES, '', 'invalid_document_type');
  if (!type) fail_('invalid_document_type');
  const note = cleanStr_(p.note, 200);
  const mime = attachmentKind_(cleanStr_(p.mime, 100));
  const filename = safeFilename_(p.filename, mime);
  if (isBlockedFilename_(filename)) fail_('file_type_not_allowed');
  const bytes = decodeAttachment_(p.data, mime);
  const file = carFolder_(car.id).createFile(Utilities.newBlob(bytes, mime, 'doc-' + Date.now() + '-' + filename));
  const row = Object.assign(baseColumns_(ctx), {
    car_id: car.id, doc_type: type, note: note, drive_file_id: file.getId(), filename: filename, mime: mime, size: bytes.length,
  });
  Db.insert('CarDocuments', row);
  audit_(ctx.user, 'document_added', 'Car', car.id, type + ' document "' + filename + '" added to ' + car.registration);
  return { document: documentShape_(row) };
}

function liveCarDocument_(id) {
  const d = Db.all('CarDocuments').filter(function (x) { return x.id === id && !isTrue_(x.deleted); })[0];
  return d || null;
}

/** Returns the file as base64. The file id comes from the record, never from the caller. */
function getCarDocument_(p, ctx) {
  const d = liveCarDocument_(cleanStr_(p.id, 64));
  if (!d) fail_('not_found');
  if (!findCar_(d.car_id, ctx.user.role === 'admin')) fail_('not_found');
  let bytes;
  try {
    bytes = DriveApp.getFileById(d.drive_file_id).getBlob().getBytes();
  } catch (e) {
    fail_('not_found');
  }
  return { filename: d.filename, mime: d.mime, data: Utilities.base64Encode(bytes) };
}

/** Admin only. The file goes to the Drive trash (recoverable for 30 days). */
function deleteCarDocument_(p, ctx) {
  const d = liveCarDocument_(cleanStr_(p.id, 64));
  if (!d) fail_('not_found');
  const car = findCar_(d.car_id, true);
  Db.update('CarDocuments', d._row, { deleted: true, updated_at: nowIso_(), updated_by: ctx.user.id, version: Number(d.version || 1) + 1 });
  trashFiles_([d.drive_file_id]);
  audit_(ctx.user, 'document_removed', 'Car', d.car_id, (d.doc_type || 'Document') + ' document "' + d.filename + '" removed' + (car ? ' from ' + car.registration : ''));
  return { done: true };
}
