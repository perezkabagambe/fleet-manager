// Thin client for the Apps Script backend.
// Uses POST with Content-Type text/plain so the browser treats it as a "simple"
// request (Apps Script cannot answer CORS pre-flight requests).
// The session token is attached automatically.
(function () {
  'use strict';

  var TIMEOUT_MS = 30000;

  function ApiError(code, message) {
    this.name = 'ApiError';
    this.code = code;
    this.message = message;
  }
  ApiError.prototype = Object.create(Error.prototype);

  // ---------- showing what was seen last time, instantly ----------
  // Screens that only display things (the fleet, a car page) show the copy saved on this phone straight away,
  // then replace it with the fresh answer when it arrives. Only reads are saved, never forms: anything you can edit
  // is always loaded fresh, so a saved copy can never be what you edit or what a version check is made against.
  // Saved copies belong to the signed-in person, are cleared on sign-out and after any change, and hold no photos.
  var READS = /^(ping$|me$|get|list|guestInfo|guestMe|guestList|guestGet)/;
  var SAVED_KEY = 'fleet.saved.v1';
  var MAX_SAVED = 24;
  var MAX_SAVED_CHARS = 1500000;
  var saved = null; // { key: { t: time, data: ... } }
  var epoch = 0; // goes up whenever everything is cleared, so an answer that was already on its way is not saved after a change

  function loadSaved() {
    if (saved) return saved;
    saved = {};
    try {
      var raw = localStorage.getItem(SAVED_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') saved = parsed;
    } catch (e) { saved = {}; }
    return saved;
  }

  function persistSaved() {
    try {
      var keys = Object.keys(saved).sort(function (a, b) { return saved[b].t - saved[a].t; });
      while (keys.length > MAX_SAVED) delete saved[keys.pop()];
      var json = JSON.stringify(saved);
      while (json.length > MAX_SAVED_CHARS && keys.length) { delete saved[keys.pop()]; json = JSON.stringify(saved); }
      localStorage.setItem(SAVED_KEY, json);
    } catch (e) { /* storage full or blocked: it is only a speed-up */ }
  }

  function savedKey(action, params) {
    var user = window.FleetAuth && window.FleetAuth.getUser();
    return user && user.id ? user.id + '|' + action + '|' + JSON.stringify(params || {}) : '';
  }

  function clearSaved() {
    epoch++;
    saved = {};
    try { localStorage.removeItem(SAVED_KEY); } catch (e) { /* ignore */ }
  }

  /**
   * Like call(), but first hands onData the copy saved last time (if any), then the fresh answer (if it differs).
   * The returned promise settles when the fresh answer is in. If it fails and a saved copy was shown, the error
   * has hadSaved = true so the screen can keep what it is showing.
   */
  function seen(action, params, onData) {
    var key = savedKey(action, params);
    var hit = key ? loadSaved()[key] : null;
    var shown = hit ? JSON.stringify(hit.data) : null;
    var startedAt = epoch;
    if (hit) onData(hit.data, true);
    return call(action, params).then(function (r) {
      if (key && startedAt === epoch) {
        loadSaved()[key] = { t: Date.now(), data: r.data };
        persistSaved();
      }
      if (shown === null || shown !== JSON.stringify(r.data)) onData(r.data, false);
      return r;
    }).catch(function (e) {
      if (key && (e.code === 'not_found' || e.code === 'unauthorized')) { delete loadSaved()[key]; persistSaved(); }
      e.hadSaved = !!hit;
      throw e;
    });
  }

  // opts.guestCarId: act as a guest on that car (the guest token is sent instead of any user session).
  // opts.timeoutMs: how long to wait (the default suits normal requests; a big file upload is given longer).
  function call(action, params, opts) {
    opts = opts || {};
    var cfg = window.FLEET_CONFIG;
    if (!cfg.apiUrl) {
      return Promise.reject(new ApiError('not_configured', 'The backend URL has not been set yet.'));
    }
    var payload = Object.assign({ action: action }, params || {});
    var guest = opts.guestCarId ? window.FleetGuest.get(opts.guestCarId) : null;
    var token = guest ? '' : window.FleetAuth && window.FleetAuth.token();
    if (guest) payload.guestToken = guest.token;
    else if (token) payload.token = token;

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, opts.timeoutMs || TIMEOUT_MS);
    var started = performance.now();

    return fetch(cfg.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      credentials: 'omit',
      signal: controller.signal,
    })
      .then(function (res) {
        if (!res.ok) throw new ApiError('http_' + res.status, 'The server returned an error (' + res.status + ').');
        return res.json();
      })
      .then(function (json) {
        var ms = Math.round(performance.now() - started);
        if (!json.ok) throw new ApiError(json.error || 'server_error', 'Request failed: ' + (json.error || 'server_error'));
        if (!READS.test(action)) clearSaved(); // something was changed: anything remembered may now be out of date
        return { data: json.data, ms: ms, serverMs: typeof json.ms === 'number' ? json.ms : null };
      })
      .catch(function (err) {
        var e = err;
        if (!(err instanceof ApiError)) {
          e = err && err.name === 'AbortError'
            ? new ApiError('timeout', 'The server took too long to respond.')
            : new ApiError('network', 'Could not reach the server.');
        }
        if (opts.guestCarId && (e.code === 'guest_unauthorized' || e.code === 'guest_disabled')) {
          // The guest session ended, was blocked, or guest access was switched off for this car.
          window.FleetGuest.clear(opts.guestCarId);
          window.dispatchEvent(new CustomEvent('fleet:guest-ended', { detail: { carId: opts.guestCarId, code: e.code } }));
        }
        if (e.code === 'unauthorized' && token) {
          // The server no longer accepts this session (expired, revoked or signed out elsewhere).
          window.FleetAuth.clear();
          window.dispatchEvent(new Event('fleet:unauthorized'));
        }
        throw e;
      })
      .finally(function () { clearTimeout(timer); });
  }

  /** A call made as a guest on one car. */
  function callGuest(carId, action, params) { return call(action, params, { guestCarId: carId }); }

  window.FleetApi = { call: call, callGuest: callGuest, seen: seen, clearSaved: clearSaved, ApiError: ApiError };
})();
