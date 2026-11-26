// "Export vehicle data": the person ticks what to include. The download is a PDF of the ticked sections (expanded in full)
// and, when any files are ticked, one zip holding it with a folder for each file, named after its unique ID (such as A-0002).
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
    var url = URL.createObjectURL(new Blob([bytes], { type: /\.pdf$/.test(name) ? 'application/pdf' : 'application/zip' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    return url;
  }

  // the tick boxes, in their groups: [key in ExportReport.DEFAULTS, label, short note]
  var GROUPS = [
    ['Vehicle', [['vehicle', 'Vehicle details'], ['buyCost', 'What the car cost to buy', 'The car\'s acquisition cost.'], ['odometer', 'Odometer log'], ['reminders', 'Reminders'],
      ['fluids', 'Fluids, bulbs and specifications'], ['carFiles', 'Car attachments', 'The car\'s Documents section: its list and files.']]],
    ['Log', [['issues', 'Issue entries'], ['maintenance', 'Maintenance entries'], ['purchases', 'Purchased items'], ['entryFiles', 'Entry attachments', 'Photos and files on the log entries.'],
      ['aiTips', 'AI tips', 'AI\'s own advice on issues. It can be wrong.']]],
    ['Costs', [['costs', 'Running costs', ' ']]],
  ];

  /** Ask what to include. Starts the same way every time. Resolves with the ticks, or null if cancelled. */
  function choose(car) {
    var el = UI.el;
    return new Promise(function (resolve) {
      var previous = document.activeElement;
      var include = ExportReport.ticks();
      var notes = {};
      var groups = GROUPS.map(function (g) {
        return el('fieldset', { class: 'export-group' }, [el('legend', { text: g[0] })].concat(g[1].map(function (t) {
          var box = el('input', { type: 'checkbox', name: t[0] });
          box.checked = include[t[0]];
          box.addEventListener('change', function () { include[t[0]] = box.checked; draw(); });
          var note = t[2] ? el('span', { class: 'export-note', text: t[2] }) : null;
          notes[t[0]] = note;
          return el('label', { class: 'export-tick' }, [box, el('span', { class: 'export-label' }, [el('span', { text: t[1] }), note])]);
        })));
      });
      var covers = el('p', { class: 'section-note export-covers', 'aria-live': 'polite' });
      var stillShown = el('p', { class: 'muted small-text', text: 'Prices in notes and attached files will still show.' });
      var go = el('button', { type: 'button', class: 'btn export-go' });
      var cancel = el('button', { type: 'button', class: 'btn secondary', text: 'Cancel' });
      var heading = el('h2', { text: 'Choose what to export', tabindex: '-1' });
      var overlay = el('div', { class: 'dialog-overlay' }, [el('div', { class: 'dialog export-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Choose what to export' },
        [heading, el('p', { class: 'muted small-text', text: car.registration })].concat(groups, [el('div', { class: 'export-actions' }, [cancel, go])]))]);

      function draw() {
        var has = ExportReport.effective(include);
        var cover = ExportReport.totalsCover(include);
        notes.costs.textContent = include.costs ? 'Cost totals, and amounts on entries.' : 'No running-cost amounts will be shown, including quotes.';
        covers.hidden = !include.costs;
        covers.classList.toggle('partial', !cover.all);
        covers.textContent = cover.all ? 'Totals cover ' + cover.covers + '.'
          : cover.none ? 'There will be no totals: no entry types or reminders are ticked.'
            : 'Totals will cover only ' + cover.covers + '. Not included: ' + cover.leftOut + '.';
        stillShown.hidden = include.costs;
        go.textContent = has.files ? 'Export (PDF and files)' : 'Export (PDF only)';
        go.disabled = !has.content;
      }
      function close(answer) {
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('hashchange', away);
        overlay.remove();
        if (previous && previous.focus) { try { previous.focus(); } catch (e) { /* ignore */ } }
        resolve(answer);
      }
      function away() { close(null); } // the phone's Back button
      function onKey(ev) { if (ev.key === 'Escape') { ev.preventDefault(); close(null); } }
      go.addEventListener('click', function () { close(include); });
      cancel.addEventListener('click', function () { close(null); });
      overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(null); });
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('hashchange', away);
      // the costs note sits under its tick box, with what the totals will cover beneath it
      groups[groups.length - 1].append(covers, stillShown);
      draw();
      document.body.append(overlay);
      heading.focus();
    });
  }

  /** Ask what to include, then export it. `car` is the car as shown on its page. Resolves when the person closes the last screen. */
  function run(car) {
    return choose(car).then(function (include) { return include ? make(car, include) : null; });
  }

  function make(car, include) {
    var has = ExportReport.effective(include);
    var ui = FleetSync.overlay('Exporting data for ' + car.registration, {
      intro: (has.files ? 'Collecting what you ticked, with its files, into one zip download.' : 'Making a PDF of what you ticked.') + ' Please keep this screen open until it finishes.',
      footnote: has.files ? 'The zip holds the PDF, plus a folder for each file included, named by its unique ID.' : 'No files are included, so the download is just the PDF.',
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
        if (!include.vehicle || (!c.photoId && !c.photoThumbId)) return null;
        step(0.08, 'Getting the car\'s photo…');
        return Photos.get(c, c.photoId ? 'full' : 'thumb').then(function (url) { state.carPhoto = dataUrlBytes(url); }).catch(function () { /* the PDF is made without it */ });
      });
    }

    // 2. every file, by its unique ID
    function jobs() {
      var list = [];
      var page = state.bundle.page;
      var seen = {}; // one report file can be on several entries
      if (has.entryFiles) {
        Object.keys(state.bundle.details).forEach(function (eid) {
          var detail = state.bundle.details[eid];
          if (!ExportReport.wantsType(include, detail.entry.type)) return;
          (detail.attachments || []).forEach(function (a) {
            if (seen[a.id]) return;
            seen[a.id] = true;
            list.push({ id: a.id, ref: a.ref || a.id, kind: 'attachment', mime: a.mime, thumb: a.mime === 'image/jpeg' && a.thumb });
          });
        });
      }
      if (include.carFiles) (page.documents || []).forEach(function (d) { list.push({ id: d.id, ref: d.ref || d.id, kind: 'document', mime: d.mime }); });
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
        exportedBy: me ? me.name : '', exportedAt: new Date(), include: include,
      });
      if (!has.files) return { bytes: pdf, count: 0 };
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
        var name = ZipKit.safeName(car.registration).replace(/\s+/g, '-') + '-vehicle-data-' + today() + (has.files ? '.zip' : '.pdf');
        url = saveFile(result.bytes, name);
        var mb = (result.bytes.length / 1048576).toFixed(1);
        var missing = Object.keys(state.failed).length;
        ui.done('Done: ' + name + ' (' + mb + ' MB' + (has.files ? ', ' + result.count + ' file' + (result.count === 1 ? '' : 's') : '') + (missing ? ', ' + missing + ' could not be included' : '') + '). Your download should have started.', [
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
