// Thin client for the Apps Script backend.
// Uses POST with Content-Type text/plain so the browser treats it as a "simple"
// request (Apps Script cannot answer CORS pre-flight requests).
(function () {
  'use strict';

  var TIMEOUT_MS = 30000;

  function call(action, params) {
    var cfg = window.FLEET_CONFIG;
    if (!cfg.apiUrl) {
      return Promise.reject(new ApiError('not_configured', 'The backend URL has not been set yet.'));
    }
    var body = JSON.stringify(Object.assign({ action: action }, params || {}));
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    var started = performance.now();

    return fetch(cfg.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
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
        if (err instanceof ApiError) throw err;
        if (err && err.name === 'AbortError') throw new ApiError('timeout', 'The server took too long to respond.');
        throw new ApiError('network', 'Could not reach the server. Check your connection.');
      })
      .finally(function () { clearTimeout(timer); });
  }

  function ApiError(code, message) {
    this.name = 'ApiError';
    this.code = code;
    this.message = message;
  }
  ApiError.prototype = Object.create(Error.prototype);

  window.FleetApi = { call: call, ApiError: ApiError };
})();
