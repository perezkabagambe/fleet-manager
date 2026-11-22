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

  /** Data URL for one of a car's several photos (`photo` is { id }), 'thumb' or 'full', remembered by the photo's own id. */
  function getById(car, photo, kind) {
    var key = 'cp:' + photo.id + ':' + kind;
    if (memory[key]) return Promise.resolve(memory[key]);
    if (kind === 'thumb') {
      try {
        var saved = localStorage.getItem(THUMB_KEY + key);
        if (saved) { memory[key] = saved; return Promise.resolve(saved); }
      } catch (e) { /* ignore */ }
    }
    if (!inflight[key]) {
      inflight[key] = FleetApi.call('getPhoto', { carId: car.id, kind: kind, photoId: photo.id }).then(function (r) {
        var src = dataUrl(r.data.data);
        remember(key, src, kind === 'thumb');
        return src;
      }).finally(function () { delete inflight[key]; });
    }
    return inflight[key];
  }

  /**
   * The car's photos on its page: swipe left and right between them. With one photo (or none) it is just the photo.
   * Every slide shows its small picture at once; the full picture is fetched when the slide comes into view.
   * Tap a photo to see it full screen. Arrows and a counter help where swiping is not possible.
   */
  function carousel(car) {
    var photos = car.photos || [];
    if (photos.length < 2) return element(car, 'full', 'big');
    var track = el('div', { class: 'carousel-track', role: 'group', 'aria-label': 'The car\'s photos, swipe to see more' });
    var count = el('div', { class: 'carousel-count', 'aria-live': 'polite' });
    var slides = photos.map(function (ph, i) {
      var box = el('div', { class: 'photo big carousel-slide zoomable', role: 'button', tabindex: '0', 'aria-label': 'Photo ' + (i + 1) + ' of ' + photos.length + ', tap to see it full screen' });
      var img = el('img', { class: 'photo-img', alt: car.registration + ' photo ' + (i + 1) });
      box.append(img);
      var haveFull = false;
      var loadFull = function () {
        if (haveFull) return;
        haveFull = true;
        getById(car, ph, 'full').then(function (src) { img.src = src; }).catch(function () { haveFull = false; });
      };
      getById(car, ph, 'thumb').then(function (src) { if (!haveFull || !img.src) img.src = src; }).catch(function () {});
      function open(ev) {
        ev.preventDefault();
        openFull({ preview: img.src, load: function () { return getById(car, ph, 'full'); } });
      }
      box.addEventListener('click', open);
      box.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') open(ev); });
      box._loadFull = loadFull;
      track.append(box);
      return box;
    });
    slides[0]._loadFull(); // the main photo at once
    if ('IntersectionObserver' in window) {
      var seen = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) en.target._loadFull(); });
      }, { root: track, threshold: 0.4 });
      slides.forEach(function (s) { seen.observe(s); });
    } else {
      slides.forEach(function (s) { s._loadFull(); });
    }
    function index() { return Math.max(0, Math.min(photos.length - 1, Math.round(track.scrollLeft / Math.max(track.clientWidth, 1)))); }
    function update() { count.textContent = (index() + 1) + ' / ' + photos.length; }
    var timer = null;
    track.addEventListener('scroll', function () { clearTimeout(timer); timer = setTimeout(update, 40); });
    function go(delta) { track.scrollTo({ left: (index() + delta) * track.clientWidth, behavior: 'smooth' }); }
    var prev = el('button', { type: 'button', class: 'carousel-arrow carousel-prev', 'aria-label': 'Previous photo', text: '‹' });
    var next = el('button', { type: 'button', class: 'carousel-arrow carousel-next', 'aria-label': 'Next photo', text: '›' });
    prev.addEventListener('click', function () { go(-1); });
    next.addEventListener('click', function () { go(1); });
    update();
    return el('div', { class: 'carousel' }, [track, prev, next, count]);
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
      // the photo on the car's page opens full screen when tapped (on the fleet list a tap opens the car instead)
      box.classList.add('zoomable');
      box.setAttribute('role', 'button');
      box.tabIndex = 0;
      var openCar = function (ev) {
        if (box.classList.contains('placeholder')) return;
        ev.preventDefault();
        var shown = box.querySelector('img');
        openFull({ preview: shown ? shown.src : '', load: function () { return get(car, car.photoId ? 'full' : 'thumb'); } });
      };
      box.addEventListener('click', openCar);
      box.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') openCar(ev); });
    } else {
      get(car, 'thumb').then(show).catch(function () {});
    }
    return box;
  }

  /**
   * Two buttons: "Take photo" (opens the camera straight away on a phone) and "Choose photo"
   * (opens the gallery or files). Calls onFile(file) with whatever was picked.
   */
  /** Hand the chosen files to `onFile` one after another (waiting for each to finish, when it returns a promise). */
  function eachFile(files, onFile) {
    var chain = Promise.resolve();
    Array.prototype.forEach.call(files, function (file) {
      chain = chain.then(function () { return onFile(file); }).catch(function () { /* each caller reports its own problems; the rest still go on */ });
    });
  }

  function picker(onFile) {
    function button(label, camera) {
      // "Choose photo" lets you pick several at once; the camera takes one at a time
      var input = el('input', Object.assign({ type: 'file', accept: 'image/*', class: 'file-input' }, camera ? { capture: 'environment' } : { multiple: true }));
      input.addEventListener('change', function () {
        var files = input.files ? Array.prototype.slice.call(input.files) : [];
        input.value = ''; // so picking the same photo again still fires
        eachFile(files, onFile);
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
    // choosing (not the camera) lets you pick several files at once; they are added one after another
    var input = el('input', Object.assign({ type: 'file', accept: accept, class: 'file-input' }, capture ? { capture: 'environment' } : { multiple: true }));
    input.addEventListener('change', function () {
      var files = input.files ? Array.prototype.slice.call(input.files) : [];
      input.value = '';
      eachFile(files, onFile);
    });
    return el('label', { class: 'btn small secondary file-btn' }, [el('span', { text: label }), input]);
  }

  var MAX_FILE_BYTES = 5000000; // PDFs and every other kind of file

  /**
   * An attachment for an entry. A photo is shrunk to a JPEG (with a small thumbnail). A PDF, or any other file
   * (a Word or Excel file, a text file, a zip...), is sent as it is, up to 5 MB.
   */
  // Some phones (a file opened from Google Drive, for instance) give a PDF no type and no ".pdf" in its name,
  // so the first bytes of the file decide: a PDF always starts with "%PDF".
  function looksLikePdf(file) {
    return new Promise(function (resolve) {
      try {
        var reader = new FileReader();
        reader.onload = function () {
          var a = new Uint8Array(reader.result);
          resolve(a.length >= 4 && a[0] === 0x25 && a[1] === 0x50 && a[2] === 0x44 && a[3] === 0x46);
        };
        reader.onerror = function () { resolve(false); };
        reader.readAsArrayBuffer(file.slice(0, 8));
      } catch (e) { resolve(false); }
    });
  }

  function prepareAttachment(file) {
    var name = file.name || '';
    var named = file.type === 'application/pdf' || /\.pdf$/i.test(name);
    var known = named ? Promise.resolve(true) : (/^image\//.test(file.type || '') ? Promise.resolve(false) : looksLikePdf(file));
    return known.then(function (isPdf) {
      function asFile() {
        if (!file.size) return Promise.reject(new FleetApi.ApiError('invalid_attachment', 'Empty file'));
        if (file.size > MAX_FILE_BYTES) return Promise.reject(new FleetApi.ApiError('attachment_too_large', 'File too large'));
        return toBase64(file).then(function (b64) {
          var filename = name || (isPdf ? 'document.pdf' : 'file');
          if (isPdf && !/\.pdf$/i.test(filename)) filename += '.pdf';
          return { mime: isPdf ? 'application/pdf' : 'application/octet-stream', data: b64, filename: filename };
        });
      }
      if (!isPdf && /^image\//.test(file.type || '')) {
        return prepare(file).then(function (p) {
          return { mime: 'image/jpeg', data: p.full, thumb: p.thumb, filename: name || 'photo.jpg' };
        }).catch(function () { return asFile(); }); // a picture this browser cannot read is kept as it is
      }
      return asFile();
    });
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
  // Fetched a few at a time (one request for up to 8), remembered on this phone by attachment id (in FleetStore, the
  // phone's database, which has room for all of them) and forgotten at sign-out. FleetSync downloads them all up front.
  var ATHUMB_KEY = 'fleet.athumb.'; // where an older version kept them (localStorage): moved over the first time one is needed
  var ATHUMB_BATCH = 8;
  var athumbMemory = {};
  var athumbWaiting = {};
  var athumbQueue = [];
  var athumbTimer = null;

  function store() { return window.FleetStore; }

  function rememberAthumb(id, src) {
    athumbMemory[id] = src;
    if (store()) store().set('t|' + id, src);
  }

  function savedAthumb(id) {
    if (athumbMemory[id]) return athumbMemory[id];
    var src = store() ? store().get('t|' + id) : null;
    if (!src) {
      try {
        src = localStorage.getItem(ATHUMB_KEY + id);
        if (src) { rememberAthumb(id, src); localStorage.removeItem(ATHUMB_KEY + id); }
      } catch (e) { /* ignore */ }
    }
    if (src) athumbMemory[id] = src;
    return src || null;
  }

  /** Download the thumbnails for up to 8 attachments in one request and remember them. Resolves to how many arrived. */
  function fetchThumbBatch(ids) {
    return FleetApi.call('getAttachmentThumbs', { ids: ids }).then(function (r) {
      var n = 0;
      ids.forEach(function (id) {
        var b64 = r.data.thumbs && r.data.thumbs[id];
        if (b64) { rememberAthumb(id, dataUrl(b64)); n++; }
      });
      return n;
    });
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
    for (var i = 0; i < ids.length; i += ATHUMB_BATCH) {
      (function (batch) {
        fetchThumbBatch(batch).then(function () {
          batch.forEach(function (id) { settle(id, athumbMemory[id] || null); });
        }).catch(function (e) { batch.forEach(function (id) { settle(id, null, e); }); });
      })(ids.slice(i, i + ATHUMB_BATCH));
    }
  }

  /** Data URL of an attachment's small thumbnail. */
  function attachmentThumb(id) {
    var saved = savedAthumb(id);
    if (saved) return Promise.resolve(saved);
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
    var box = el('div', { class: 'thumb-box zoomable ' + (cls || ''), role: 'button', tabindex: '0', 'aria-label': 'View the photo full screen' });
    attachmentThumb(id).then(function (src) {
      box.replaceChildren(el('img', { class: 'thumb-img', src: src, alt: '' }));
    }).catch(function () { /* no thumbnail: the placeholder stays */ });
    function open(ev) {
      ev.preventDefault(); // a thumbnail inside a link (a row in the log) shows the photo instead of following the link
      ev.stopPropagation();
      var img = box.querySelector('img');
      openFull({
        preview: img ? img.src : '',
        load: function () { return fetchAttachment(id).then(function (att) { return 'data:' + att.mime + ';base64,' + att.data; }); },
      });
    }
    box.addEventListener('click', open);
    box.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') open(ev); });
    return box;
  }

  // ---------- a photo shown full screen ----------
  /**
   * Opens a photo over the whole screen at its full resolution. `preview` (the small picture) is shown at once and
   * replaced by what `load()` resolves to (a data or object URL) when it arrives. Tap the picture to see it at its real
   * size and drag to look around; tap again to fit it to the screen. Close with the X, a tap outside the picture, Escape
   * or the phone's Back button.
   */
  var lightboxOpen = null;
  function openFull(opts) {
    if (lightboxOpen) return;
    var previous = document.activeElement;
    var img = el('img', { class: 'lightbox-img', alt: 'Photo' });
    if (opts.preview) img.src = opts.preview;
    var note = el('div', { class: 'lightbox-note', text: 'Loading the full photo…' });
    var close = el('button', { type: 'button', class: 'lightbox-close', 'aria-label': 'Close the photo', text: '✕' });
    var stage = el('div', { class: 'lightbox-stage' }, [img]);
    var box = el('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo' }, [stage, close, note]);
    var zoomed = false;
    var closed = false;

    function shut() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      box.remove();
      document.body.classList.remove('lightbox-on');
      lightboxOpen = null;
      if (previous && previous.focus) previous.focus();
    }
    function onPop() { shut(); }
    function onKey(ev) { if (ev.key === 'Escape') requestClose(); }
    function requestClose() {
      if (history.state && history.state.lightbox) history.back(); // the Back button's own way out (it ends in onPop)
      else shut();
    }
    img.addEventListener('click', function (ev) {
      ev.stopPropagation();
      zoomed = !zoomed;
      box.classList.toggle('zoomed', zoomed);
    });
    stage.addEventListener('click', function (ev) { if (ev.target === stage && !zoomed) requestClose(); });
    close.addEventListener('click', requestClose);
    document.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onPop);
    try { history.pushState({ lightbox: true }, ''); } catch (e) { /* no history: the X still closes it */ }
    document.body.append(box);
    document.body.classList.add('lightbox-on');
    lightboxOpen = box;
    close.focus();

    Promise.resolve().then(opts.load).then(function (src) {
      if (closed) return;
      img.src = src;
      note.remove();
    }).catch(function () {
      if (closed) return;
      note.textContent = 'Could not load the full photo just now.' + (opts.preview ? ' This is the small version.' : '');
    });
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
    if (store()) store().delPrefix('t|');
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf(ATHUMB_KEY) === 0 || k.indexOf(THUMB_KEY) === 0) localStorage.removeItem(k);
      });
    } catch (e) { /* ignore */ }
  }

  // a photo shown inline (the View button on an attached file) opens full screen when tapped
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t && t.classList && t.classList.contains('attach-img') && t.src) {
      ev.preventDefault();
      openFull({ preview: t.src, load: function () { return Promise.resolve(t.src); } });
    }
  });

  window.Photos = {
    prepare: prepare, upload: upload, get: get, getById: getById, element: element, carousel: carousel, picker: picker, openFull: openFull,
    attachmentThumb: attachmentThumb, thumbBox: thumbBox, thumbFromBase64: thumbFromBase64, rememberAttachmentThumb: rememberAthumb, hasAttachmentThumb: function (id) { return !!savedAthumb(id); }, fetchThumbBatch: fetchThumbBatch, THUMB_BATCH: ATHUMB_BATCH, forgetThumbs: forgetThumbs,
    fileButton: fileButton, prepareAttachment: prepareAttachment, fetchAttachment: fetchAttachment, toBlobUrl: toBlobUrl,
  };
})();
