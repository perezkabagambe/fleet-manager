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

  /**
   * Two buttons: "Take photo" (opens the camera straight away on a phone) and "Choose photo"
   * (opens the gallery or files). Calls onFile(file) with whatever was picked.
   */
  function picker(onFile) {
    function button(label, camera) {
      var input = el('input', Object.assign({ type: 'file', accept: 'image/*', class: 'file-input' }, camera ? { capture: 'environment' } : {}));
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        input.value = ''; // so picking the same photo again still fires
        if (file) onFile(file);
      });
      return el('label', { class: 'btn small secondary file-btn' }, [el('span', { text: label }), input]);
    }
    var take = button('Take photo', true);
    var choose = button('Choose photo', false);
    return {
      take: take,
      choose: choose,
      setBusy: function (busy) {
        take.classList.toggle('disabled', busy);
        choose.classList.toggle('disabled', busy);
      },
    };
  }

  /** One labelled file button. `capture` opens the camera directly on a phone. */
  function fileButton(label, accept, capture, onFile) {
    var input = el('input', Object.assign({ type: 'file', accept: accept, class: 'file-input' }, capture ? { capture: 'environment' } : {}));
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.value = '';
      if (file) onFile(file);
    });
    return el('label', { class: 'btn small secondary file-btn' }, [el('span', { text: label }), input]);
  }

  var MAX_FILE_BYTES = 5000000; // PDFs and every other kind of file

  /**
   * An attachment for an entry. A photo is shrunk to a JPEG (with a small thumbnail). A PDF, or any other file
   * (a Word or Excel file, a text file, a zip...), is sent as it is, up to 5 MB.
   */
  function prepareAttachment(file) {
    var name = file.name || '';
    var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(name);
    function asFile() {
      if (!file.size) return Promise.reject(new FleetApi.ApiError('invalid_attachment', 'Empty file'));
      if (file.size > MAX_FILE_BYTES) return Promise.reject(new FleetApi.ApiError('attachment_too_large', 'File too large'));
      return toBase64(file).then(function (b64) {
        return { mime: isPdf ? 'application/pdf' : 'application/octet-stream', data: b64, filename: name || (isPdf ? 'document.pdf' : 'file') };
      });
    }
    if (!isPdf && /^image\//.test(file.type || '')) {
      return prepare(file).then(function (p) {
        return { mime: 'image/jpeg', data: p.full, thumb: p.thumb, filename: name || 'photo.jpg' };
      }).catch(function () { return asFile(); }); // a picture this browser cannot read is kept as it is
    }
    return asFile();
  }

  /** Download an attachment and show it: photos appear inline, everything else is saved/opened as a file. */
  function fetchAttachment(id) {
    return FleetApi.call('getAttachment', { id: id }).then(function (r) { return r.data; });
  }
  function toBlobUrl(att) {
    var bin = atob(att.data);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: att.mime }));
  }

  // ---------- small thumbnails of the photos attached to entries ----------
  // Fetched a few at a time (one request for up to 8), remembered on this phone by attachment id, and forgotten at sign-out.
  var ATHUMB_KEY = 'fleet.athumb.';
  var athumbMemory = {};
  var athumbWaiting = {};
  var athumbQueue = [];
  var athumbTimer = null;

  function rememberAthumb(id, src) {
    athumbMemory[id] = src;
    try { localStorage.setItem(ATHUMB_KEY + id, src); } catch (e) { /* storage full or blocked */ }
  }

  function flushAthumbs() {
    athumbTimer = null;
    var ids = athumbQueue.splice(0);
    function settle(id, src, err) {
      var w = athumbWaiting[id];
      delete athumbWaiting[id];
      if (!w) return;
      if (src) w.resolve(src); else w.reject(err || new FleetApi.ApiError('no_photo', 'No thumbnail'));
    }
    for (var i = 0; i < ids.length; i += 8) {
      (function (batch) {
        FleetApi.call('getAttachmentThumbs', { ids: batch }).then(function (r) {
          batch.forEach(function (id) {
            var b64 = r.data.thumbs && r.data.thumbs[id];
            if (b64) { var src = dataUrl(b64); rememberAthumb(id, src); settle(id, src); } else settle(id, null);
          });
        }).catch(function (e) { batch.forEach(function (id) { settle(id, null, e); }); });
      })(ids.slice(i, i + 8));
    }
  }

  /** Data URL of an attachment's small thumbnail. */
  function attachmentThumb(id) {
    if (athumbMemory[id]) return Promise.resolve(athumbMemory[id]);
    try {
      var saved = localStorage.getItem(ATHUMB_KEY + id);
      if (saved) { athumbMemory[id] = saved; return Promise.resolve(saved); }
    } catch (e) { /* ignore */ }
    if (!athumbWaiting[id]) {
      var w = {};
      w.promise = new Promise(function (resolve, reject) { w.resolve = resolve; w.reject = reject; });
      athumbWaiting[id] = w;
      athumbQueue.push(id);
      if (!athumbTimer) athumbTimer = setTimeout(flushAthumbs, 40);
    }
    return athumbWaiting[id].promise;
  }

  /** A small box for an attachment's thumbnail: a placeholder of the right size first, then the picture. */
  function thumbBox(id, cls) {
    var box = el('div', { class: 'thumb-box ' + (cls || ''), 'aria-hidden': 'true' });
    attachmentThumb(id).then(function (src) {
      box.replaceChildren(el('img', { class: 'thumb-img', src: src, alt: '' }));
    }).catch(function () { /* no thumbnail: the placeholder stays */ });
    return box;
  }

  /** For a photo attached before thumbnails existed: make the thumbnail on the phone from the full image (base64 JPEG). */
  function thumbFromBase64(b64) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { toJpeg(img, THUMB_SIDE, THUMB_QUALITY).then(toBase64).then(resolve, reject); };
      img.onerror = function () { reject(new FleetApi.ApiError('invalid_photo', 'Unreadable image')); };
      img.src = dataUrl(b64);
    });
  }

  /** Called at sign-out: what this phone remembered about photos belongs to the person who left. */
  function forgetThumbs() {
    athumbMemory = {};
    memory = {};
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf(ATHUMB_KEY) === 0 || k.indexOf(THUMB_KEY) === 0) localStorage.removeItem(k);
      });
    } catch (e) { /* ignore */ }
  }

  window.Photos = {
    prepare: prepare, upload: upload, get: get, element: element, picker: picker,
    attachmentThumb: attachmentThumb, thumbBox: thumbBox, thumbFromBase64: thumbFromBase64, rememberAttachmentThumb: rememberAthumb, forgetThumbs: forgetThumbs,
    fileButton: fileButton, prepareAttachment: prepareAttachment, fetchAttachment: fetchAttachment, toBlobUrl: toBlobUrl,
  };
})();
