// The phone's own copy of the app's data, kept in IndexedDB (the browser's database) so it can hold the whole fleet:
// localStorage is far too small for that. Everything is also kept in memory, so reading is instant and synchronous;
// writes go to the database in the background. If the browser will not give us a database (private browsing, an old
// browser), the copy lives in memory only: the app then works exactly as before, and `persistent` is false.
//
// Keys are plain strings, grouped by a prefix: 'd|' saved answers, 't|' small attachment pictures, 'm|' bookkeeping.
(function () {
  'use strict';

  var mem = {};
  var backend = null;
  var persistent = false;
  var loaded = null;
  var isReady = false;

  /** The real backend: one IndexedDB object store of key -> value. */
  function idbBackend() {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        var req = window.indexedDB.open('fleet-manager', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        req.onblocked = function () { reject(new Error('blocked')); };
      });
      return dbp;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction('kv', mode);
          var out = fn(t.objectStore('kv'));
          t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : undefined); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error || new Error('aborted')); };
        });
      });
    }
    return {
      loadAll: function () {
        return open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var rows = [];
            var req = db.transaction('kv', 'readonly').objectStore('kv').openCursor();
            req.onsuccess = function () {
              var c = req.result;
              if (c) { rows.push([c.key, c.value]); c.continue(); } else resolve(rows);
            };
            req.onerror = function () { reject(req.error); };
          });
        });
      },
      put: function (k, v) { return tx('readwrite', function (s) { s.put(v, k); }); },
      remove: function (k) { return tx('readwrite', function (s) { s.delete(k); }); },
      clear: function () { return tx('readwrite', function (s) { s.clear(); }); },
    };
  }

  /** Writes are queued so they happen in order, and a failure (full disk, blocked) never breaks the app. */
  var queue = Promise.resolve();
  function later(fn) {
    if (!backend) return;
    queue = queue.then(fn).catch(function () { /* only a speed-up: keep going from memory */ });
  }

  function load(b, timeoutMs) {
    backend = b;
    isReady = false;
    var timer;
    var timeout = new Promise(function (resolve) { timer = setTimeout(resolve, timeoutMs === undefined ? 3000 : timeoutMs); });
    loaded = Promise.race([
      b.loadAll().then(function (rows) {
        rows.forEach(function (r) { if (!(r[0] in mem)) mem[r[0]] = r[1]; });
        persistent = true;
      }),
      timeout,
    ]).catch(function () { backend = null; persistent = false; }).then(function () { clearTimeout(timer); isReady = true; });
    return loaded;
  }

  function get(key) { return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : undefined; }
  function set(key, value) { mem[key] = value; later(function () { return backend.put(key, value); }); }
  function del(key) {
    if (!(key in mem)) return;
    delete mem[key];
    later(function () { return backend.remove(key); });
  }
  function keys(prefix) { return Object.keys(mem).filter(function (k) { return k.indexOf(prefix) === 0; }); }
  function delPrefix(prefix) { keys(prefix).forEach(del); }
  function clear() { mem = {}; later(function () { return backend.clear(); }); }

  var api = {
    get: get, set: set, del: del, keys: keys, delPrefix: delPrefix, clear: clear,
    isPersistent: function () { return persistent; },
    isReady: function () { return isReady; }, // true once the saved copy has been read (the app waits for this before drawing anything)
    // For tests: use a different backend (an object with loadAll, put, remove and clear).
    useBackend: function (b, timeoutMs) { mem = {}; return load(b, timeoutMs); },
    ready: null,
  };

  if (typeof window !== 'undefined' && window.indexedDB) {
    try { api.ready = load(idbBackend()); } catch (e) { api.ready = Promise.resolve(); isReady = true; }
  } else {
    api.ready = Promise.resolve();
    isReady = true;
  }
  window.FleetStore = api;
})();
