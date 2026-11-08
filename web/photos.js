// Car photos: shrink on the phone before upload, fetch and cache for display.
// Photos are private: they are only ever downloaded through the signed-in API.
(function () {
  'use strict';

  var el = UI.el;
  var MAX_INPUT_BYTES = 40 * 1024 * 1024; // refuse absurd originals before decoding
  var FULL_SIDE = 1280, FULL_QUALITY = 0.8, FULL_LIMIT = 1400000;
  var THUMB_SIDE = 320, THUMB_QUALITY = 0.7;
  var THUMB_KEY = 'fleet.thumb.';

  var memory = {};   // fileId -> data URL
  var inflight = {}; // fileId -> promise

  // ---------- shrinking ----------
  function viaImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new FleetApi.ApiError('invalid_photo', 'Unreadable image')); };
      img.src = url;
    });
  }

  // createImageBitmap applies the camera's rotation, so portrait photos are not sideways.
  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return viaImage(file); });
    }
    return viaImage(file);
  }

  function toJpeg(src, maxSide, quality) {
    var w = src.width || src.naturalWidth;
    var h = src.height || src.naturalHeight;
    var scale = Math.min(1, maxSide / Math.max(w, h));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // PNGs with transparency become white, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { return blob ? resolve(blob) : reject(new FleetApi.ApiError('invalid_photo', 'Could not convert')); }, 'image/jpeg', quality);
    });
  }

  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  /** File from the camera or gallery -> { full, thumb } as base64 JPEG strings. */
  function prepare(file) {
    if (!file || !/^image\//.test(file.type || 'image/')) return Promise.reject(new FleetApi.ApiError('invalid_photo', 'Not an image'));
    if (file.size > MAX_INPUT_BYTES) return Promise.reject(new FleetApi.ApiError('photo_too_large', 'Too large'));
    return decode(file).then(function (src) {
      return toJpeg(src, FULL_SIDE, FULL_QUALITY).then(function (full) {
        // A very detailed photo can still be big: try once more, smaller.
        return full.size > FULL_LIMIT ? toJpeg(src, 1024, 0.65) : full;
      }).then(function (full) {
        return toJpeg(src, THUMB_SIDE, THUMB_QUALITY).then(function (thumb) {
          if (src.close) src.close();
          return Promise.all([toBase64(full), toBase64(thumb)]);
        });
      });
    }).then(function (parts) {
      return { full: parts[0], thumb: parts[1] };
    });
  }

  function upload(carId, file) {
    return prepare(file).then(function (p) {
      return FleetApi.call('uploadCarPhoto', { carId: carId, full: p.full, thumb: p.thumb });
    });
  }

  // ---------- showing ----------
  function dataUrl(b64) { return 'data:image/jpeg;base64,' + b64; }

  function remember(id, src, isThumb) {
    memory[id] = src;
    if (isThumb) { try { localStorage.setItem(THUMB_KEY + id, src); } catch (e) { /* storage full or blocked */ } }
  }

  /** Data URL for a car's photo ('thumb' or 'full'), cached by file id (ids change when a photo is replaced). */
  function get(car, kind) {
    var id = kind === 'thumb' ? car.photoThumbId : car.photoId;
    if (!id) return Promise.reject(new FleetApi.ApiError('no_photo', 'No photo'));
    if (memory[id]) return Promise.resolve(memory[id]);
    if (kind === 'thumb') {
      try {
        var saved = localStorage.getItem(THUMB_KEY + id);
        if (saved) { memory[id] = saved; return Promise.resolve(saved); }
      } catch (e) { /* ignore */ }
    }
    if (!inflight[id]) {
      inflight[id] = FleetApi.call('getPhoto', { carId: car.id, kind: kind }).then(function (r) {
        var src = dataUrl(r.data.data);
        remember(id, src, kind === 'thumb');
        return src;
      }).finally(function () { delete inflight[id]; });
    }
    return inflight[id];
  }

  /**
   * A photo box. Shows a placeholder, then the thumbnail, then (for kind 'full') the full image.
   * Always returns an element, so layouts never jump around.
   */
  function element(car, kind, cls) {
    var box = el('div', { class: 'photo placeholder ' + (cls || ''), 'aria-hidden': 'true', text: '🚗' });
    var hasPhoto = kind === 'thumb' ? car.photoThumbId : (car.photoId || car.photoThumbId);
    if (!hasPhoto) return box;

    function show(src) {
      var img = box.querySelector('img');
      if (!img) {
        img = el('img', { class: 'photo-img', alt: car.registration + ' photo' });
        box.classList.remove('placeholder');
        box.removeAttribute('aria-hidden');
        box.replaceChildren(img);
      }
      img.src = src;
    }

    if (kind === 'full') {
      if (car.photoThumbId) get(car, 'thumb').then(show).catch(function () {});
      if (car.photoId) get(car, 'full').then(show).catch(function () {});
    } else {
      get(car, 'thumb').then(show).catch(function () {});
    }
    return box;
  }

  window.Photos = { prepare: prepare, upload: upload, get: get, element: element };
})();
