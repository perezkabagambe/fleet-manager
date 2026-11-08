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
    getCarPage: { auth: 'user', fn: getCarPage_ },
    saveCar: { auth: 'user', lock: true, fn: saveCar_ },
    updateOdometer: { auth: 'user', lock: true, fn: updateOdometer_ },
    deleteCar: { auth: 'admin', lock: true, fn: deleteCar_ },
    restoreCar: { auth: 'admin', lock: true, fn: restoreCar_ },
    saveFluids: { auth: 'user', lock: true, fn: saveFluids_ },
    listTasks: { auth: 'user', fn: listTasks_ },
    saveTask: { auth: 'user', lock: true, fn: saveTask_ },
    deleteTask: { auth: 'admin', lock: true, fn: deleteTask_ },
    addStandardTasks: { auth: 'user', lock: true, fn: addStandardTasks_ },
    listApprovedUsers: { auth: 'user', fn: listApprovedUsers_ },
    sendMyReminders: { auth: 'user', fn: sendMyReminders_ },
    setGuestAccess: { auth: 'admin', lock: true, fn: setGuestAccess_ },
    replaceGuestSecret: { auth: 'admin', lock: true, fn: replaceGuestSecret_ },
    listGuests: { auth: 'admin', fn: listGuests_ },
    setGuestBlocked: { auth: 'admin', lock: true, fn: setGuestBlocked_ },
    sendFeedback: { auth: 'user', fn: sendFeedback_ },
    guestSendFeedback: { auth: 'guest', fn: guestSendFeedback_ },
    guestInfo: { auth: 'none', fn: guestInfo_ },
    guestJoin: { auth: 'none', lock: true, fn: guestJoin_ },
    guestMe: { auth: 'guest', fn: guestMe_ },
    guestListEntries: { auth: 'guest', fn: guestListEntries_ },
    guestSaveEntry: { auth: 'guest', lock: true, fn: guestSaveEntry_ },
    guestDeleteEntry: { auth: 'guest', lock: true, fn: guestDeleteEntry_ },
    guestUploadAttachment: { auth: 'guest', lock: true, fn: guestUploadAttachment_ },
    guestGetAttachment: { auth: 'guest', fn: guestGetAttachment_ },
    guestListAttachments: { auth: 'guest', fn: guestListAttachments_ },
    listEntries: { auth: 'user', fn: listEntries_ },
    getEntry: { auth: 'user', fn: getEntry_ },
    listPurchases: { auth: 'user', fn: listPurchases_ },
    saveEntry: { auth: 'user', lock: true, fn: saveEntry_ },
    setIssueStatus: { auth: 'user', lock: true, fn: setIssueStatus_ },
    deleteEntry: { auth: 'admin', lock: true, fn: deleteEntry_ },
    getCarCosts: { auth: 'user', fn: getCarCosts_ },
    uploadAttachment: { auth: 'user', lock: true, fn: uploadAttachment_ },
    getAttachment: { auth: 'user', fn: getAttachment_ },
    deleteAttachment: { auth: 'admin', lock: true, fn: deleteAttachment_ },
    getUserCars: { auth: 'user', fn: getUserCars_ },
    saveUserCars: { auth: 'user', lock: true, fn: saveUserCars_ },
    setMyCarRole: { auth: 'user', lock: true, fn: setMyCarRole_ },
    setCarPeople: { auth: 'admin', lock: true, fn: setCarPeople_ },
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
  const started = Date.now();
  Db.resetRequest();
  try {
    const actions = actions_();
    const def = req && typeof req.action === 'string' && Object.prototype.hasOwnProperty.call(actions, req.action)
      ? actions[req.action] : null;
    if (!def) return json_({ ok: false, error: 'unknown_action' });
    if (req.action !== 'ping') migrateIfNeeded_();

    const ctx = {};
    if (def.auth === 'guest') {
      // Guests have their own token; a signed-in user's token is never accepted here, nor a guest's anywhere else.
      const g = authenticateGuest_(req.guestToken);
      if (!g) return json_({ ok: false, error: 'guest_unauthorized' });
      ctx.guest = g;
      ctx.user = guestUser_(g);
    } else if (def.auth !== 'none') {
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
    const data = def.fn(req, ctx);
    const out = { ok: true, data: data };
    // Server time is shown in Diagnostics. It is left out of the sign-in style (public) actions on purpose: those
    // are made to take the same time and give the same reply whether or not an email is known.
    if (def.auth !== 'none' || req.action === 'ping') out.ms = Date.now() - started;
    return json_(out);
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
