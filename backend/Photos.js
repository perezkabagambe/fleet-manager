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

const MAX_CAR_PHOTOS = 15;

/** A car's live photos, in order. The first one is its main (cover) photo. */
function carPhotosOf_(carId) {
  return Db.all('CarPhotos').filter(function (r) { return r.car_id === carId && !isTrue_(r.deleted); })
    .sort(function (a, b) { return (Number(a.position) || 0) - (Number(b.position) || 0) || (a._row - b._row); });
}

/** Keep the car's own photo columns (what the fleet list and the saved copies use) pointing at its main photo. */
function syncCoverPhoto_(car, ctx) {
  const first = carPhotosOf_(car.id)[0];
  const patch = {
    photo_file_id: first ? first.drive_file_id : '', photo_thumb_file_id: first ? first.thumb_file_id : '',
    updated_at: nowIso_(), updated_by: ctx.user.id,
  };
  // (the photo is not one of the form's fields, so it does not bump `version`: changing a photo
  // never makes someone else's open edit form fail with a conflict)
  Db.update('Cars', car._row, patch);
  return Object.assign({}, car, patch);
}

/** Add a photo to a car (up to 15). The first one added becomes its main photo. */
function uploadCarPhoto_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const full = decodeJpeg_(p.full, MAX_PHOTO_BYTES);
  const thumb = decodeJpeg_(p.thumb, MAX_THUMB_BYTES);
  const existing = carPhotosOf_(car.id);
  if (existing.length >= MAX_CAR_PHOTOS) fail_('too_many_photos');

  const folder = carFolder_(car.id);
  const stamp = String(Date.now());
  const fullFile = folder.createFile(Utilities.newBlob(full, 'image/jpeg', 'photo-' + stamp + '.jpg'));
  const thumbFile = folder.createFile(Utilities.newBlob(thumb, 'image/jpeg', 'thumb-' + stamp + '.jpg'));
  const row = Object.assign(baseColumns_(ctx), {
    car_id: car.id, drive_file_id: fullFile.getId(), thumb_file_id: thumbFile.getId(),
    position: String(existing.length ? Math.max.apply(null, existing.map(function (r) { return Number(r.position) || 0; })) + 1 : 0),
  });
  Db.insert('CarPhotos', row);
  const updated = syncCoverPhoto_(car, ctx);
  audit_(ctx.user, 'photo_added', 'Car', car.id, car.registration + ': photo added (' + (existing.length + 1) + ' of up to ' + MAX_CAR_PHOTOS + ')');
  return { car: summarizeCar_(updated), photo: { id: row.id } };
}

/** Remove one photo (p.photoId), or the main one if none is named. The files go to the Drive trash. */
function removeCarPhoto_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const photos = carPhotosOf_(car.id);
  const wanted = cleanStr_(p.photoId, 64);
  const target = wanted ? photos.filter(function (r) { return r.id === wanted; })[0] : photos[0];
  if (!target) fail_('no_photo');
  Db.update('CarPhotos', target._row, { deleted: true, updated_at: nowIso_(), updated_by: ctx.user.id, version: Number(target.version || 1) + 1 });
  trashFiles_([target.drive_file_id, target.thumb_file_id]);
  const updated = syncCoverPhoto_(car, ctx);
  audit_(ctx.user, 'photo_removed', 'Car', car.id, car.registration + ': photo removed');
  return { car: summarizeCar_(updated) };
}

/** Make one of the car's photos its main photo (the first one shown, and the one on the fleet list). */
function setCoverPhoto_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const photos = carPhotosOf_(car.id);
  const chosen = photos.filter(function (r) { return r.id === cleanStr_(p.photoId, 64); })[0];
  if (!chosen) fail_('no_photo');
  const order = [chosen].concat(photos.filter(function (r) { return r.id !== chosen.id; }));
  order.forEach(function (r, i) {
    if (String(r.position) !== String(i)) Db.update('CarPhotos', r._row, { position: String(i), updated_at: nowIso_(), updated_by: ctx.user.id });
  });
  const updated = syncCoverPhoto_(car, ctx);
  audit_(ctx.user, 'photo_cover_changed', 'Car', car.id, car.registration + ': main photo changed');
  return { car: summarizeCar_(updated) };
}

/** Returns one of the car's photos as base64 JPEG (p.photoId, or the main one). kind is 'thumb' or 'full'. Admins can also read deleted cars. */
function getPhoto_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), ctx.user.role === 'admin');
  if (!car) fail_('not_found');
  let fileId = p.kind === 'thumb' ? car.photo_thumb_file_id : car.photo_file_id;
  const wanted = cleanStr_(p.photoId, 64);
  if (wanted) {
    const row = carPhotosOf_(car.id).filter(function (r) { return r.id === wanted; })[0]; // a photo id only works for this car's own photos
    if (!row) fail_('no_photo');
    fileId = p.kind === 'thumb' ? row.thumb_file_id : row.drive_file_id;
  }
  if (!fileId) fail_('no_photo');
  let bytes;
  try {
    bytes = DriveApp.getFileById(fileId).getBlob().getBytes();
  } catch (e) {
    fail_('no_photo');
  }
  return { fileId: fileId, data: Utilities.base64Encode(bytes) };
}
