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

  // ---------- the phone's saved copy ----------
  // Screens that only display things (the fleet, a car page, its history, an entry, costs, reminders, documents) read
  // from the copy saved on this phone. A saved copy is "current" when the car it belongs to has not changed since it
  // was saved (FleetSync asks the server which cars changed, see backend/Sync.js) and it was saved today (reminders
  // go overdue as days pass). A current copy is used as it is, with no request at all. A copy that is not current is
  // still shown at once and then replaced by the fresh answer. Only reads are saved, never forms: anything you can
  // edit is always loaded fresh (FleetApi.call), so a saved copy can never be what you edit or what a version check
  // is made against. Saved copies belong to the signed-in person, are cleared on sign-out, and hold no photos.
  var READS = /^(ping$|me$|get|list|guestInfo|guestMe|guestList|guestGet)/;
  // These change nothing that a car screen shows, so they do not make saved copies stale.
  var NO_CHANGE = /^(requestLogin|requestAccount|verifyLink|verifyCode|googleLogin|logout|sendFeedback|guest|aiFillCar|sendMyReminders)/;
  var epoch = 0; // goes up whenever something changes, so an answer that was already on its way is not saved
  var revs = {}; // what this phone believes is the current revision of each car (and of the 'fleet' list)

  function store() { return window.FleetStore || fallbackStore; }
  var fallbackMem = {};
  var fallbackStore = {
    get: function (k) { return fallbackMem[k]; },
    set: function (k, v) { fallbackMem[k] = v; },
    del: function (k) { delete fallbackMem[k]; },
    delPrefix: function (p) { Object.keys(fallbackMem).forEach(function (k) { if (k.indexOf(p) === 0) delete fallbackMem[k]; }); },
  };

  function localDay() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function savedKey(action, params) {
    var user = window.FleetAuth && window.FleetAuth.getUser();
    return user && user.id ? 'd|' + user.id + '|' + action + '|' + JSON.stringify(params || {}) : '';
  }

  /** Which car (or 'fleet') a saved answer belongs to. */
  function scopeOf(action, params, data) {
    params = params || {};
    if (action === 'listCars') return 'fleet';
    if (action === 'getEntry') return data && data.car ? data.car.id : '';
    if (action === 'getCarPage' || action === 'getCar') return params.id || '';
    if (/^(listEntries|getCarCosts|listCarDocuments|listTasks)$/.test(action)) return params.carId || '';
    return '';
  }

  function isCurrent(hit) {
    return !!(hit && hit.rev && revs[hit.scope] === hit.rev && hit.day === localDay());
  }

  function remember(key, action, params, data, rev) {
    var scope = scopeOf(action, params, data);
    store().set(key, { t: Date.now(), data: data, scope: scope, rev: rev || '', day: localDay() });
  }

  /** Put a saved answer straight in (used when a whole car is downloaded at once). */
  function put(action, params, data, scope, rev) {
    var key = savedKey(action, params);
    if (!key) return;
    store().set(key, { t: Date.now(), data: data, scope: scope, rev: rev || '', day: localDay() });
  }

  /** The saved answer for this call, if any (whether or not it is current). */
  function peek(action, params) {
    var key = savedKey(action, params);
    var hit = key ? store().get(key) : null;
    return hit ? hit.data : undefined;
  }

  function setRevisions(map) { revs = Object.assign({}, map || {}); }
  function getRevisions() { return Object.assign({}, revs); }

  /** Everything saved goes (sign-out), including what the phone knows about revisions. */
  function clearSaved() {
    epoch++;
    revs = {};
    store().delPrefix('d|');
    store().delPrefix('m|');
  }

  /** Something was changed: nothing saved can be trusted until the phone has asked which cars changed. */
  function noteChange() {
    epoch++;
    revs = {};
    try { window.dispatchEvent(new CustomEvent('fleet:changed')); } catch (e) { /* no window events: nothing is listening */ }
  }

  /**
   * Like call(), but uses the saved copy when it is current (no request is made), and otherwise first hands onData
   * the saved copy (if any), then the fresh answer (if it differs). The returned promise settles when the answer is
   * in. If the request fails and a saved copy was shown, the error has hadSaved = true so the screen can keep it.
   */
  function cached(action, params, onData) {
    onData = onData || function () {};
    var key = savedKey(action, params);
    var hit = key ? store().get(key) : null;
    if (hit && isCurrent(hit)) {
      onData(hit.data, true);
      return Promise.resolve({ data: hit.data, ms: 0, serverMs: null, cached: true });
    }
    var shown = hit ? JSON.stringify(hit.data) : null;
    var startedAt = epoch;
    var scope = hit && hit.scope ? hit.scope : scopeOf(action, params, null);
    var revAtStart = scope ? revs[scope] : ''; // data read now is at least as new as this revision
    if (hit) onData(hit.data, true);
    return call(action, params).then(function (r) {
      if (key && startedAt === epoch) {
        var rev = revAtStart;
        if (!rev && action === 'getEntry') rev = revs[scopeOf(action, params, r.data)] || '';
        remember(key, action, params, r.data, rev);
      }
      if (shown === null || shown !== JSON.stringify(r.data)) onData(r.data, false);
      return r;
    }).catch(function (e) {
      if (key && (e.code === 'not_found' || e.code === 'unauthorized')) store().del(key);
      e.hadSaved = !!hit;
      throw e;
    });
  }

  // The name used by screens that show the saved copy first.
  function seen(action, params, onData) { return cached(action, params, onData); }

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
        if (!READS.test(action) && !NO_CHANGE.test(action) && !opts.guestCarId) noteChange(); // something was changed: saved copies may be out of date
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

  window.FleetApi = {
    call: call, callGuest: callGuest, seen: seen, cached: cached, put: put, peek: peek, clearSaved: clearSaved,
    setRevisions: setRevisions, getRevisions: getRevisions, isCurrent: isCurrent, ApiError: ApiError,
  };
})();
