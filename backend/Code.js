/**
 * Fleet Manager backend (Google Apps Script web app).
 *
 * Entry points: doGet / doPost. The browser app sends JSON as text/plain POST
 * (a "simple" request, so no CORS pre-flight is needed).
 *
 * Request:  { "action": "...", ...params, "token": "<session token>" }
 * Response: { "ok": true, "data": ... } or { "ok": false, "error": "<code>" }
 *
 * Every action except the public ones verifies the session token on the
 * server. The front end is never trusted.
 */

// Bump when the request/response contract changes in a way the front end must know about.
const API_VERSION = 1;

// auth: 'none' (public), 'user' (any approved user) or 'admin'.
// lock: true serialises the action with LockService so sheet writes never interleave.
// Built on demand: top-level code in one Apps Script file cannot rely on functions
// declared in other files having been loaded yet.
function actions_() {
  return {
    ping: { auth: 'none', fn: ping_ },
    requestAccount: { auth: 'none', lock: true, fn: requestAccount_ },
    requestLogin: { auth: 'none', lock: true, fn: requestLogin_ },
    verifyLink: { auth: 'none', lock: true, fn: verifyLink_ },
    verifyCode: { auth: 'none', lock: true, fn: verifyCode_ },
    googleLogin: { auth: 'none', lock: true, fn: googleLogin_ },
    me: { auth: 'user', fn: me_ },
    logout: { auth: 'user', lock: true, fn: logout_ },
    listUsers: { auth: 'admin', fn: listUsers_ },
    setUserStatus: { auth: 'admin', lock: true, fn: setUserStatus_ },
    setUserRole: { auth: 'admin', lock: true, fn: setUserRole_ },
    updateMyName: { auth: 'user', lock: true, fn: updateMyName_ },
    listCars: { auth: 'user', fn: listCars_ },
    getCar: { auth: 'user', fn: getCar_ },
    saveCar: { auth: 'user', lock: true, fn: saveCar_ },
    updateOdometer: { auth: 'user', lock: true, fn: updateOdometer_ },
    deleteCar: { auth: 'admin', lock: true, fn: deleteCar_ },
    restoreCar: { auth: 'admin', lock: true, fn: restoreCar_ },
    saveFluids: { auth: 'user', lock: true, fn: saveFluids_ },
    uploadCarPhoto: { auth: 'user', lock: true, fn: uploadCarPhoto_ },
    removeCarPhoto: { auth: 'user', lock: true, fn: removeCarPhoto_ },
    getPhoto: { auth: 'user', fn: getPhoto_ },
  };
}

/** GET is limited to the harmless ping, so nothing sensitive ever appears in a URL. */
function doGet() {
  return handle_({ action: 'ping' });
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
  let lock = null;
  try {
    const actions = actions_();
    const def = req && typeof req.action === 'string' && Object.prototype.hasOwnProperty.call(actions, req.action)
      ? actions[req.action] : null;
    if (!def) return json_({ ok: false, error: 'unknown_action' });
    if (req.action !== 'ping') migrateIfNeeded_();

    const ctx = {};
    if (def.auth !== 'none') {
      const a = authenticate_(req.token);
      if (!a) return json_({ ok: false, error: 'unauthorized' });
      if (def.auth === 'admin' && a.user.role !== 'admin') return json_({ ok: false, error: 'forbidden' });
      ctx.user = a.user;
      ctx.sessionHash = a.sessionHash;
      ctx.expiresAt = a.expiresAt;
    }

    if (def.lock) {
      lock = LockService.getScriptLock();
      try {
        lock.waitLock(25000);
      } catch (e) {
        lock = null;
        return json_({ ok: false, error: 'busy' });
      }
    }
    return json_({ ok: true, data: def.fn(req, ctx) });
  } catch (err) {
    if (err && err.apiError) return json_({ ok: false, error: err.apiError });
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'server_error' });
  } finally {
    if (lock) lock.releaseLock();
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
