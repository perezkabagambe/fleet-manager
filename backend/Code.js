/**
 * Fleet Manager backend (Google Apps Script web app).
 *
 * Entry points: doGet / doPost. The browser app sends JSON as text/plain POST
 * (a "simple" request, so no CORS pre-flight is needed).
 *
 * Request:  { "action": "ping", ...params, "token": "<session token>" }
 * Response: { "ok": true, "data": ... } or { "ok": false, "error": "<code>" }
 *
 * Every action except the public ones must verify the session token on the
 * server. The front end is never trusted.
 */

// Bump when the request/response contract changes in a way the front end must know about.
const API_VERSION = 1;

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'ping';
  return handle_({ action: action });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
  return handle_(req);
}

function handle_(req) {
  try {
    switch (req && req.action) {
      case 'ping':
        return json_({ ok: true, data: ping_() });
      default:
        return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'server_error' });
  }
}

/** Public, harmless: lets the app compare versions and measure round-trip time. */
function ping_() {
  return {
    apiVersion: API_VERSION,
    backendRev: BACKEND_REV,
    serverTime: new Date().toISOString(),
  };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
