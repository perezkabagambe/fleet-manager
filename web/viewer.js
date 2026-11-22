// Showing a file inside the app: photos open full screen, PDFs open in a viewer (their pages are drawn with pdf.js, which
// is kept in vendor/ and only loaded the first time a PDF is opened). Any other kind of file is saved to the phone, because
// there is nothing the app can show for it.
(function () {
  'use strict';

  var el = UI.el;
  var libPromise = null;
  var pdfOpen = false;

  function loadLib() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!libPromise) {
      libPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'vendor/pdf.min.js';
        s.onload = function () {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
          resolve(window.pdfjsLib);
        };
        s.onerror = function () { libPromise = null; reject(new Error('The PDF viewer could not be loaded.')); };
        document.head.append(s);
      });
    }
    return libPromise;
  }

  function bytesOf(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function saveToPhone(att) {
    var url = Photos.toBlobUrl(att);
    var link = el('a', { href: url, download: att.filename || 'file' });
    document.body.append(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  // ---------- a PDF full screen ----------
  var ZOOMS = [1, 1.5, 2, 3];

  function openPdf(o) {
    if (pdfOpen) return;
    pdfOpen = true;
    var previous = document.activeElement;
    var closed = false;
    var doc = null;
    var zoomIndex = 0;
    var observer = null;
    var pages = []; // { box, canvas, number, drawnAt }

    var title = el('div', { class: 'pdfview-title', text: o.filename || 'PDF' });
    var count = el('div', { class: 'pdfview-count' });
    var zoomOut = el('button', { type: 'button', class: 'pdfview-btn', 'aria-label': 'Zoom out', text: '−' });
    var zoomIn = el('button', { type: 'button', class: 'pdfview-btn', 'aria-label': 'Zoom in', text: '+' });
    var save = el('button', { type: 'button', class: 'pdfview-btn pdfview-save', 'aria-label': 'Save a copy to this phone', text: 'Save' });
    var close = el('button', { type: 'button', class: 'pdfview-btn', 'aria-label': 'Close', text: '✕' });
    var stage = el('div', { class: 'pdfview-stage' });
    var note = el('div', { class: 'pdfview-note', text: 'Loading the PDF…' });
    var bar = el('div', { class: 'pdfview-bar' }, [el('div', { class: 'pdfview-heading' }, [title, count]), zoomOut, zoomIn, save, close]);
    var box = el('div', { class: 'pdfview', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.filename || 'PDF' }, [bar, stage, note]);
    var attachment = null;

    function shut() {
      if (closed) return;
      closed = true;
      pdfOpen = false;
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', shut);
      window.removeEventListener('resize', onResize);
      if (observer) observer.disconnect();
      try { if (doc) doc.destroy(); } catch (e) { /* ignore */ }
      box.remove();
      document.body.classList.remove('lightbox-on');
      if (previous && previous.focus) previous.focus();
    }
    function requestClose() {
      if (history.state && history.state.viewer) history.back(); // ends in shut() through popstate
      else shut();
    }
    function onKey(ev) { if (ev.key === 'Escape') requestClose(); }
    close.addEventListener('click', requestClose);
    document.addEventListener('keydown', onKey);
    window.addEventListener('popstate', shut);
    try { history.pushState({ viewer: true }, ''); } catch (e) { /* no history: the X still closes it */ }
    document.body.append(box);
    document.body.classList.add('lightbox-on');
    close.focus();

    function cssWidth() { return Math.max(200, (stage.clientWidth - 16)) * ZOOMS[zoomIndex]; }

    function drawPage(p) {
      if (closed || !doc) return;
      var width = cssWidth();
      if (p.drawnAt === width) return;
      p.drawnAt = width;
      doc.getPage(p.number).then(function (page) {
        if (closed || p.drawnAt !== width) return;
        var base = page.getViewport({ scale: 1 });
        var cssScale = width / base.width;
        // sharp on a phone's screen, but never an enormous picture
        var output = Math.min(window.devicePixelRatio || 1, 2, 3200 / width);
        var viewport = page.getViewport({ scale: cssScale * Math.max(output, 1) });
        var canvas = el('canvas', { class: 'pdfview-canvas' });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = width + 'px';
        canvas.style.height = Math.round(width * base.height / base.width) + 'px';
        p.box.style.width = width + 'px';
        p.box.style.height = canvas.style.height;
        return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise.then(function () {
          if (closed || p.drawnAt !== width) return;
          p.box.replaceChildren(canvas);
        });
      }).catch(function () { p.drawnAt = 0; });
    }

    function layout() {
      var width = cssWidth();
      pages.forEach(function (p) {
        p.box.style.width = width + 'px';
        p.box.style.height = Math.round(width * p.ratio) + 'px';
        p.drawnAt = 0;
        p.box.replaceChildren();
      });
      if (observer) { observer.disconnect(); pages.forEach(function (p) { observer.observe(p.box); }); }
    }
    function onResize() { if (doc) layout(); }
    window.addEventListener('resize', onResize);

    function setZoom(delta) {
      var next = Math.max(0, Math.min(ZOOMS.length - 1, zoomIndex + delta));
      if (next === zoomIndex) return;
      zoomIndex = next;
      layout();
    }
    zoomIn.addEventListener('click', function () { setZoom(1); });
    zoomOut.addEventListener('click', function () { setZoom(-1); });

    function updateCount() {
      if (!pages.length) return;
      var top = stage.getBoundingClientRect().top;
      var current = 1;
      for (var i = 0; i < pages.length; i++) {
        if (pages[i].box.getBoundingClientRect().bottom - top > stage.clientHeight * 0.3) { current = i + 1; break; }
        current = i + 1;
      }
      count.textContent = 'Page ' + current + ' of ' + pages.length;
    }
    var scrollTimer = null;
    stage.addEventListener('scroll', function () { clearTimeout(scrollTimer); scrollTimer = setTimeout(updateCount, 50); });

    function failed(text) {
      note.hidden = false;
      note.replaceChildren(el('div', { text: text }), el('button', { type: 'button', class: 'btn small', text: 'Save it to this phone instead', onclick: function () { if (attachment) saveToPhone(attachment); } }));
    }
    save.addEventListener('click', function () { if (attachment) saveToPhone(attachment); });

    Promise.all([loadLib(), Promise.resolve().then(o.load)]).then(function (res) {
      if (closed) return null;
      attachment = res[1];
      return res[0].getDocument({ data: bytesOf(attachment.data), isEvalSupported: false }).promise;
    }).then(function (pdf) {
      if (!pdf || closed) { if (pdf) pdf.destroy(); return; }
      doc = pdf;
      return pdf.getPage(1).then(function (first) {
        var base = first.getViewport({ scale: 1 });
        var ratio = base.height / base.width;
        var n = pdf.numPages;
        for (var i = 1; i <= n; i++) {
          var holder = el('div', { class: 'pdfview-page' });
          pages.push({ box: holder, number: i, drawnAt: 0, ratio: ratio });
          stage.append(holder);
        }
        if ('IntersectionObserver' in window) {
          observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
              if (!en.isIntersecting) return;
              var p = pages.filter(function (x) { return x.box === en.target; })[0];
              if (p) drawPage(p);
            });
          }, { root: stage, rootMargin: '600px 0px' });
          pages.forEach(function (p) { observer.observe(p.box); });
        }
        layout();
        if (!observer) pages.forEach(drawPage);
        note.hidden = true;
        updateCount();
      });
    }).catch(function (e) {
      if (closed) return;
      failed(e && e.name === 'PasswordException' ? 'This PDF is protected by a password, so it cannot be shown here.' : 'This PDF could not be shown here.');
    });
  }

  /**
   * Show a file. `o`: { mime, filename, preview (a small picture to show at once, for photos), load() -> Promise of
   * { filename, mime, data (base64) } }. Photos open full screen, PDFs in the viewer, anything else is saved to the phone.
   * Returns a promise that settles once the file is on screen (or saved).
   */
  function show(o) {
    if (/^image\/(jpeg|png|webp)$/.test(o.mime)) {
      Photos.openFull({ preview: o.preview || '', load: function () { return Promise.resolve(o.load()).then(function (a) { return 'data:' + a.mime + ';base64,' + a.data; }); } });
      return Promise.resolve();
    }
    if (o.mime === 'application/pdf') { openPdf(o); return Promise.resolve(); }
    return Promise.resolve(o.load()).then(saveToPhone);
  }

  /** True if the app can show this kind of file itself (otherwise it is saved to the phone). */
  function canShow(mime) { return /^image\/(jpeg|png|webp)$/.test(mime) || mime === 'application/pdf'; }

  window.Viewer = { show: show, canShow: canShow };
})();
