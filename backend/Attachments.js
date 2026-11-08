/**
 * Photos and documents attached to entries (receipts, invoices, quotes, photos of a fault).
 * JPEG photos and PDFs only, checked by their first bytes. Stored in the car's private Drive folder and
 * served only through getAttachment after a session check. Any user can add one; only admins remove one.
 */

const MAX_ATTACH_JPEG = 1500000;
const MAX_ATTACH_PDF = 2500000;
const MAX_ATTACHMENTS_PER_ENTRY = 10;

function isPdf_(bytes) {
  // "%PDF" = 25 50 44 46
  return bytes.length > 4 && (bytes[0] & 0xff) === 0x25 && (bytes[1] & 0xff) === 0x50 && (bytes[2] & 0xff) === 0x44 && (bytes[3] & 0xff) === 0x46;
}

function decodeAttachment_(b64, mime) {
  if (mime === 'image/jpeg') return decodeJpeg_(b64, MAX_ATTACH_JPEG);
  if (mime !== 'application/pdf') fail_('invalid_attachment');
  const s = String(b64 === null || b64 === undefined ? '' : b64);
  if (!s) fail_('invalid_attachment');
  if (s.length > Math.ceil(MAX_ATTACH_PDF * 4 / 3) + 16) fail_('attachment_too_large');
  let bytes;
  try { bytes = Utilities.base64Decode(s); } catch (e) { fail_('invalid_attachment'); }
  if (bytes.length > MAX_ATTACH_PDF) fail_('attachment_too_large');
  if (!isPdf_(bytes)) fail_('invalid_attachment');
  return bytes;
}

function safeFilename_(name, mime) {
  const clean = cleanStr_(name, 100).replace(/[\\/:*?"<>|]/g, '_');
  const ext = mime === 'application/pdf' ? '.pdf' : '.jpg';
  const base = clean || 'attachment';
  return /\.(jpe?g|pdf)$/i.test(base) ? base : base + ext;
}

function uploadAttachment_(p, ctx) {
  const entry = findEntry_(cleanStr_(p.entryId, 64));
  if (!entry) fail_('not_found');
  const car = findCar_(entry.car_id, false);
  if (!car) fail_('not_found');
  const mime = cleanStr_(p.mime, 40);
  const bytes = decodeAttachment_(p.data, mime);
  const existing = Db.all('Attachments').filter(function (a) { return a.entry_id === entry.id && !isTrue_(a.deleted); });
  if (existing.length >= MAX_ATTACHMENTS_PER_ENTRY) fail_('too_many_attachments');

  const filename = safeFilename_(p.filename, mime);
  const file = carFolder_(car.id).createFile(Utilities.newBlob(bytes, mime, 'att-' + Date.now() + '-' + filename));
  const row = Object.assign(baseColumns_(ctx), {
    car_id: car.id, entry_id: entry.id, drive_file_id: file.getId(), filename: filename, mime: mime, size: bytes.length,
  });
  Db.insert('Attachments', row);
  audit_(ctx.user, 'attachment_added', 'Entry', entry.id, filename + ' attached to ' + entry.type.toLowerCase() + ' "' + entry.title + '" (' + car.registration + ')');
  return { attachment: { id: row.id, filename: filename, mime: mime, size: bytes.length } };
}

function liveAttachment_(id) {
  const a = Db.all('Attachments').filter(function (x) { return x.id === id && !isTrue_(x.deleted); })[0];
  if (!a) return null;
  const entry = findEntry_(a.entry_id);
  return entry ? { att: a, entry: entry } : null;
}

/** Returns the file as base64. The file id comes from the record, never from the caller. */
function getAttachment_(p, ctx) {
  const found = liveAttachment_(cleanStr_(p.id, 64));
  if (!found) fail_('not_found');
  if (!findCar_(found.att.car_id, ctx.user.role === 'admin')) fail_('not_found');
  let bytes;
  try {
    bytes = DriveApp.getFileById(found.att.drive_file_id).getBlob().getBytes();
  } catch (e) {
    fail_('not_found');
  }
  return { filename: found.att.filename, mime: found.att.mime, data: Utilities.base64Encode(bytes) };
}

/** Admin only. The file goes to the Drive trash (recoverable for 30 days). */
function deleteAttachment_(p, ctx) {
  const found = liveAttachment_(cleanStr_(p.id, 64));
  if (!found) fail_('not_found');
  Db.update('Attachments', found.att._row, { deleted: true, updated_at: nowIso_(), updated_by: ctx.user.id, version: Number(found.att.version || 1) + 1 });
  trashFiles_([found.att.drive_file_id]);
  audit_(ctx.user, 'attachment_removed', 'Entry', found.entry.id, found.att.filename + ' removed from "' + found.entry.title + '"');
  return { done: true };
}
