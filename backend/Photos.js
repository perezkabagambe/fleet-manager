/**
 * Car photos. The phone shrinks each photo before sending it (a ~1280 px JPEG plus a small
 * thumbnail), so uploads stay small. Files live in the app account's private Drive folder
 * Uploads/<carId>/ and are only ever read back through getPhoto after a session check:
 * there are no public links, and a file id is never taken from the caller, only from the car record.
 */

const MAX_PHOTO_BYTES = 1500000;
const MAX_THUMB_BYTES = 120000;

/** Decode base64 and check it really is a JPEG (starts FF D8 FF) within the size limit. */
function decodeJpeg_(b64, maxBytes) {
  const s = String(b64 === null || b64 === undefined ? '' : b64);
  if (!s) fail_('invalid_photo');
  if (s.length > Math.ceil(maxBytes * 4 / 3) + 16) fail_('photo_too_large');
  let bytes;
  try {
    bytes = Utilities.base64Decode(s);
  } catch (e) {
    fail_('invalid_photo');
  }
  if (bytes.length > maxBytes) fail_('photo_too_large');
  if (bytes.length < 4 || (bytes[0] & 0xff) !== 0xff || (bytes[1] & 0xff) !== 0xd8 || (bytes[2] & 0xff) !== 0xff) {
    fail_('invalid_photo');
  }
  return bytes;
}

/** One private Drive folder per car, remembered in Script Properties. */
function carFolder_(carId) {
  const props = props_();
  const key = 'CARFOLDER_' + carId;
  const id = props.getProperty(key);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ }
  }
  const folder = DriveApp.getFolderById(props.getProperty('UPLOADS_FOLDER_ID')).createFolder(carId);
  props.setProperty(key, folder.getId());
  return folder;
}

/** Replaced photos go to the Drive trash (recoverable for 30 days), not deleted outright. */
function trashFiles_(ids) {
  ids.forEach(function (id) {
    if (!id) return;
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* already gone */ }
  });
}

function uploadCarPhoto_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const full = decodeJpeg_(p.full, MAX_PHOTO_BYTES);
  const thumb = decodeJpeg_(p.thumb, MAX_THUMB_BYTES);

  const folder = carFolder_(car.id);
  const stamp = String(Date.now());
  const fullFile = folder.createFile(Utilities.newBlob(full, 'image/jpeg', 'photo-' + stamp + '.jpg'));
  const thumbFile = folder.createFile(Utilities.newBlob(thumb, 'image/jpeg', 'thumb-' + stamp + '.jpg'));

  // The photo is not one of the form's fields, so it does not bump `version`: changing a photo
  // never makes someone else's open edit form fail with a conflict.
  const patch = {
    photo_file_id: fullFile.getId(), photo_thumb_file_id: thumbFile.getId(),
    updated_at: nowIso_(), updated_by: ctx.user.id,
  };
  Db.update('Cars', car._row, patch);
  trashFiles_([car.photo_file_id, car.photo_thumb_file_id]);
  audit_(ctx.user, car.photo_file_id ? 'photo_replaced' : 'photo_added', 'Car', car.id, car.registration + ': photo ' + (car.photo_file_id ? 'replaced' : 'added'));
  return { car: summarizeCar_(Object.assign({}, car, patch)) };
}

function removeCarPhoto_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  if (!car.photo_file_id && !car.photo_thumb_file_id) fail_('no_photo');
  const patch = { photo_file_id: '', photo_thumb_file_id: '', updated_at: nowIso_(), updated_by: ctx.user.id };
  Db.update('Cars', car._row, patch);
  trashFiles_([car.photo_file_id, car.photo_thumb_file_id]);
  audit_(ctx.user, 'photo_removed', 'Car', car.id, car.registration + ': photo removed');
  return { car: summarizeCar_(Object.assign({}, car, patch)) };
}

/** Returns the car's photo as base64 JPEG. kind is 'thumb' or 'full'. Admins can also read deleted cars. */
function getPhoto_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), ctx.user.role === 'admin');
  if (!car) fail_('not_found');
  const fileId = p.kind === 'thumb' ? car.photo_thumb_file_id : car.photo_file_id;
  if (!fileId) fail_('no_photo');
  let bytes;
  try {
    bytes = DriveApp.getFileById(fileId).getBlob().getBytes();
  } catch (e) {
    fail_('no_photo');
  }
  return { fileId: fileId, data: Utilities.base64Encode(bytes) };
}
