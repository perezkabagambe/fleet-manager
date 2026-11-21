// "Export all vehicle data": downloads one zip with a PDF of everything about a car (every section expanded) and, for
// every attachment and car document, a folder named after its unique ID (such as A-0002) holding the original file.
// Everything is put together on this phone; nothing is sent anywhere except the usual requests to read the data.
(function () {
  'use strict';

  var CONCURRENT = 3;          // files downloaded at the same time
  var FILE_TIMEOUT_MS = 120000; // a 5 MB file can take a while on a slow connection

  function pool(items, size, worker) {
    var index = 0;
    var active = 0;
    return new Promise(function (resolve) {
      function pump() {
        if (index >= items.length && active === 0) { resolve(); return; }
        while (active < size && index < items.length) launch(items[index++]);
      }
      function launch(item) {
        active++;
        Promise.resolve().then(function () { return worker(item); }).catch(function () { /* the worker records its own failures */ }).then(function () { active--; pump(); });
      }
      pump();
    });
  }

  function retry(fn, times) {
    return fn().catch(function (e) {
      if (times > 1 && e && e.code !== 'unauthorized' && e.code !== 'not_found') return retry(fn, times - 1);
      throw e;
    });
  }

  function fromBase64(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function dataUrlBytes(url) {
    var i = String(url).indexOf('base64,');
    return i < 0 ? null : fromBase64(String(url).slice(i + 7));
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  /** Download a file the person can keep. Returns the temporary address, so it can be offered again. */
  function saveFile(bytes, name) {
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    return url;
  }

  /**
   * Run the export for one car. `car` is the car as shown on its page. Resolves when the person closes the screen.
   */
  function run(car) {
    var ui = FleetSync.overlay('Exporting all data for ' + car.registration, {
      intro: 'Collecting the vehicle\'s data, photos and files into one zip download. Please keep this screen open until it finishes.',
      footnote: 'The zip holds a PDF of everything, plus a folder for each photo, file and document, named by its unique ID.',
    });
    var state = { bundle: null, carPhoto: null, files: {}, thumbs: {}, failed: {} };

    function step(fraction, text) { ui.set(fraction, text); }

    // 1. the car's data, read fresh from the server
    function loadData() {
      if (state.bundle) return Promise.resolve();
      step(0.03, 'Reading the vehicle\'s data…');
      return retry(function () { return FleetApi.call('getCarBundle', { carId: car.id }, { timeoutMs: 60000 }); }, 2).then(function (r) {
        state.bundle = r.data;
        var c = r.data.page.car;
        if (!c.photoId && !c.photoThumbId) return null;
        step(0.08, 'Getting the car\'s photo…');
        return Photos.get(c, c.photoId ? 'full' : 'thumb').then(function (url) { state.carPhoto = dataUrlBytes(url); }).catch(function () { /* the PDF is made without it */ });
      });
    }

    // 2. every file, by its unique ID
    function jobs() {
      var list = [];
      var page = state.bundle.page;
      Object.keys(state.bundle.details).forEach(function (eid) {
        (state.bundle.details[eid].attachments || []).forEach(function (a) { list.push({ id: a.id, ref: a.ref || a.id, kind: 'attachment', mime: a.mime, thumb: a.mime === 'image/jpeg' && a.thumb }); });
      });
      (page.documents || []).forEach(function (d) { list.push({ id: d.id, ref: d.ref || d.id, kind: 'document', mime: d.mime }); });
      return list;
    }

    function download() {
      var todo = jobs().filter(function (j) { return !state.files[j.id]; });
      var total = jobs().length;
      var done = total - todo.length;
      if (!todo.length) return Promise.resolve();
      state.failed = {};
      return pool(todo, CONCURRENT, function (j) {
        var action = j.kind === 'document' ? 'getCarDocument' : 'getAttachment';
        return retry(function () { return FleetApi.call(action, { id: j.id }, { timeoutMs: FILE_TIMEOUT_MS }); }, 2).then(function (r) {
          state.files[j.id] = { ref: j.ref, filename: r.data.filename, bytes: fromBase64(r.data.data) };
          if (j.thumb) return Photos.attachmentThumb(j.id).then(function (url) { state.thumbs[j.id] = dataUrlBytes(url); }).catch(function () { /* no picture in the PDF for this one */ });
          return null;
        }).catch(function (e) {
          if (e && e.code === 'unauthorized') throw e;
          state.failed[j.id] = true;
        }).then(function () {
          done++;
          step(0.1 + 0.75 * (done / Math.max(total, 1)), 'Downloading files (' + done + ' of ' + total + ')');
        });
      });
    }

    // 3. the PDF and the zip
    function assemble() {
      step(0.88, 'Building the PDF…');
      var page = state.bundle.page;
      var me = FleetAuth.getUser();
      var jpegs = {};
      Object.keys(state.thumbs).forEach(function (id) { if (state.thumbs[id]) jpegs[id] = state.thumbs[id]; });
      var pdf = ExportReport.build({
        car: page.car, people: page.people, fluids: page.fluids, entries: page.entries, details: state.bundle.details, tasks: page.tasks,
        costs: page.costs, documents: page.documents, carPhoto: state.carPhoto, thumbs: jpegs, missing: state.failed,
        exportedBy: me ? me.name : '', exportedAt: new Date(),
      });
      step(0.94, 'Packing the zip…');
      var zip = ZipKit.create(new Date());
      zip.add('Vehicle data - ' + ZipKit.safeName(page.car.registration) + '.pdf', pdf);
      Object.keys(state.files).forEach(function (id) {
        var f = state.files[id];
        zip.add(ZipKit.safeName(f.ref) + '/' + ZipKit.safeName(f.filename, 'file'), f.bytes);
      });
      return { bytes: zip.finish(), count: Object.keys(state.files).length };
    }

    return new Promise(function (resolve) {
      var url = null;
      function finish(result) {
        var name = ZipKit.safeName(car.registration).replace(/\s+/g, '-') + '-vehicle-data-' + today() + '.zip';
        url = saveFile(result.bytes, name);
        var mb = (result.bytes.length / 1048576).toFixed(1);
        var missing = Object.keys(state.failed).length;
        ui.done('Done: ' + name + ' (' + mb + ' MB, ' + result.count + ' file' + (result.count === 1 ? '' : 's') + (missing ? ', ' + missing + ' could not be included' : '') + '). Your download should have started.', [
          { label: 'Download again', primary: true, onClick: function () { saveFile(result.bytes, name); } },
          { label: 'Close', onClick: function () { ui.close(); setTimeout(function () { if (url) URL.revokeObjectURL(url); }, 60000); resolve(); } },
        ]);
      }
      function attempt() {
        loadData().then(download).then(function () {
          var missing = Object.keys(state.failed).length;
          if (missing) {
            ui.fail(missing + (missing === 1 ? ' file' : ' files') + ' could not be downloaded just now. You can try those again, or export without them (the PDF will say which are missing).',
              attempt, function () { finish(assemble()); }, { retry: 'Try the missing files again', skip: 'Export without them' });
            return null;
          }
          finish(assemble());
          return null;
        }).catch(function (e) {
          if (e && e.code === 'unauthorized') { ui.close(); resolve(); return; }
          ui.fail(UI.errorText(e), attempt, function () { ui.close(); resolve(); }, { retry: 'Try again', skip: 'Cancel' });
        });
      }
      attempt();
    });
  }

  window.ExportAll = { run: run };
})();
