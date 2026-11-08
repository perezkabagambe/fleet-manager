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
  const win = { FLEET_CONFIG: { apiUrl: 'https://api.example/exec' }, dispatchEvent() {}, FleetAuth: null };
  const answers = {}; // action -> function(params) returning { ok, data } | { ok:false, error }
  const sandbox = {
    window: win, console, Event: class {}, CustomEvent: class {},
    performance: { now: () => Date.now() }, AbortController: class { constructor() { this.signal = {}; } abort() {} },
    setTimeout, clearTimeout, JSON, Object, Promise, Error, Date, Math,
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
  let user = { id: 'u1' };
  win.FleetAuth = { token: () => 't', getUser: () => user, clear() { win.FleetApi.clearSaved(); } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'api.js'), 'utf8'), sandbox);
  return { api: win.FleetApi, store, calls, answers, setUser: (u) => { user = u; }, win };
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

test('any change clears everything saved; plain reads do not', async () => {
  const b = browser();
  b.answers.getCarPage = () => ({ ok: true, data: { x: 1 } });
  await collect(b.api, 'getCarPage', { id: 'c1' }).done;
  await b.api.call('listCars');
  await b.api.call('ping');
  assert.equal(collect(b.api, 'getCarPage', { id: 'c1' }).seen.length, 1, 'reads leave it alone');
  for (const action of ['saveEntry', 'updateOdometer', 'deleteEntry', 'saveTask', 'setCarPeople', 'sendMyReminders', 'saveCar', 'guestSaveEntry']) {
    await collect(b.api, 'getCarPage', { id: 'c1' }).done;
    const before = collect(b.api, 'getCarPage', { id: 'c1' });
    assert.equal(before.seen.length, 1, 'saved before ' + action);
    await before.done;
    await b.api.call(action, {});
    const after = collect(b.api, 'getCarPage', { id: 'c1' });
    assert.equal(after.seen.length, 0, action + ' clears what was saved');
    await after.done;
  }
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
  assert.equal(b.store['fleet.saved.v1'], undefined, 'nothing left on the phone');
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

test('the saved screens are kept within a size and count limit', async () => {
  const b = browser();
  b.answers.getCarPage = (req) => ({ ok: true, data: { id: req.id, blob: 'x'.repeat(100000) } });
  for (let i = 0; i < 40; i++) await b.api.seen('getCarPage', { id: 'car' + i }, () => {});
  const saved = JSON.parse(b.store['fleet.saved.v1']);
  assert.ok(Object.keys(saved).length <= 24, 'at most 24 screens');
  assert.ok(b.store['fleet.saved.v1'].length <= 1500000 + 1000, 'within the size limit');
  assert.ok(Object.keys(saved).some((k) => k.includes('car39')), 'the newest are kept');
  assert.ok(!Object.keys(saved).some((k) => k.includes('"car0"')), 'the oldest go first');
});

test('server time is passed along when the backend reports it', async () => {
  const b = browser();
  b.answers.ping = () => ({ ok: true, data: {}, ms: 42 });
  assert.equal((await b.api.call('ping')).serverMs, 42);
  b.answers.ping = () => ({ ok: true, data: {} });
  assert.equal((await b.api.call('ping')).serverMs, null);
});
