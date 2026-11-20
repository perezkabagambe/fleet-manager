// Keeps a copy of the whole fleet's data on this phone, so every screen opens instantly.
//
//  - The first time someone signs in on a phone, everything about every car is downloaded (a progress screen shows
//    how far it has got). Attached files and documents are not included: they download when opened. The small
//    pictures shown beside entries and cars are.
//  - After that, each time the app opens (and when it comes back after a while, and after any change this person
//    makes) one small request asks which cars have changed (backend/Sync.js). Only those cars are downloaded again.
//  - "Refresh all app data" in the menu downloads everything again.
//
// The saved answers themselves live in FleetApi (api.js) and FleetStore (store.js); this file decides when to fill them.
(function () {
  'use strict';

  var el = UI.el;
  var PRIME_VERSION = 1;       // raise it to make every phone download everything again
  var CAR_PARALLEL = 3;        // cars downloaded at the same time
  var THUMB_PARALLEL = 2;      // batches of small pictures downloaded at the same time
  var RECHECK_AFTER_MS = 5 * 60 * 1000;
  var CHANGE_DELAY_MS = 1500;  // after a change, wait a moment so a burst of changes is checked once
  var BUNDLE_TIMEOUT_MS = 60000;

  var userId = '';
  var running = null;          // the download in progress, if any
  var again = false;           // something changed while downloading: check once more afterwards
  var changeTimer = null;
  var lastCheckAt = 0;
  var lastSavedAt = 0;

  function store() { return window.FleetStore; }
  function revsKey() { return 'm|revs|' + userId; }
  function primedKey() { return 'm|primed|' + userId; }
  function dataPrefix() { return 'd|' + userId + '|'; }

  // ---------- small helpers ----------
  /** Run worker(item) for every item, `size` at a time. Rejects (and stops starting new ones) on the first failure. */
  function pool(items, size, worker) {
    var index = 0;
    var active = 0;
    var stopped = false;
    return new Promise(function (resolve, reject) {
      function pump() {
        if (stopped) return;
        if (index >= items.length && active === 0) { resolve(); return; }
        while (active < size && index < items.length) launch(items[index++]);
      }
      function launch(item) {
        active++;
        Promise.resolve().then(function () { return worker(item); }).then(function () { active--; pump(); }, function (e) { stopped = true; reject(e); });
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

  function fetchBundle(carId) {
    return retry(function () { return FleetApi.call('getCarBundle', { carId: carId }, { timeoutMs: BUNDLE_TIMEOUT_MS }); }, 2).then(function (r) { return r.data; });
  }

  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  /**
   * Save everything for one car where the screens look for it. Returns true when something a screen could be
   * showing is different from what was saved before.
   */
  function storeBundle(carId, b) {
    var rev = b.rev;
    var page = b.page;
    var changed = false;
    function put(action, params, data) {
      if (!same(FleetApi.peek(action, params), data)) changed = true;
      FleetApi.put(action, params, data, carId, rev);
    }
    put('getCarPage', { id: carId }, page);
    put('listEntries', { carId: carId }, { entries: page.entries });
    put('listTasks', { carId: carId }, { tasks: page.tasks, distanceUnit: 'mi' });
    put('getCarCosts', { carId: carId }, page.costs);
    put('listCarDocuments', { carId: carId }, { documents: page.documents });
    Object.keys(b.details).forEach(function (id) { put('getEntry', { id: id }, b.details[id]); });
    // entries that no longer exist
    store().keys(dataPrefix() + 'getEntry|').forEach(function (k) {
      var hit = store().get(k);
      var id = hit && hit.data && hit.data.entry && hit.data.entry.id;
      if (hit && hit.scope === carId && id && !b.details[id]) { store().del(k); changed = true; }
    });
    return changed;
  }

  /** Forget saved answers for cars that are no longer there. */
  function sweep(cars) {
    store().keys(dataPrefix()).forEach(function (k) {
      var hit = store().get(k);
      if (hit && hit.scope && hit.scope !== 'fleet' && !Object.prototype.hasOwnProperty.call(cars, hit.scope)) store().del(k);
    });
  }

  function saveRevisions(revs) {
    FleetApi.setRevisions(revs);
    lastSavedAt = Date.now();
    store().set(revsKey(), { revs: revs, at: lastSavedAt });
    try { window.dispatchEvent(new CustomEvent('fleet:synced')); } catch (e) { /* nothing is listening */ }
  }

  // ---------- the progress screen ----------
  function overlay(title) {
    var fill = el('div', { class: 'sync-bar-fill' });
    var track = el('div', { class: 'sync-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'Progress' }, [fill]);
    var status = el('p', { class: 'sync-status', role: 'status', text: 'Starting…' });
    var percent = el('span', { class: 'sync-percent', text: '0%' });
    var actions = el('div', { class: 'sync-actions' });
    var errorBox = el('div');
    var card = el('div', { class: 'sync-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sync-title' }, [
      el('h2', { id: 'sync-title', text: title }),
      el('p', { class: 'muted', text: 'This makes the app much faster on this phone. Please keep this screen open until it finishes.' }),
      el('div', { class: 'sync-bar-row' }, [track, percent]),
      status, errorBox, actions,
      el('p', { class: 'muted small-text', text: 'Attached files and documents are not included: they download when you open them.' }),
    ]);
    var wrap = el('div', { class: 'sync-overlay' }, [card]);
    document.body.append(wrap);
    var shown = 0;
    return {
      set: function (fraction, text) {
        shown = Math.max(shown, Math.min(1, fraction)); // never goes backwards
        var pct = Math.round(shown * 100);
        fill.style.width = pct + '%';
        percent.textContent = pct + '%';
        track.setAttribute('aria-valuenow', String(pct));
        if (text) status.textContent = text;
      },
      fail: function (message, onRetry, onSkip) {
        errorBox.replaceChildren(UI.notice('error', message));
        var again = el('button', { type: 'button', class: 'btn', text: 'Try again' });
        var skip = el('button', { type: 'button', class: 'btn secondary', text: 'Carry on without it' });
        again.addEventListener('click', function () { errorBox.replaceChildren(); actions.replaceChildren(); onRetry(); });
        skip.addEventListener('click', onSkip);
        actions.replaceChildren(again, skip);
      },
      close: function () { wrap.remove(); },
    };
  }

  // ---------- downloading everything ----------
  function primeAll(ui) {
    ui.set(0.02, 'Checking which cars there are…');
    return FleetApi.call('getChanges').then(function (r) {
      var changes = r.data;
      var ids = Object.keys(changes.cars);
      return FleetApi.call('listCars').then(function (lc) {
        FleetApi.put('listCars', {}, lc.data, 'fleet', changes.fleet);
        var regOf = {};
        (lc.data.cars || []).concat(lc.data.deleted || []).forEach(function (c) { regOf[c.id] = c.registration; });
        var carRevs = {};
        var thumbIds = [];
        var done = 0;
        ui.set(0.06, ids.length ? 'Saving car 1 of ' + ids.length + '…' : 'Nothing to save yet.');
        return pool(ids, CAR_PARALLEL, function (id) {
          return fetchBundle(id).then(function (b) {
            storeBundle(id, b);
            carRevs[id] = b.rev || changes.cars[id];
            (b.page.entries || []).forEach(function (e) { if (e.thumbAttachmentId) thumbIds.push(e.thumbAttachmentId); });
            done++;
            ui.set(0.06 + 0.64 * (done / ids.length), 'Saved ' + done + ' of ' + ids.length + ' cars' + (regOf[id] ? ' (' + regOf[id] + ')' : ''));
          });
        }).then(function () {
          return savePictures(ui, lc.data, thumbIds);
        }).then(function () {
          var revs = Object.assign({ fleet: changes.fleet }, carRevs);
          sweep(changes.cars);
          saveRevisions(revs);
          store().set(primedKey(), { v: PRIME_VERSION, at: Date.now() });
          ui.set(1, 'All saved.');
        });
      });
    });
  }

  /** The small pictures: cars' own photos and the thumbnails shown beside entries. Failures here are not worth stopping for. */
  function savePictures(ui, list, thumbIds) {
    var cars = (list.cars || []).concat(list.deleted || []).filter(function (c) { return c.photoThumbId; });
    var need = thumbIds.filter(function (id, i) { return thumbIds.indexOf(id) === i && !Photos.hasAttachmentThumb(id); });
    var batches = [];
    for (var i = 0; i < need.length; i += Photos.THUMB_BATCH) batches.push(need.slice(i, i + Photos.THUMB_BATCH));
    var total = cars.length + batches.length;
    var done = 0;
    function tick() {
      done++;
      ui.set(0.7 + 0.28 * (done / total), 'Saving small pictures (' + done + ' of ' + total + ')');
    }
    if (!total) return Promise.resolve();
    ui.set(0.7, 'Saving small pictures…');
    return pool(cars, CAR_PARALLEL, function (c) {
      return Photos.get(c, 'thumb').catch(function () { /* the picture is fetched when it is needed instead */ }).then(tick);
    }).then(function () {
      return pool(batches, THUMB_PARALLEL, function (batch) {
        return Photos.fetchThumbBatch(batch).catch(function () { /* same */ }).then(tick);
      });
    });
  }

  function runPrime(title) {
    var ui = overlay(title);
    return new Promise(function (resolve) {
      function attempt() {
        primeAll(ui).then(function () {
          setTimeout(function () { ui.close(); resolve(); }, 400);
        }, function (e) {
          if (e && e.code === 'unauthorized') { ui.close(); resolve(); return; }
          ui.fail(UI.errorText(e), attempt, function () { ui.close(); resolve(); });
        });
      }
      attempt();
    });
  }

  // ---------- the quick check ----------
  /** Ask which cars changed since this phone last looked, and download only those. */
  function quickCheck() {
    if (!userId || !FleetAuth.hasSession()) return Promise.resolve();
    if (running) { again = true; return running; }
    lastCheckAt = Date.now();
    var p = FleetApi.call('getChanges').then(function (r) {
      var c = r.data;
      var known = (store().get(revsKey()) || { revs: {} }).revs;
      var carIds = Object.keys(c.cars);
      var changed = carIds.filter(function (id) { return !known[id] || known[id] !== c.cars[id]; });
      var fleetChanged = known.fleet !== c.fleet;

      // cars that have not changed are current again straight away
      var revs = {};
      carIds.forEach(function (id) { if (known[id] && known[id] === c.cars[id]) revs[id] = known[id]; });
      if (!fleetChanged && known.fleet) revs.fleet = known.fleet;
      FleetApi.setRevisions(revs);

      var visible = { cars: [], fleet: false };
      return pool(changed, CAR_PARALLEL, function (id) {
        return fetchBundle(id).then(function (b) {
          if (storeBundle(id, b)) visible.cars.push(id);
          revs[id] = b.rev || c.cars[id];
          FleetApi.setRevisions(revs);
        }).catch(function (e) {
          if (e && e.code === 'unauthorized') throw e; // the others are tried again at the next check
        });
      }).then(function () {
        if (!fleetChanged) return null;
        return FleetApi.call('listCars').then(function (lc) {
          if (!same(FleetApi.peek('listCars', {}), lc.data)) visible.fleet = true;
          FleetApi.put('listCars', {}, lc.data, 'fleet', c.fleet);
          revs.fleet = c.fleet;
          FleetApi.setRevisions(revs);
        });
      }).then(function () {
        sweep(c.cars);
        // only what was really downloaded is recorded as known, so a car that failed is tried again next time
        var record = {};
        Object.keys(revs).forEach(function (k) { record[k] = revs[k]; });
        saveRevisions(record);
        // pictures for entries that are new
        var ids = [];
        changed.forEach(function (id) {
          var page = FleetApi.peek('getCarPage', { id: id });
          ((page && page.entries) || []).forEach(function (e) { if (e.thumbAttachmentId && !Photos.hasAttachmentThumb(e.thumbAttachmentId)) ids.push(e.thumbAttachmentId); });
        });
        var batches = [];
        for (var i = 0; i < ids.length; i += Photos.THUMB_BATCH) batches.push(ids.slice(i, i + Photos.THUMB_BATCH));
        return pool(batches, THUMB_PARALLEL, function (batch) { return Photos.fetchThumbBatch(batch).catch(function () {}); });
      }).then(function () {
        if (visible.cars.length || visible.fleet) {
          try { window.dispatchEvent(new CustomEvent('fleet:data-updated', { detail: visible })); } catch (e) { /* nothing is listening */ }
        }
      });
    }).catch(function () { /* offline or busy: the saved copies keep working and the next check tries again */ })
      .then(function () {
        running = null;
        if (again) { again = false; scheduleCheck(); }
      });
    running = p;
    return p;
  }

  function scheduleCheck() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(quickCheck, CHANGE_DELAY_MS);
  }

  // ---------- starting ----------
  /** Called once the person is known (after sign-in, and each time the app opens). */
  function start() {
    var user = FleetAuth.getUser();
    if (!user || !FleetAuth.hasSession() || !store()) return Promise.resolve();
    if (userId === user.id) return Promise.resolve();
    userId = user.id;
    // The app waits for the saved copy to be read before drawing anything, so this normally runs straight away:
    // the first screen can then already use what was saved.
    if (store().isReady()) return begin();
    return store().ready.then(begin);
  }

  function begin() {
    // a copy saved for somebody else on this phone is not ours to keep
    store().keys('d|').forEach(function (k) { if (k.split('|')[1] !== userId) store().del(k); });
    store().keys('m|').forEach(function (k) { if (k.split('|')[2] !== userId) store().del(k); });
    var saved = store().get(revsKey());
    if (saved) { FleetApi.setRevisions(saved.revs); lastSavedAt = saved.at || 0; }
    var primed = store().get(primedKey());
    if (!store().isPersistent()) return Promise.resolve(); // nowhere to keep a copy between visits: the app just works as it always did
    if (!primed || primed.v !== PRIME_VERSION) {
      running = runPrime('Saving the app\'s data on this device');
      return running.then(function () { running = null; if (again) { again = false; scheduleCheck(); } });
    }
    return quickCheck();
  }

  /** The "Refresh all app data" button. */
  function refreshAll() {
    if (!store() || !FleetAuth.hasSession()) return Promise.resolve();
    if (running) return running;
    if (!userId) userId = (FleetAuth.getUser() || {}).id || '';
    clearTimeout(changeTimer);
    running = runPrime('Refreshing the app\'s data').then(function () {
      running = null;
      try { window.dispatchEvent(new CustomEvent('fleet:data-updated', { detail: { cars: [], fleet: true, all: true } })); } catch (e) { /* nothing is listening */ }
    });
    return running;
  }

  window.addEventListener('fleet:changed', function () { if (userId) scheduleCheck(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && userId && Date.now() - lastCheckAt > RECHECK_AFTER_MS) quickCheck();
  });

  window.FleetSync = {
    start: start,
    refreshAll: refreshAll,
    quickCheck: quickCheck,
    lastSaved: function () { return lastSavedAt; },
    forget: function () { userId = ''; running = null; again = false; clearTimeout(changeTimer); },
    // for tests
    _pool: pool,
  };
})();
