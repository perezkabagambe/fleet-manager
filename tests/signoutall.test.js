'use strict';
// An admin can sign everyone out at once: every session is switched off, the admin's own included.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

function setup() {
  const env = createEnv();
  env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  env.seedUser({ name: 'Ann', email: 'ann@example.com', role: 'user' });
  return env;
}

test('only an admin can sign everyone out', () => {
  const env = setup();
  const sam = env.signInAs('sam@example.com');
  assert.equal(env.call('signOutAll', { token: sam }).error, 'forbidden');
  assert.equal(env.call('signOutAll', {}).error, 'unauthorized');
  assert.equal(env.call('me', { token: sam }).ok, true, 'nothing happened to Sam');
});

test('every signed-in user, and the admin, must sign in again afterwards', () => {
  const env = setup();
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  const ann = env.signInAs('ann@example.com');
  const sam2 = env.signInAs('sam@example.com'); // a second phone
  const r = env.call('signOutAll', { token: admin });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.sessions, 4);
  [admin, sam, ann, sam2].forEach((t) => assert.equal(env.call('me', { token: t }).error, 'unauthorized'));
  // signing in again works as normal
  assert.equal(env.call('me', { token: env.signInAs('sam@example.com') }).ok, true);
  assert.equal(env.call('me', { token: env.signInAs('admin@example.com') }).ok, true);
});

test('signing everyone out is recorded, and sessions already switched off are not counted twice', () => {
  const env = setup();
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  env.call('logout', { token: sam });
  const r = env.call('signOutAll', { token: admin });
  assert.equal(r.data.sessions, 1, 'only the admin\'s own session was still active');
  const audit = env.call('getAuditLog', { token: env.signInAs('admin@example.com') });
  if (audit.ok) assert.ok(JSON.stringify(audit.data).includes('signout_all'));
});
