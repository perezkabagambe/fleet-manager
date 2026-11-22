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
  // the button and the plain-text link both go straight to the app file
  const apk = 'https://github.com/perezkabagambe/fleet-manager/releases/download/android-v1.2/FleetManager-1.2.apk';
  assert.ok(sam.body.includes(apk));
  assert.ok(sam.htmlBody.includes('href="' + apk + '"'));
  assert.match(sam.htmlBody, /Download the Android app/);
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

// ---------- "an Android app update is available" ----------
const updates = (env) => env.outbox.filter((m) => /app update available/.test(m.subject));
const CHANGES = '- Share a PDF or photo from another app straight into the AI Inbox\n* It is read and ready to draft as an entry\n\n   Faster start-up  ';

test('the update email needs what it adds, and is for admins only', () => {
  const { env, admin, sam } = setup();
  assert.equal(env.call('sendApkUpdateAnnouncement', { token: sam, changes: CHANGES }).error, 'forbidden');
  assert.equal(env.call('sendApkUpdateAnnouncement', { token: admin, changes: '  \n ' }).error, 'changes_required');
  assert.equal(env.call('sendApkUpdateAnnouncement', { token: admin }).error, 'changes_required');
  assert.equal(updates(env).length, 0);
});

test('the update email lists the changes, links to the app file, and tells everyone else nothing is needed', () => {
  const { env, admin } = setup();
  const r = env.call('sendApkUpdateAnnouncement', { token: admin, testOnly: true, changes: CHANGES });
  assert.deepEqual([r.data.sent, r.data.test], [1, true]);
  const m = updates(env)[0];
  assert.equal(m.to, 'admin@example.com');
  assert.match(m.body, /This update adds:\n- Share a PDF or photo from another app straight into the AI Inbox\n- It is read and ready to draft as an entry\n- Faster start-up\n/);
  assert.match(m.htmlBody, /<li[^>]*>Share a PDF or photo from another app straight into the AI Inbox<\/li>/);
  assert.match(m.htmlBody, /<li[^>]*>Faster start-up<\/li>/);
  const apk = 'https://github.com/perezkabagambe/fleet-manager/releases/download/android-v1.2/FleetManager-1.2.apk';
  assert.ok(m.body.includes(apk) && m.htmlBody.includes('href="' + apk + '"'));
  assert.match(m.body, /nothing to do\. The web app keeps getting its updates automatically/);
});

test('the update email goes to everyone approved, escapes what was typed, and has its own repeat guard', () => {
  const { env, admin } = setup();
  const r = env.call('sendApkUpdateAnnouncement', { token: admin, changes: '<b>Bold</b> & more' });
  assert.deepEqual([r.data.sent, r.data.total], [3, 3]);
  const html = updates(env)[0].htmlBody;
  assert.ok(html.includes('&lt;b&gt;Bold&lt;/b&gt; &amp; more') && !html.includes('<b>Bold</b>'));
  assert.equal(env.call('sendApkUpdateAnnouncement', { token: admin, changes: 'x' }).error, 'announcement_recent');
  // the other announcement is not blocked by it
  assert.equal(env.call('sendAppAnnouncement', { token: admin }).ok, true);
});

test('at most eight changes, each kept short', () => {
  const { env, admin } = setup();
  const many = Array.from({ length: 12 }, (_, i) => 'Change ' + (i + 1) + ' ' + 'x'.repeat(300)).join('\n');
  env.call('sendApkUpdateAnnouncement', { token: admin, testOnly: true, changes: many });
  const lines = updates(env)[0].body.split('\n').filter((l) => /^- Change/.test(l));
  assert.equal(lines.length, 8);
  lines.forEach((l) => assert.ok(l.length <= 162));
});
