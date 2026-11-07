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

  function call(action, params) {
    var cfg = window.FLEET_CONFIG;
    if (!cfg.apiUrl) {
      return Promise.reject(new ApiError('not_configured', 'The backend URL has not been set yet.'));
    }
    var payload = Object.assign({ action: action }, params || {});
    var token = window.FleetAuth && window.FleetAuth.token();
    if (token) payload.token = token;

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
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
        return { data: json.data, ms: ms };
      })
      .catch(function (err) {
        var e = err;
        if (!(err instanceof ApiError)) {
          e = err && err.name === 'AbortError'
            ? new ApiError('timeout', 'The server took too long to respond.')
            : new ApiError('network', 'Could not reach the server.');
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

  window.FleetApi = { call: call, ApiError: ApiError };
})();
