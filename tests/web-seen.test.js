'use strict';
// The phone-side "show what was seen last time" layer (web/api.js), run with a pretend browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function browser(opts) {
  opts = opts || {};
  const store = {};
  const calls = [];
  const events = [];
  const clock = { offset: 0 }; // move "now" forward to test day changes
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(Date.now() + clock.offset); }
    static now() { return Date.now() + clock.offset; }
  }
  const win = { FLEET_CONFIG: { apiUrl: 'https://api.example/exec' }, dispatchEvent(e) { events.push(e); }, FleetAuth: null };
  const answers = {}; // action -> function(params) returning { ok, data } | { ok:false, error }
  const sandbox = {
    window: win, console, Event: class { constructor(type) { this.type = type; } }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    performance: { now: () => Date.now() }, AbortController: class { constructor() { this.signal = {}; } abort() {} },
    setTimeout, clearTimeout, JSON, Object, Promise, Error, Date: FakeDate, Math,
    localStorage: opts.noStorage ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } }
      : { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { if (opts.full) throw new Error('quota'); store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    fetch: (url, init) => {
      const req = JSON.parse(init.body);
      calls.push(req);
      const fn = answers[req.action];
      const out = fn ? fn(req) : { ok: true, data: {} };
      return Promise.resolve(out).then((o) => ({ ok: true, json: () => Promise.resolve(o) })); // an answer may be a promise, to hold it back
    },
  };
  win.window = win;
  win.FleetGuest = { get: () => ({ token: 'g' }), clear() {} };
  let user = { id: 'u1' };
  win.FleetAuth = { token: () => 't', getUser: () => user, clear() { win.FleetApi.clearSaved(); } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'api.js'), 'utf8'), sandbox);
  return { api: win.FleetApi, store, calls, answers, setUser: (u) => { user = u; }, win, events, clock };
}

const collect = (api, action, params) => {
  const seen = [];
  const done = api.seen(action, params, (data, saved) => seen.push({ data, saved }));
  done.catch(() => {}); // callers that do not wait for it must not leave an unhandled rejection
  return { seen, done };
};

test('first visit: only the fresh answer; second visit: the saved copy at once, then the fresh one only if different', async () => {
  const b = browser();
  let version = 1;
  b.answers.getCarPage = () => ({ ok: true, data: { car: { id: 'c1' }, v: version } });
  let r = collect(b.api, 'getCarPage', { id: 'c1' });
  assert.equal(r.seen.length, 0, 'nothing saved yet');
  await r.done;
  assert.deepEqual(r.seen.map((x) => x.saved), [false]);

  r = collect(b.api, 'getCarPage', { id: 'c1' });
  assert.equal(r.seen.length, 1, 'the saved copy arrives immediately, before the request finishes');
  assert.equal(r.seen[0].saved, true);
  await r.done;
  assert.equal(r.seen.length, 1, 'same answer: no second drawing');

  version = 2;
  r = collect(b.api, 'getCarPage', { id: 'c1' });
  await r.done;
  assert.deepEqual(r.seen.map((x) => [x.saved, x.data.v]), [[true, 1], [false, 2]], 'saved copy, then the changed fresh answer');
});

test('saved copies are per person, per car, and never used when nobody is signed in', async () => {
  const b = browser();
  b.answers.getCarPage = (req) => ({ ok: true, data: { car: req.id } });
  await collect(b.api, 'getCarPage', { id: 'c1' }).done;
  let r = collect(b.api, 'getCarPage', { id: 'c2' });
  assert.equal(r.seen.length, 0, 'a different car has no saved copy');
  await r.done;
  b.setUser({ id: 'u2' });
  r = collect(b.api, 'getCarPage', { id: 'c1' });
  assert.equal(r.seen.length, 0, 'another person on the same phone never sees it');
  await r.done;
  b.setUser(null);
  await collect(b.api, 'getCarPage', { id: 'c1' }).done;
  r = collect(b.api, 'getCarPage', { id: 'c1' });
  assert.equal(r.seen.length, 0, 'nothing is saved or shown while the person is unknown');
  await r.done;
});

test('any change makes saved copies stale (still shown at once, but fetched again); plain reads do not', async () => {
  const b = browser();
  b.answers.getCarPage = () => ({ ok: true, data: { x: 1 } });
  await collect(b.api, 'getCarPage', { id: 'c1' }).done;
  await b.api.call('listCars');
  await b.api.call('ping');
  assert.equal(collect(b.api, 'getCarPage', { id: 'c1' }).seen.length, 1, 'reads leave it alone');
  for (const action of ['saveEntry', 'updateOdometer', 'deleteEntry', 'saveTask', 'setCarPeople', 'saveCar', 'uploadAttachment']) {
    b.api.setRevisions({ c1: 'r1' });
    await collect(b.api, 'getCarPage', { id: 'c1' }).done; // saved with revision r1
    const before = b.calls.length;
    const current = collect(b.api, 'getCarPage', { id: 'c1' });
    await current.done;
    assert.equal(b.calls.length, before, 'a current copy needs no request before ' + action);
    await b.api.call(action, {});
    const n = b.calls.length;
    const after = collect(b.api, 'getCarPage', { id: 'c1' });
    assert.equal(after.seen.length, 1, action + ': the old copy still appears at once');
    await after.done;
    assert.equal(b.calls.length, n + 1, action + ': and it is fetched again');
  }
  const ev = b.events.filter((e) => e.type === 'fleet:changed');
  assert.ok(ev.length >= 7, 'each change announces itself');
});

test('things that change nothing a car screen shows do not make copies stale', async () => {
  const b = browser();
  b.answers.getCarPage = () => ({ ok: true, data: { x: 1 } });
  b.api.setRevisions({ c1: 'r1' });
  await collect(b.api, 'getCarPage', { id: 'c1' }).done;
  for (const action of ['requestLogin', 'sendFeedback', 'logout', 'aiFillCar', 'sendMyReminders', 'guestSaveEntry']) await b.api.call(action, {});
  await b.api.call('saveEntry', {}, { guestCarId: 'c1' }).catch(() => {}); // a guest change on this phone
  assert.deepEqual(b.events.filter((e) => e.type === 'fleet:changed'), []);
  const n = b.calls.length;
  await collect(b.api, 'getCarPage', { id: 'c1' }).done;
  assert.equal(b.calls.length, n, 'still current');
});

test('a copy is current only while its car has the revision it was saved at, and only on the day it was saved', async () => {
  const b = browser();
  b.answers.getCarPage = () => ({ ok: true, data: { x: 1 } });
  b.api.setRevisions({ c1: 'r1', c2: 'r9' });
  await collect(b.api, 'getCarPage', { id: 'c1' }).done;
  let n = b.calls.length;
  let r = collect(b.api, 'getCarPage', { id: 'c1' });
  assert.equal((await r.done).cached, true);
  assert.equal(b.calls.length, n, 'current: no request');
  assert.deepEqual(r.seen.map((x) => x.saved), [true], 'drawn once, from the copy');

  b.api.setRevisions({ c1: 'r2' }); // the car changed elsewhere
  n = b.calls.length;
  await collect(b.api, 'getCarPage', { id: 'c1' }).done;
  assert.equal(b.calls.length, n + 1, 'another revision: fetched again');
  await collect(b.api, 'getCarPage', { id: 'c1' }).done;
  assert.equal(b.calls.length, n + 1, 'and now current at r2');

  b.clock.offset = 26 * 3600 * 1000; // tomorrow: reminders may have gone overdue
  await collect(b.api, 'getCarPage', { id: 'c1' }).done;
  assert.equal(b.calls.length, n + 2, 'a new day: fetched again');
});

test('with no revision known (nothing synced yet) every screen behaves as before: copy first, then the fresh answer', async () => {
  const b = browser();
  b.answers.getCarPage = () => ({ ok: true, data: { x: 1 } });
  await collect(b.api, 'getCarPage', { id: 'c1' }).done;
  const n = b.calls.length;
  const r = collect(b.api, 'getCarPage', { id: 'c1' });
  assert.equal(r.seen.length, 1);
  await r.done;
  assert.equal(b.calls.length, n + 1);
});

test('an entry belongs to the car named in its answer; put() saves a whole car at once', async () => {
  const b = browser();
  b.answers.getEntry = (req) => ({ ok: true, data: { entry: { id: req.id }, car: { id: 'c1' } } });
  b.api.setRevisions({ c1: 'r1' });
  await collect(b.api, 'getEntry', { id: 'e1' }).done; // stored against c1 at r1 although its car was not known beforehand
  let n = b.calls.length;
  await collect(b.api, 'getEntry', { id: 'e1' }).done;
  assert.equal(b.calls.length, n, 'current');
  b.api.put('getEntry', { id: 'e2' }, { entry: { id: 'e2' }, car: { id: 'c1' } }, 'c1', 'r1');
  const r = collect(b.api, 'getEntry', { id: 'e2' });
  await r.done;
  assert.equal(b.calls.length, n, 'a copy put in directly is current too');
  assert.deepEqual(r.seen.map((x) => x.data.entry.id), ['e2']);
  assert.deepEqual(b.api.peek('getEntry', { id: 'e2' }).entry, { id: 'e2' });
  b.api.setRevisions({ c1: 'r2' });
  await collect(b.api, 'getEntry', { id: 'e2' }).done;
  assert.equal(b.calls.length, n + 1);
});

test('an answer that was already on its way when something changed is not saved afterwards', async () => {
  const b = browser();
  let release;
  const gate = new Promise((r) => { release = r; });
  b.answers.getCarPage = () => gate.then(() => ({ ok: true, data: { old: true } })); // held back
  const read = b.api.seen('getCarPage', { id: 'c1' }, () => {}); // in flight
  await b.api.call('saveEntry', {}); // a change lands first
  release();
  await read; // the older answer arrives afterwards
  const next = collect(b.api, 'getCarPage', { id: 'c1' });
  assert.equal(next.seen.length, 0, 'the older answer was not saved');
  await next.done;
});

test('a failed change does not clear the saved copy, but signing out does', async () => {
  const b = browser();
  b.answers.getCarPage = () => ({ ok: true, data: { x: 1 } });
  b.answers.saveEntry = () => ({ ok: false, error: 'title_required' });
  await collect(b.api, 'getCarPage', { id: 'c1' }).done;
  await b.api.call('saveEntry', {}).catch(() => {});
  const kept = collect(b.api, 'getCarPage', { id: 'c1' });
  assert.equal(kept.seen.length, 1);
  await kept.done;
  b.win.FleetAuth.clear(); // what signing out or an ended session does
  assert.equal(collect(b.api, 'getCarPage', { id: 'c1' }).seen.length, 0);
});

test('when the refresh fails after a saved copy was shown, the error says so; not-found forgets the copy', async () => {
  const b = browser();
  b.answers.getCarPage = () => ({ ok: true, data: { x: 1 } });
  await collect(b.api, 'getCarPage', { id: 'c1' }).done;
  b.answers.getCarPage = () => ({ ok: false, error: 'server_error' });
  let err = null;
  await collect(b.api, 'getCarPage', { id: 'c1' }).done.catch((e) => { err = e; });
  assert.equal(err.code, 'server_error');
  assert.equal(err.hadSaved, true);
  assert.equal(collect(b.api, 'getCarPage', { id: 'c1' }).seen.length, 1, 'a server error keeps the saved copy');
  b.answers.getCarPage = () => ({ ok: false, error: 'not_found' });
  err = null;
  await collect(b.api, 'getCarPage', { id: 'c1' }).done.catch((e) => { err = e; });
  assert.equal(err.code, 'not_found');
  assert.equal(collect(b.api, 'getCarPage', { id: 'c1' }).seen.length, 0, 'a deleted car is forgotten');
  err = null;
  await collect(b.api, 'getCarPage', { id: 'c9' }).done.catch((e) => { err = e; });
  assert.equal(err.hadSaved, false);
});

test('it works, just without the speed-up, when the phone will not store anything', async () => {
  for (const opts of [{ noStorage: true }, { full: true }]) {
    const b = browser(opts);
    b.answers.getCarPage = () => ({ ok: true, data: { x: 1 } });
    const r = collect(b.api, 'getCarPage', { id: 'c1' });
    await r.done;
    assert.equal(r.seen.length, 1);
    const again = collect(b.api, 'getCarPage', { id: 'c1' });
    await again.done; // in memory for this visit at least, and no crash
    await b.api.call('saveEntry', {});
  }
});

test('server time is passed along when the backend reports it', async () => {
  const b = browser();
  b.answers.ping = () => ({ ok: true, data: {}, ms: 42 });
  assert.equal((await b.api.call('ping')).serverMs, 42);
  b.answers.ping = () => ({ ok: true, data: {} });
  assert.equal((await b.api.call('ping')).serverMs, null);
});
