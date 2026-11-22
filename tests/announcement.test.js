'use strict';
// The Android app announcement: an admin can send a test to themselves or email every approved user, one personal email each.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

function setup() {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  env.seedUser({ name: 'Ann', email: 'ann@example.com', role: 'user' });
  env.seedUser({ name: 'Rex', email: 'rex@example.com', role: 'user', status: 'Revoked' });
  return { env, admin: env.signInAs('admin@example.com'), sam: env.signInAs('sam@example.com') };
}
const announcements = (env) => env.outbox.filter((m) => /Android app/.test(m.subject));

test('only an admin can send it', () => {
  const { env, sam } = setup();
  assert.equal(env.call('sendAppAnnouncement', { token: sam }).error, 'forbidden');
  assert.equal(env.call('sendAppAnnouncement', {}).error, 'unauthorized');
  assert.equal(announcements(env).length, 0);
});

test('a test goes to the admin alone, and can be repeated', () => {
  const { env, admin } = setup();
  const r = env.call('sendAppAnnouncement', { token: admin, testOnly: true });
  assert.deepEqual([r.data.sent, r.data.total, r.data.test], [1, 1, true]);
  assert.equal(env.call('sendAppAnnouncement', { token: admin, testOnly: true }).data.sent, 1);
  assert.deepEqual(announcements(env).map((m) => m.to), ['admin@example.com', 'admin@example.com']);
});

test('everyone approved gets their own personal email, nobody else, and not twice in a row', () => {
  const { env, admin } = setup();
  const r = env.call('sendAppAnnouncement', { token: admin });
  assert.deepEqual([r.data.sent, r.data.total], [3, 3]);
  const mails = announcements(env);
  assert.deepEqual(mails.map((m) => m.to).sort(), ['admin@example.com', 'ann@example.com', 'sam@example.com']);
  mails.forEach((m) => { assert.ok(!m.to.includes(','), 'one recipient each'); assert.ok(!m.cc && !m.bcc); });
  const sam = mails.find((m) => m.to === 'sam@example.com');
  assert.match(sam.body, /^Hi Sam,/);
  assert.match(sam.htmlBody, /Hi Sam,/);
  assert.match(sam.body, /Remove the Fleet Manager shortcut/);
  assert.match(sam.body, /Download the APK/);
  // it links to the website, never straight to the .apk file (mail filters distrust those)
  assert.ok(sam.body.includes('https://perezkabagambe.github.io/fleet-manager/'));
  assert.ok(!/\.apk/i.test(sam.body + sam.htmlBody));
  assert.equal(env.call('sendAppAnnouncement', { token: admin }).error, 'announcement_recent');
  env.advance(31 * 60 * 1000);
  assert.equal(env.call('sendAppAnnouncement', { token: env.signInAs('admin@example.com') }).ok, true);
});

test('it is refused, and nothing is sent, if there is not enough email allowance left for everyone', () => {
  const { env, admin } = setup();
  env.state.mailQuota = 2;
  assert.equal(env.call('sendAppAnnouncement', { token: admin }).error, 'mail_quota');
  assert.equal(announcements(env).length, 0);
  assert.equal(env.call('sendAppAnnouncement', { token: admin, testOnly: true }).ok, true, 'a test still fits');
});
