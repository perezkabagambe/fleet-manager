'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const MIN = 60 * 1000;

function setup() {
  const env = createEnv();
  const admin = env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  const user = env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  return { env, admin, user };
}

test('ping is public and returns versions', () => {
  const { env } = setup();
  const r = env.call('ping');
  assert.equal(r.ok, true);
  assert.equal(r.data.apiVersion, 1);
});

test('unknown action and malformed input are rejected', () => {
  const { env } = setup();
  assert.equal(env.call('nope').error, 'unknown_action');
  assert.equal(env.call('constructor').error, 'unknown_action');
  const res = env.ctx.doPost({ postData: { contents: '{not json' } });
  assert.equal(JSON.parse(res.getContent()).error, 'bad_request');
});

test('protected actions need a valid session', () => {
  const { env } = setup();
  assert.equal(env.call('me').error, 'unauthorized');
  assert.equal(env.call('me', { token: 'x'.repeat(64) }).error, 'unauthorized');
  assert.equal(env.call('listUsers').error, 'unauthorized');
});

// ---------- magic link ----------

test('magic link signs in once, then is burned', () => {
  const { env } = setup();
  assert.deepEqual(env.call('requestLogin', { email: 'sam@example.com' }).data, { sent: true });
  const l = env.lastLoginMail('sam@example.com');
  assert.ok(l, 'email sent');
  const ok = env.call('verifyLink', { token: l.token });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.user.email, 'sam@example.com');
  assert.equal(env.call('me', { token: ok.data.session.token }).data.user.name, 'Sam');
  // reuse fails
  assert.equal(env.call('verifyLink', { token: l.token }).error, 'invalid_or_expired');
  // and the code from the same email is burned too
  assert.equal(env.call('verifyCode', { email: 'sam@example.com', code: l.code }).error, 'invalid_or_expired');
});

test('magic link expires after 15 minutes', () => {
  const { env } = setup();
  env.call('requestLogin', { email: 'sam@example.com' });
  const l = env.lastLoginMail('sam@example.com');
  env.advance(16 * MIN);
  assert.equal(env.call('verifyLink', { token: l.token }).error, 'invalid_or_expired');
});

test('a new login request burns the previous link', () => {
  const { env } = setup();
  env.call('requestLogin', { email: 'sam@example.com' });
  const first = env.lastLoginMail('sam@example.com');
  env.call('requestLogin', { email: 'sam@example.com' });
  assert.equal(env.call('verifyLink', { token: first.token }).error, 'invalid_or_expired');
  const second = env.lastLoginMail('sam@example.com');
  assert.equal(env.call('verifyLink', { token: second.token }).ok, true);
});

test('tokens are stored hashed, never in plain text', () => {
  const { env } = setup();
  env.call('requestLogin', { email: 'sam@example.com' });
  const l = env.lastLoginMail('sam@example.com');
  const dump = JSON.stringify(env.sheets.Tokens._rows);
  assert.ok(!dump.includes(l.token));
  assert.ok(!dump.includes(l.code));
});

test('an unknown address is told it is new, and no email is sent to it', () => {
  const { env } = setup();
  const known = env.call('requestLogin', { email: 'sam@example.com' });
  assert.deepEqual(known.data, { sent: true });
  const before = env.outbox.length;
  const unknown = env.call('requestLogin', { email: 'stranger@example.com' });
  assert.equal(unknown.ok, true);
  assert.deepEqual(unknown.data, { sent: false, newUser: true });
  assert.equal(env.outbox.length, before, 'no email to unknown address');
});

test('a person whose request is still pending is told so, with no email', () => {
  const { env } = setup();
  env.seedUser({ email: 'waiting@example.com', status: 'Pending' });
  const before = env.outbox.length;
  assert.deepEqual(env.call('requestLogin', { email: 'waiting@example.com' }).data, { sent: false, pending: true });
  assert.equal(env.outbox.length, before);
});

test('rejected and revoked people get the plain answer, as before, and no email', () => {
  const { env } = setup();
  ['Rejected', 'Revoked'].forEach((status, i) => {
    const email = 'gone' + i + '@example.com';
    env.seedUser({ email, status });
    const before = env.outbox.length;
    assert.deepEqual(env.call('requestLogin', { email }).data, { sent: true });
    assert.equal(env.outbox.length, before);
  });
  assert.ok(env.sleeps.length > 0, 'padded with a delay');
});

test('telling new addresses apart has a daily limit, so it cannot list who has an account', () => {
  const { env } = setup();
  for (let i = 0; i < 100; i++) assert.equal(env.call('requestLogin', { email: 'probe' + i + '@example.com' }).data.newUser, true, 'probe ' + i);
  const over = env.call('requestLogin', { email: 'probe-over@example.com' });
  assert.deepEqual(over.data, { sent: true }, 'after the limit it looks like any other address');
  env.seedUser({ email: 'late@example.com', status: 'Pending' });
  assert.deepEqual(env.call('requestLogin', { email: 'late@example.com' }).data, { sent: true }, 'pending is hidden too once the limit is used');
  assert.deepEqual(env.call('requestLogin', { email: 'sam@example.com' }).data, { sent: true });
  assert.ok(env.lastLoginMail('sam@example.com'), 'approved people can still sign in');
});

test('pending, rejected and revoked users cannot sign in', () => {
  const { env } = setup();
  ['Pending', 'Rejected', 'Revoked'].forEach((status, i) => {
    const email = 'u' + i + '@example.com';
    env.seedUser({ email, status });
    const before = env.outbox.length;
    assert.equal(env.call('requestLogin', { email }).ok, true);
    assert.equal(env.outbox.length, before);
  });
});

test('invalid email format is rejected', () => {
  const { env } = setup();
  assert.equal(env.call('requestLogin', { email: 'nope' }).error, 'invalid_email');
  assert.equal(env.call('requestLogin', { email: 'a@b' }).error, 'invalid_email');
});

test('login emails are rate limited per address (silently)', () => {
  const { env } = setup();
  for (let i = 0; i < 8; i++) assert.equal(env.call('requestLogin', { email: 'sam@example.com' }).ok, true);
  const sent = env.outbox.filter((m) => m.to === 'sam@example.com').length;
  assert.equal(sent, 5);
});

// ---------- code ----------

test('6-digit code signs in', () => {
  const { env } = setup();
  env.call('requestLogin', { email: 'sam@example.com' });
  const l = env.lastLoginMail('sam@example.com');
  const r = env.call('verifyCode', { email: 'Sam@Example.com', code: l.code });
  assert.equal(r.ok, true);
  assert.equal(env.call('verifyLink', { token: l.token }).error, 'invalid_or_expired', 'link burned by code use');
});

test('5 wrong codes burn the open code, even the correct one', () => {
  const { env } = setup();
  env.call('requestLogin', { email: 'sam@example.com' });
  const l = env.lastLoginMail('sam@example.com');
  const wrong = l.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal(env.call('verifyCode', { email: 'sam@example.com', code: wrong }).error, 'invalid_or_expired');
  assert.equal(env.call('verifyCode', { email: 'sam@example.com', code: l.code }).error, 'too_many_attempts');
  assert.equal(env.call('verifyLink', { token: l.token }).error, 'invalid_or_expired', 'link burned too');
});

test('code attempts for unknown emails look the same', () => {
  const { env } = setup();
  assert.equal(env.call('verifyCode', { email: 'ghost@example.com', code: '123456' }).error, 'invalid_or_expired');
});

test('code expires after 15 minutes', () => {
  const { env } = setup();
  env.call('requestLogin', { email: 'sam@example.com' });
  const l = env.lastLoginMail('sam@example.com');
  env.advance(16 * MIN);
  assert.equal(env.call('verifyCode', { email: 'sam@example.com', code: l.code }).error, 'invalid_or_expired');
});

// ---------- sessions ----------

test('session lasts 30 days, then expires', () => {
  const { env } = setup();
  const token = env.signInAs('sam@example.com');
  env.advance(29 * 24 * 60 * MIN);
  assert.equal(env.call('me', { token }).ok, true);
  env.advance(2 * 24 * 60 * MIN);
  assert.equal(env.call('me', { token }).error, 'unauthorized');
});

test('logout ends the session immediately', () => {
  const { env } = setup();
  const token = env.signInAs('sam@example.com');
  assert.equal(env.call('logout', { token }).ok, true);
  assert.equal(env.call('me', { token }).error, 'unauthorized');
});

test('sessions are stored hashed', () => {
  const { env } = setup();
  const token = env.signInAs('sam@example.com');
  assert.ok(!JSON.stringify(env.sheets.Sessions._rows).includes(token));
});

// ---------- account requests + approval ----------

test('requesting an account creates a Pending user and emails every admin', () => {
  const { env } = setup();
  env.seedUser({ email: 'admin2@example.com', role: 'admin', name: 'Admin Two' });
  const r = env.call('requestAccount', { name: 'New Person', email: 'new@example.com' });
  assert.deepEqual(r.data, { received: true });
  const mail = env.outbox.find((m) => /account request/.test(m.subject));
  assert.ok(mail);
  assert.ok(mail.to.includes('admin@example.com') && mail.to.includes('admin2@example.com'));
  assert.ok(mail.body.includes('#/admin/users?focus='));
  assert.ok(!mail.subject.includes('New Person'), 'name is not in the subject');
  // the pending user cannot sign in
  env.call('requestLogin', { email: 'new@example.com' });
  assert.equal(env.lastLoginMail('new@example.com'), null);
});

test('duplicate request does not email admins again', () => {
  const { env } = setup();
  env.call('requestAccount', { name: 'New', email: 'new@example.com' });
  const n = env.outbox.length;
  env.call('requestAccount', { name: 'New', email: 'new@example.com' });
  assert.equal(env.outbox.length, n);
});

test('request from an already-approved address just sends a sign-in link', () => {
  const { env } = setup();
  const r = env.call('requestAccount', { name: 'Sam', email: 'sam@example.com' });
  assert.deepEqual(r.data, { received: true });
  assert.ok(env.lastLoginMail('sam@example.com'));
  assert.ok(!env.outbox.some((m) => /account request/.test(m.subject)));
});

test('honeypot requests are ignored silently', () => {
  const { env } = setup();
  const r = env.call('requestAccount', { name: 'Bot', email: 'bot@example.com', website: 'http://spam' });
  assert.equal(r.ok, true);
  assert.equal(env.outbox.length, 0);
  assert.equal(env.sheets.Users._rows.length, 3); // header + two seeded
});

test('hostile names are stored safely and escaped in email', () => {
  const { env } = setup();
  env.call('requestAccount', { name: '<script>alert(1)</script>\r\nBcc: x@y.z', email: 'evil@example.com' });
  const mail = env.outbox.find((m) => /account request/.test(m.subject));
  assert.ok(!mail.htmlBody.includes('<script>'));
  assert.ok(!/[\r\n]/.test(mail.subject));
});

test('daily cap on account requests', () => {
  const { env } = setup();
  for (let i = 0; i < 10; i++) assert.equal(env.call('requestAccount', { name: 'N' + i, email: 'n' + i + '@example.com' }).ok, true);
  assert.equal(env.call('requestAccount', { name: 'Late', email: 'late@example.com' }).error, 'try_later');
});

test('admin approves a pending user, who is emailed and can then sign in', () => {
  const { env } = setup();
  const adminToken = env.signInAs('admin@example.com');
  env.call('requestAccount', { name: 'New Person', email: 'new@example.com' });
  const pending = env.call('listUsers', { token: adminToken }).data.users.find((u) => u.email === 'new@example.com');
  assert.equal(pending.status, 'Pending');
  const r = env.call('setUserStatus', { token: adminToken, userId: pending.id, status: 'Approved' });
  assert.equal(r.data.user.status, 'Approved');
  assert.ok(env.outbox.some((m) => m.to === 'new@example.com' && /approved/.test(m.subject)));
  env.call('requestLogin', { email: 'new@example.com' });
  assert.ok(env.lastLoginMail('new@example.com'));
});

test('non-admins cannot manage users', () => {
  const { env, user } = setup();
  const token = env.signInAs('sam@example.com');
  assert.equal(env.call('listUsers', { token }).error, 'forbidden');
  assert.equal(env.call('setUserStatus', { token, userId: user.id, status: 'Revoked' }).error, 'forbidden');
  assert.equal(env.call('setUserRole', { token, userId: user.id, role: 'admin' }).error, 'forbidden');
});

test('revoking a user kills their sessions immediately', () => {
  const { env, user } = setup();
  const adminToken = env.signInAs('admin@example.com');
  const samToken = env.signInAs('sam@example.com');
  assert.equal(env.call('me', { token: samToken }).ok, true);
  assert.equal(env.call('setUserStatus', { token: adminToken, userId: user.id, status: 'Revoked' }).ok, true);
  assert.equal(env.call('me', { token: samToken }).error, 'unauthorized');
  env.call('requestLogin', { email: 'sam@example.com' });
  const n = env.outbox.filter((m) => m.to === 'sam@example.com').length;
  env.call('requestLogin', { email: 'sam@example.com' });
  assert.equal(env.outbox.filter((m) => m.to === 'sam@example.com').length, n);
});

test('invalid status transitions are rejected', () => {
  const { env, user } = setup();
  const adminToken = env.signInAs('admin@example.com');
  assert.equal(env.call('setUserStatus', { token: adminToken, userId: user.id, status: 'Approved' }).error, 'invalid_transition');
  assert.equal(env.call('setUserStatus', { token: adminToken, userId: user.id, status: 'Pending' }).error, 'invalid_transition');
  assert.equal(env.call('setUserStatus', { token: adminToken, userId: 'nope', status: 'Revoked' }).error, 'not_found');
});

test('an admin cannot revoke themselves, and the last admin cannot be removed or demoted', () => {
  const { env, admin } = setup();
  const t = env.signInAs('admin@example.com');
  assert.equal(env.call('setUserStatus', { token: t, userId: admin.id, status: 'Revoked' }).error, 'cannot_revoke_self');
  assert.equal(env.call('setUserRole', { token: t, userId: admin.id, role: 'user' }).error, 'last_admin');
});

test('roles can be changed, and a demoted admin loses access at once', () => {
  const { env, admin, user } = setup();
  const adminToken = env.signInAs('admin@example.com');
  assert.equal(env.call('setUserRole', { token: adminToken, userId: user.id, role: 'admin' }).data.user.role, 'admin');
  const samToken = env.signInAs('sam@example.com');
  assert.equal(env.call('listUsers', { token: samToken }).ok, true);
  // demote Sam again; the cached user record must refresh straight away
  assert.equal(env.call('setUserRole', { token: adminToken, userId: user.id, role: 'user' }).ok, true);
  assert.equal(env.call('listUsers', { token: samToken }).error, 'forbidden');
  assert.ok(admin.id);
});

// ---------- Google sign-in ----------

test('Google sign-in is off until configured', () => {
  const { env } = setup();
  assert.equal(env.call('googleLogin', { credential: 'abc' }).error, 'google_not_configured');
});

test('Google sign-in verifies audience, issuer, verified email and approval', () => {
  const { env } = setup();
  env.props.GOOGLE_CLIENT_ID = 'client-123';
  const good = { iss: 'https://accounts.google.com', aud: 'client-123', email: 'sam@example.com', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600) };

  env.state.tokeninfo = { code: 200, body: good };
  assert.equal(env.call('googleLogin', { credential: 'abc' }).ok, true);

  env.state.tokeninfo = { code: 200, body: Object.assign({}, good, { aud: 'someone-else' }) };
  assert.equal(env.call('googleLogin', { credential: 'abc' }).error, 'invalid_google_token');

  env.state.tokeninfo = { code: 200, body: Object.assign({}, good, { email_verified: 'false' }) };
  assert.equal(env.call('googleLogin', { credential: 'abc' }).error, 'invalid_google_token');

  env.state.tokeninfo = { code: 200, body: Object.assign({}, good, { iss: 'https://evil.example' }) };
  assert.equal(env.call('googleLogin', { credential: 'abc' }).error, 'invalid_google_token');

  env.state.tokeninfo = { code: 200, body: Object.assign({}, good, { exp: String(Math.floor(Date.now() / 1000) - 10) }) };
  assert.equal(env.call('googleLogin', { credential: 'abc' }).error, 'invalid_google_token');

  env.state.tokeninfo = { code: 400, body: { error: 'invalid_token' } };
  assert.equal(env.call('googleLogin', { credential: 'abc' }).error, 'invalid_google_token');

  env.state.tokeninfo = { code: 200, body: Object.assign({}, good, { email: 'stranger@example.com' }) };
  assert.equal(env.call('googleLogin', { credential: 'abc' }).error, 'not_approved');
});

// ---------- audit + text log ----------

test('key events are audited, without secrets', () => {
  const { env, user } = setup();
  const adminToken = env.signInAs('admin@example.com');
  env.call('requestAccount', { name: 'New', email: 'new@example.com' });
  env.call('setUserRole', { token: adminToken, userId: user.id, role: 'admin' });
  const actions = env.sheets.Audit._rows.slice(1).map((r) => r[3]);
  ['login_requested', 'login', 'account_requested', 'role_changed'].forEach((a) => assert.ok(actions.includes(a), a));
  const l = env.lastLoginMail('admin@example.com');
  assert.ok(!JSON.stringify(env.sheets.Audit._rows).includes(l.token));
});

test('flushTextLog writes new audit rows to a monthly text file, once', () => {
  const { env } = setup();
  env.signInAs('sam@example.com');
  env.ctx.flushTextLog();
  const file = Object.values(env.files)[0];
  assert.match(file.name, /^events-\d{4}-\d{2}\.txt$/);
  assert.match(file.content, /login_requested/);
  const len = file.content.length;
  env.ctx.flushTextLog();
  assert.equal(Object.values(env.files)[0].content.length, len, 'no duplicate lines');
  env.signInAs('sam@example.com');
  env.ctx.flushTextLog();
  assert.ok(Object.values(env.files)[0].content.length > len, 'new events appended');
});

test('the setup schema keeps the Tokens and Sessions columns the auth code relies on', () => {
  const { env } = setup();
  assert.deepEqual(env.sheets.Tokens._rows[0], ['hash', 'type', 'user_id', 'expires_at', 'used_at', 'attempts']);
  assert.ok(env.sheets.Sessions._rows[0].includes('revoked'));
});
