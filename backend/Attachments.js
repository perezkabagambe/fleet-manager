/**
 * Photos and files attached to entries (receipts, invoices, quotes, photos of a fault, documents of any kind).
 * A JPEG photo or a PDF is checked by its first bytes. Any other file is accepted as it is (up to a size limit),
 * except programs and scripts, and is stored and served as an anonymous download ("application/octet-stream"),
 * never as something a browser might open and run. Stored in the car's private Drive folder and served only
 * through getAttachment after a session check. Any user can add one; only admins remove one.
 */

const MAX_ATTACH_JPEG = 1500000;
const MAX_ATTACH_FILE = 5000000; // PDFs and every other kind of file
const MAX_ATTACHMENTS_PER_ENTRY = 10;
const GENERIC_MIME = 'application/octet-stream';
// Programs and scripts are the one kind of file that is refused: they could harm whoever opens them.
const BLOCKED_EXTENSIONS = ['exe', 'com', 'bat', 'cmd', 'scr', 'msi', 'msp', 'dll', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1',
  'sh', 'jar', 'apk', 'app', 'dmg', 'lnk', 'reg', 'hta', 'cpl', 'pif', 'gadget'];

function isPdf_(bytes) {
  // "%PDF" = 25 50 44 46
  return bytes.length > 4 && (bytes[0] & 0xff) === 0x25 && (bytes[1] & 0xff) === 0x50 && (bytes[2] & 0xff) === 0x44 && (bytes[3] & 0xff) === 0x46;
}

/** What kind of file a request claims to be: 'image/jpeg', 'application/pdf', or any other file (stored as GENERIC_MIME). */
function attachmentKind_(mime) {
  return mime === 'image/jpeg' || mime === 'application/pdf' ? mime : GENERIC_MIME;
}

function decodeAttachment_(b64, mime) {
  if (mime === 'image/jpeg') return decodeJpeg_(b64, MAX_ATTACH_JPEG);
  const s = String(b64 === null || b64 === undefined ? '' : b64);
  if (!s) fail_('invalid_attachment');
  if (s.length > Math.ceil(MAX_ATTACH_FILE * 4 / 3) + 16) fail_('attachment_too_large');
  let bytes;
  try { bytes = Utilities.base64Decode(s); } catch (e) { fail_('invalid_attachment'); }
  if (bytes.length > MAX_ATTACH_FILE) fail_('attachment_too_large');
  if (!bytes.length) fail_('invalid_attachment');
  if (mime === 'application/pdf' && !isPdf_(bytes)) fail_('invalid_attachment'); // it says it is a PDF, so it must be one
  return bytes;
}

function safeFilename_(name, mime) {
  const clean = cleanStr_(name, 100).replace(/[\\/:*?"<>|]/g, '_');
  if (mime === 'application/pdf' || mime === 'image/jpeg') {
    const ext = mime === 'application/pdf' ? '.pdf' : '.jpg';
    const base = clean || 'attachment';
    return /\.(jpe?g|pdf)$/i.test(base) ? base : base + ext;
  }
  return clean || 'file';
}

/** Programs and scripts are refused. Trailing dots and spaces are ignored (Windows treats "a.exe." as "a.exe"). */
function isBlockedFilename_(filename) {
  const m = /\.([A-Za-z0-9]+)[. ]*$/.exec(String(filename));
  return !!m && BLOCKED_EXTENSIONS.indexOf(m[1].toLowerCase()) !== -1;
}

function uploadAttachment_(p, ctx) {
  const entry = findEntry_(cleanStr_(p.entryId, 64));
  if (!entry) fail_('not_found');
  const car = findCar_(entry.car_id, false);
  if (!car) fail_('not_found');
  const mime = attachmentKind_(cleanStr_(p.mime, 100));
  const filename = safeFilename_(p.filename, mime);
  if (isBlockedFilename_(filename)) fail_('file_type_not_allowed');
  const bytes = decodeAttachment_(p.data, mime);
  const existing = Db.all('Attachments').filter(function (a) { return a.entry_id === entry.id && !isTrue_(a.deleted); });
  if (existing.length >= MAX_ATTACHMENTS_PER_ENTRY) fail_('too_many_attachments');

  const folder = carFolder_(car.id);
  // A photo comes with a small thumbnail (made on the phone) for the lists. It is optional: older phones do not send one.
  let thumbBytes = null;
  if (mime === 'image/jpeg' && p.thumb) {
    try { thumbBytes = decodeJpeg_(p.thumb, MAX_THUMB_BYTES); } catch (e) { thumbBytes = null; } // a bad thumbnail never blocks the photo
  }
  const file = folder.createFile(Utilities.newBlob(bytes, mime, 'att-' + Date.now() + '-' + filename));
  const thumbFile = thumbBytes ? folder.createFile(Utilities.newBlob(thumbBytes, 'image/jpeg', 'attthumb-' + Date.now() + '.jpg')) : null;
  const row = Object.assign(baseColumns_(ctx), {
    car_id: car.id, entry_id: entry.id, drive_file_id: file.getId(), filename: filename, mime: mime, size: bytes.length,
    thumb_file_id: thumbFile ? thumbFile.getId() : '',
  });
  Db.insert('Attachments', row);
  audit_(ctx.user, 'attachment_added', 'Entry', entry.id, filename + ' attached to ' + entry.type.toLowerCase() + ' "' + entry.title + '" (' + car.registration + ')');
  return { attachment: { id: row.id, filename: filename, mime: mime, size: bytes.length, thumb: !!thumbFile } };
}

const MAX_THUMBS_PER_REQUEST = 8;

/** Several small thumbnails in one go: { ids: [attachmentId...] } -> { thumbs: { attachmentId: base64 } }. Ids without a thumbnail are left out. */
function getAttachmentThumbs_(p, ctx) {
  if (!Array.isArray(p.ids) || p.ids.length > MAX_THUMBS_PER_REQUEST) fail_('invalid_input');
  const thumbs = {};
  p.ids.forEach(function (raw) {
    const found = liveAttachment_(cleanStr_(raw, 64));
    if (!found || !found.att.thumb_file_id) return;
    if (!findCar_(found.att.car_id, ctx.user.role === 'admin')) return;
    try {
      thumbs[found.att.id] = Utilities.base64Encode(DriveApp.getFileById(found.att.thumb_file_id).getBlob().getBytes());
    } catch (e) { /* the file is gone: no thumbnail */ }
  });
  return { thumbs: thumbs };
}

/** A photo that was attached before thumbnails existed gets one, made on the phone the first time it is opened. */
function setAttachmentThumb_(p, ctx) {
  const found = liveAttachment_(cleanStr_(p.id, 64));
  if (!found) fail_('not_found');
  const att = found.att;
  if (!findCar_(att.car_id, false)) fail_('not_found');
  if (att.mime !== 'image/jpeg') fail_('invalid_attachment');
  if (att.thumb_file_id) return { thumb: true }; // already has one: nothing to do
  const bytes = decodeJpeg_(p.thumb, MAX_THUMB_BYTES);
  const file = carFolder_(att.car_id).createFile(Utilities.newBlob(bytes, 'image/jpeg', 'attthumb-' + Date.now() + '.jpg'));
  Db.update('Attachments', att._row, { thumb_file_id: file.getId(), updated_at: nowIso_(), updated_by: ctx.user.id, version: Number(att.version || 1) + 1 });
  return { thumb: true };
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
  trashFiles_([found.att.drive_file_id, found.att.thumb_file_id]);
  audit_(ctx.user, 'attachment_removed', 'Entry', found.entry.id, found.att.filename + ' removed from "' + found.entry.title + '"');
  return { done: true };
}
