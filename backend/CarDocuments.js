/**
 * Documents kept against a car as a whole (logbook, insurance, import papers...), as opposed to the
 * photos and invoices attached to one entry. The same file rules as entry attachments apply (see Attachments.js),
 * stored in the car's private Drive folder and served only through getCarDocument after a session check.
 * Any signed-in user can add one; only admins remove one (the file goes to the Drive trash). Guests never see them.
 */

// A document already saved with an older type (such as Insurance) keeps it; only these can be chosen for a new one.
const DOCUMENT_TYPES = ['Logbook', 'Import papers', 'Other'];

function documentShape_(d) {
  return { id: d.id, ref: d.ref || '', version: Number(d.version || 1), type: d.doc_type || 'Other', note: d.note || '', filename: d.filename, mime: d.mime, size: Number(d.size) || 0, createdAt: d.created_at };
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
    car_id: car.id, doc_type: type, note: note, drive_file_id: file.getId(), filename: filename, mime: mime, size: bytes.length, ref: nextFileRef_(),
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

/**
 * Rename a document, change its type or edit its note (any signed-in user). Send only what changes. The file itself
 * and its ID never change. `version` (from the list) guards against two people editing at once.
 */
function updateCarDocument_(p, ctx) {
  const d = liveCarDocument_(cleanStr_(p.id, 64));
  if (!d) fail_('not_found');
  const car = findCar_(d.car_id, false);
  if (!car) fail_('not_found');
  if (p.version !== undefined && p.version !== null && Number(d.version || 1) !== Number(p.version)) fail_('conflict');

  const patch = {};
  if (p.type !== undefined) {
    const type = cleanStr_(p.type, 20);
    // an older document keeps the type it was saved with (such as Insurance); only the current list can be chosen for a change
    if (!type || (type !== (d.doc_type || '') && DOCUMENT_TYPES.indexOf(type) === -1)) fail_('invalid_document_type');
    if (type !== d.doc_type) patch.doc_type = type;
  }
  if (p.note !== undefined) {
    const note = cleanStr_(p.note, 200);
    if (note !== (d.note || '')) patch.note = note;
  }
  if (p.filename !== undefined) {
    const raw = cleanStr_(p.filename, 100);
    if (!raw) fail_('filename_required');
    // a PDF stays a .pdf and a photo a .jpg, whatever it is renamed to
    const ext = d.mime === 'application/pdf' ? '.pdf' : d.mime === 'image/jpeg' ? '.jpg' : '';
    const name = ext ? raw.replace(/\.(jpe?g|pdf)$/i, '') + ext : raw;
    const filename = safeFilename_(name, d.mime);
    if (isBlockedFilename_(filename)) fail_('file_type_not_allowed');
    if (filename !== d.filename) patch.filename = filename;
  }
  if (!Object.keys(patch).length) return { document: documentShape_(d) };

  const changes = Object.keys(patch).map(function (k) { return k + ' "' + (d[k] || '') + '" to "' + patch[k] + '"'; }).join(', ');
  const stamped = Object.assign({}, patch, { updated_at: nowIso_(), updated_by: ctx.user.id, version: Number(d.version || 1) + 1 });
  Db.update('CarDocuments', d._row, stamped);
  audit_(ctx.user, 'document_edited', 'Car', d.car_id, (d.ref || 'Document') + ' on ' + car.registration + ': ' + changes);
  return { document: documentShape_(Object.assign({}, d, stamped)) };
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
