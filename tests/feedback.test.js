'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

function setup() {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Admin Two', email: 'ADMIN2@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam Smith', email: 'sam@example.com', role: 'user' });
  env.seedUser({ name: 'Gone Admin', email: 'gone@example.com', role: 'admin', status: 'Revoked' });
  const sam = env.signInAs('sam@example.com');
  const admin = env.signInAs('admin@example.com');
  const car = env.call('saveCar', { token: sam, fields: { registration: 'AB12 CDE', make: 'Toyota', model: 'Hilux', year: '2015' } }).data.car;
  const secret = env.call('getCar', { token: sam, id: car.id }).data.car.guestSecret;
  const feedbackMails = () => env.outbox.filter((m) => /^\[Fleet Manager\]/.test(m.subject));
  return { env, sam, admin, car, secret, feedbackMails };
}
const bug = (extra) => Object.assign({ kind: 'Bug', title: 'Photo will not upload', details: 'Tapped Take photo\nNothing happened', page: '/car/abc/edit', appRev: 'abc1234', device: 'iPhone Safari' }, extra);

test('feedback goes to the app account and every approved admin, with the sender as reply-to', () => {
  const { env, sam, feedbackMails } = setup();
  const r = env.call('sendFeedback', Object.assign({ token: sam }, bug()));
  assert.equal(r.ok, true);
  const mails = feedbackMails();
  assert.equal(mails.length, 1, 'one email, many recipients');
  const to = mails[0].to.split(',').sort();
  assert.deepEqual(to, ['admin2@example.com', 'admin@example.com', 'potentiafleetmanager@gmail.com']);
  assert.equal(mails[0].replyTo, 'sam@example.com');
  assert.equal(mails[0].subject, '[Fleet Manager] Bug: Photo will not upload');
  assert.match(mails[0].body, /Nothing happened/);
  assert.match(mails[0].body, /Sam Smith \(sam@example.com\)/);
  assert.match(mails[0].body, /iPhone Safari/);
  assert.ok(mails[0].htmlBody.includes('Tapped Take photo'));
  assert.ok(env.sheets.Audit._rows.some((x) => x[3] === 'feedback_sent'));
});

test('a feature request has its own subject; the kind and title are checked', () => {
  const { env, sam, feedbackMails } = setup();
  assert.equal(env.call('sendFeedback', { token: sam, kind: 'Feature request', title: 'Dark mode' }).ok, true);
  assert.equal(feedbackMails()[0].subject, '[Fleet Manager] Feature request: Dark mode');
  assert.match(feedbackMails()[0].body, /no further details/);
  assert.equal(env.call('sendFeedback', Object.assign({ token: sam }, bug({ kind: 'Praise' }))).error, 'invalid_kind');
  assert.equal(env.call('sendFeedback', Object.assign({ token: sam }, bug({ kind: '' }))).error, 'invalid_kind');
  assert.equal(env.call('sendFeedback', Object.assign({ token: sam }, bug({ title: '  ' }))).error, 'title_required');
  assert.equal(feedbackMails().length, 1, 'nothing sent for the invalid ones');
});

test('text is escaped, subjects cannot be split, and secrets after a ? are dropped from the page', () => {
  const { env, sam, feedbackMails } = setup();
  env.call('sendFeedback', Object.assign({ token: sam }, bug({ title: 'Evil\r\nBcc: x@y.com <b>', details: '<script>alert(1)</script>', page: '/car/abc?g=SECRETVALUE' })));
  const m = feedbackMails()[0];
  assert.ok(!/[\r\n]/.test(m.subject));
  assert.ok(!m.htmlBody.includes('<script>'));
  assert.ok(m.htmlBody.includes('&lt;script&gt;'));
  assert.ok(!m.body.includes('SECRETVALUE') && !m.htmlBody.includes('SECRETVALUE'));
  assert.match(m.body, /Screen: \/car\/abc\n/);
});

test('only signed-in people and guests can send; guests are named and cannot be replied to', () => {
  const { env, car, secret, feedbackMails } = setup();
  assert.equal(env.call('sendFeedback', bug()).error, 'unauthorized');
  assert.equal(env.call('guestSendFeedback', bug()).error, 'guest_unauthorized');
  const g = env.call('guestJoin', { carId: car.id, secret, name: 'Bobs Garage' }).data.guestToken;
  assert.equal(env.call('sendFeedback', Object.assign({ guestToken: g }, bug())).error, 'unauthorized', 'a guest token is not a user');
  assert.equal(env.call('guestSendFeedback', Object.assign({ guestToken: g }, bug())).ok, true);
  const m = feedbackMails()[0];
  assert.match(m.body, /Guest: Bobs Garage/);
  assert.match(m.body, /AB12 CDE Toyota Hilux/);
  assert.equal(m.replyTo, undefined);
});

test('limits: five an hour each, and a failed email is reported', () => {
  const { env, sam, admin, feedbackMails } = setup();
  for (let i = 0; i < 5; i++) assert.equal(env.call('sendFeedback', Object.assign({ token: sam }, bug({ title: 'Bug ' + i }))).ok, true);
  assert.equal(env.call('sendFeedback', Object.assign({ token: sam }, bug())).error, 'try_later');
  assert.equal(env.call('sendFeedback', Object.assign({ token: admin }, bug())).ok, true, 'limits are per person');
  env.state.mailQuota = 0;
  assert.equal(env.call('sendFeedback', Object.assign({ token: admin }, bug({ title: 'Again' }))).error, 'email_failed');
  assert.equal(feedbackMails().length, 6);
});
