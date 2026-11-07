/**
 * Authentication: account requests, magic link + 6-digit code, Google sign-in, sessions.
 *
 * Security rules implemented here:
 *  - tokens, codes and session tokens are stored only as salted hashes
 *  - login links/codes expire after LOGIN_MINUTES and are single use
 *  - requests for unknown or unapproved emails get the same response as approved ones
 *  - per-email rate limits and global daily caps protect inboxes and the email quota
 *  - 5 wrong codes burn all open codes for that user
 */

// ---------- users ----------

function publicUser_(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

function findUserByEmail_(email) {
  return Db.all('Users').filter(function (u) {
    return !isTrue_(u.deleted) && u.email.toLowerCase() === email;
  })[0] || null;
}

function findUserById_(id) {
  return Db.all('Users').filter(function (u) {
    return !isTrue_(u.deleted) && u.id === id;
  })[0] || null;
}

/** Cached lookup used on every authenticated request. */
function getUserCached_(id) {
  const key = 'user:' + id;
  const hit = cacheGetJson_(key);
  if (hit) return hit;
  const u = findUserById_(id);
  if (!u) return null;
  const slim = { id: u.id, name: u.name, email: u.email, role: u.role, status: u.status };
  cachePutJson_(key, slim, 300);
  return slim;
}

function patchUser_(user, patch, actor) {
  const merged = Object.assign({}, patch, {
    updated_at: nowIso_(),
    updated_by: actor && actor.id ? actor.id : 'system',
    version: Number(user.version || 1) + 1,
  });
  Db.update('Users', user._row, merged);
  cacheRemove_('user:' + user.id);
}

function activeAdmins_() {
  return Db.all('Users').filter(function (u) {
    return !isTrue_(u.deleted) && u.status === 'Approved' && u.role === 'admin';
  });
}

// ---------- tokens / sessions ----------

function burnOpenTokens_(userId) {
  const now = nowIso_();
  Db.all('Tokens').forEach(function (t) {
    if (t.user_id === userId && !t.used_at) Db.update('Tokens', t._row, { used_at: now });
  });
}

function createLoginTokens_(user) {
  // Tidy rows that expired more than a day ago, then burn any older open links for this user.
  const cutoff = Date.now() - 24 * 3600 * 1000;
  Db.prune('Tokens', function (t) { return Date.parse(t.expires_at) < cutoff; });
  burnOpenTokens_(user.id);

  const linkToken = randomToken_();
  const code = randomCode_();
  const expires = isoIn_(LOGIN_MINUTES * 60 * 1000);
  Db.insert('Tokens', { hash: hash_(linkToken), type: 'login_link', user_id: user.id, expires_at: expires, attempts: 0 });
  Db.insert('Tokens', { hash: hash_(user.id + ':' + code), type: 'login_code', user_id: user.id, expires_at: expires, attempts: 0 });
  return { link: SITE_URL + '#/login/verify?t=' + linkToken, code: code };
}

function signIn_(user, method) {
  const token = randomToken_();
  const now = nowIso_();
  const expiresAt = isoIn_(SESSION_DAYS * 24 * 3600 * 1000);
  Db.insert('Sessions', {
    hash: hash_(token), user_id: user.id, created_at: now, last_seen: now, expires_at: expiresAt, revoked: false,
  });
  patchUser_(user, { last_login: now }, null);
  audit_(user, 'login', 'User', user.id, 'Signed in via ' + method);
  return { session: { token: token, expiresAt: expiresAt }, user: publicUser_(user) };
}

/** Resolve a session token to a user, or null. Result is cached briefly. */
function authenticate_(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const h = hash_(token);
  const key = 'sess:' + h;
  let sess = cacheGetJson_(key);
  if (!sess) {
    const row = Db.all('Sessions').filter(function (s) { return s.hash === h; })[0];
    if (!row || isTrue_(row.revoked)) return null;
    sess = { userId: row.user_id, exp: row.expires_at };
    cachePutJson_(key, sess, 600);
  }
  if (Date.parse(sess.exp) < Date.now()) return null;
  const user = getUserCached_(sess.userId);
  if (!user || user.status !== 'Approved') return null;
  return { user: user, sessionHash: h, expiresAt: sess.exp };
}

function revokeSessions_(userId) {
  Db.all('Sessions').forEach(function (s) {
    if (s.user_id === userId && !isTrue_(s.revoked)) {
      Db.update('Sessions', s._row, { revoked: true });
      cacheRemove_('sess:' + s.hash);
    }
  });
}

// ---------- public actions ----------

/** Anyone can ask for an account. The response never reveals whether the email is known. */
function requestAccount_(p) {
  const generic = { received: true };
  if (p.website) return generic; // honeypot field: real people never fill it in
  const name = cleanStr_(p.name, 80);
  const email = normEmail_(p.email);
  if (!name) fail_('invalid_name');
  if (!email) fail_('invalid_email');
  if (!rateLimit_('request:' + hash_(email), 2, 3600)) return generic;

  const existing = findUserByEmail_(email);
  if (existing) {
    // Already approved: behave like a normal login request. Otherwise do nothing.
    if (existing.status === 'Approved') requestLogin_({ email: email });
    return generic; // same reply as for a brand-new request
  }
  if (!dailyCap_('account_requests', 10)) fail_('try_later');

  const now = nowIso_();
  const user = {
    id: Utilities.getUuid(), created_at: now, created_by: 'self', updated_at: now, updated_by: 'self', version: 1,
    deleted: false, name: name, email: email, status: 'Pending', role: 'user', requested_at: now,
  };
  Db.insert('Users', user);
  audit_({ id: user.id, email: email }, 'account_requested', 'User', user.id, 'Account requested by ' + name);

  const admins = activeAdmins_().map(function (a) { return a.email; });
  if (admins.length) sendAdminRequestEmail_(admins, user, SITE_URL + '#/admin/users?focus=' + user.id);
  return generic;
}

function requestLogin_(p) {
  const email = normEmail_(p.email);
  if (!email) fail_('invalid_email');
  const generic = { sent: true };
  if (!rateLimit_('login:' + hash_(email), 5, 3600)) return generic;

  const user = findUserByEmail_(email);
  if (!user || user.status !== 'Approved') {
    sleep_(1200); // roughly match the time an approved request takes
    return generic;
  }
  if (!dailyCap_('login_emails', 50)) {
    audit_(user, 'login_email_capped', 'User', user.id, 'Daily login email cap reached');
    return generic;
  }
  const t = createLoginTokens_(user);
  sendLoginEmail_(user, t.link, t.code);
  audit_(user, 'login_requested', 'User', user.id, 'Sign-in link requested');
  return generic;
}

function verifyLink_(p) {
  const token = cleanStr_(p.token, 200);
  if (!token) fail_('invalid_or_expired');
  const h = hash_(token);
  const row = Db.all('Tokens').filter(function (t) { return t.type === 'login_link' && t.hash === h; })[0];
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) fail_('invalid_or_expired');
  const user = findUserById_(row.user_id);
  if (!user || user.status !== 'Approved') fail_('invalid_or_expired');
  burnOpenTokens_(user.id);
  return signIn_(user, 'email link');
}

function verifyCode_(p) {
  const email = normEmail_(p.email);
  const code = String(p.code || '').replace(/\D/g, '');
  if (!email || code.length !== 6) fail_('invalid_or_expired');

  const cache = CacheService.getScriptCache();
  const failKey = 'codefail:' + hash_(email);
  const fails = Number(cache.get(failKey) || 0);
  const user = findUserByEmail_(email);

  if (fails >= MAX_CODE_FAILS) {
    if (user) burnOpenTokens_(user.id);
    fail_('too_many_attempts');
  }

  let ok = false;
  if (user && user.status === 'Approved') {
    const h = hash_(user.id + ':' + code);
    const row = Db.all('Tokens').filter(function (t) { return t.type === 'login_code' && t.hash === h; })[0];
    ok = !!row && !row.used_at && Date.parse(row.expires_at) >= Date.now();
  }
  if (!ok) {
    cache.put(failKey, String(fails + 1), 900);
    sleep_(400);
    fail_('invalid_or_expired');
  }
  cache.remove(failKey);
  burnOpenTokens_(user.id);
  return signIn_(user, 'email code');
}

/** Sign in with Google: verify the ID token with Google, then require an approved user. */
function googleLogin_(p) {
  const clientId = props_().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) fail_('google_not_configured');
  const credential = cleanStr_(p.credential, 4096);
  if (!credential) fail_('invalid_google_token');

  let info;
  try {
    const res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) fail_('invalid_google_token');
    info = JSON.parse(res.getContentText());
  } catch (e) {
    if (e && e.apiError) throw e;
    fail_('invalid_google_token');
  }
  const issuerOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  const verified = info.email_verified === true || info.email_verified === 'true';
  if (info.aud !== clientId || !issuerOk || !verified || Number(info.exp) * 1000 < Date.now()) {
    fail_('invalid_google_token');
  }
  const email = normEmail_(info.email);
  const user = email ? findUserByEmail_(email) : null;
  if (!user || user.status !== 'Approved') fail_('not_approved');
  return signIn_(user, 'Google');
}

// ---------- authenticated actions ----------

function me_(p, ctx) {
  return { user: publicUser_(ctx.user), sessionExpiresAt: ctx.expiresAt };
}

function logout_(p, ctx) {
  const row = Db.all('Sessions').filter(function (s) { return s.hash === ctx.sessionHash; })[0];
  if (row) Db.update('Sessions', row._row, { revoked: true });
  cacheRemove_('sess:' + ctx.sessionHash);
  audit_(ctx.user, 'logout', 'User', ctx.user.id, 'Signed out');
  return { done: true };
}
