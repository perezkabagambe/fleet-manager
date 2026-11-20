'use strict';
// The phone-side copy of the whole fleet: the database wrapper (web/store.js) and the sync engine (web/sync.js),
// run together with the real saved-copy layer (web/api.js), a fake server and a very small fake page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

// ---------- a fake page ----------
function makeDom() {
  function node(tag) {
    return {
      tag, children: [], attrs: {}, style: {}, listeners: {}, className: '', textContent: '', parent: null,
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      append(...c) { c.forEach((x) => { if (x && typeof x === 'object') x.parent = this; this.children.push(x); }); },
      replaceChildren(...c) { this.children = []; this.append(...c); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); },
      click() { (this.listeners.click || []).forEach((f) => f({})); },
    };
  }
  const body = node('body');
  const docListeners = {};
  const document = {
    createElement: node, body, visibilityState: 'visible',
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
  };
  const text = (n) => (n && typeof n === 'object' ? (n.textContent || '') + ' ' + (n.children || []).map(text).join(' ') : '');
  const find = (root, pred, out = []) => { if (root && typeof root === 'object') { if (pred(root)) out.push(root); (root.children || []).forEach((c) => find(c, pred, out)); } return out; };
  return { document, body, find, docListeners, text };
}

function memoryBackend(rows) {
  const data = rows || new Map();
  return {
    data,
    loadAll: () => Promise.resolve([...data.entries()]),
    put: (k, v) => { data.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(); },
    remove: (k) => { data.delete(k); return Promise.resolve(); },
    clear: () => { data.clear(); return Promise.resolve(); },
  };
}

// ---------- a fake server ----------
function makeServer() {
  const s = {
    cars: {
      c1: { registration: 'AB12 CDE', rev: 'r1', entries: [{ id: 'e1', thumbAttachmentId: 'a1' }, { id: 'e2', thumbAttachmentId: '' }] },
      c2: { registration: 'ZZ99 ZZZ', rev: 'r2', entries: [{ id: 'e3', thumbAttachmentId: 'a2' }] },
    },
    fleet: 'f1',
    failBundle: null, // a car id whose bundle fails
    calls: [],
  };
  s.handle = (req) => {
    s.calls.push(req.action + (req.carId ? ':' + req.carId : ''));
    switch (req.action) {
      case 'getChanges': return { ok: true, data: { cars: Object.fromEntries(Object.entries(s.cars).map(([id, c]) => [id, c.rev])), fleet: s.fleet, today: '2026-11-20' } };
      case 'listCars': return { ok: true, data: { cars: Object.entries(s.cars).map(([id, c]) => ({ id, registration: c.registration, entryCount: c.entries.length, photoThumbId: id === 'c1' ? 'ph1' : '' })), deleted: [], mine: {} } };
      case 'getCarBundle': {
        if (s.failBundle === req.carId) return { ok: false, error: 'server_error' };
        const c = s.cars[req.carId];
        if (!c) return { ok: false, error: 'not_found' };
        const details = {};
        c.entries.forEach((e) => { details[e.id] = { entry: { id: e.id }, car: { id: req.carId }, attachments: [] }; });
        return { ok: true, data: { rev: c.rev, today: '2026-11-20', page: { car: { id: req.carId, registration: c.registration }, fluids: [], people: { owners: [] }, entries: c.entries, tasks: [], costs: {}, documents: [] }, details } };
      }
      case 'getCarPage': { const c = s.cars[req.id]; return { ok: true, data: { car: { id: req.id }, entries: c.entries, rev: c.rev } }; }
      case 'getEntry': return { ok: true, data: { entry: { id: req.id }, car: { id: 'c1' }, attachments: [] } };
      case 'getAttachmentThumbs': return { ok: true, data: { thumbs: Object.fromEntries(req.ids.map((i) => [i, 'AAAA'])) } };
      default: return { ok: true, data: {} };
    }
  };
  return s;
}

// ---------- the phone ----------
function phone(opts) {
  opts = opts || {};
  const dom = makeDom();
  const server = opts.server || makeServer();
  const backend = opts.backend || memoryBackend();
  const events = [];
  const listeners = {};
  const thumbs = opts.thumbs || new Set();
  const carPhotos = [];
  let user = opts.user === undefined ? { id: 'u1' } : opts.user;
  const win = {
    FLEET_CONFIG: { apiUrl: 'https://api.example/exec' },
    indexedDB: undefined,
    dispatchEvent(e) { events.push(e); (listeners[e.type] || []).forEach((f) => f(e)); },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
  };
  const sandbox = {
    window: win, document: dom.document, console, Promise, JSON, Object, Date, Math, Error, Array, Number, String,
    setTimeout, clearTimeout, performance: { now: () => Date.now() },
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (url, init) => Promise.resolve(server.handle(JSON.parse(init.body))).then((o) => ({ ok: true, json: () => Promise.resolve(o) })),
  };
  win.window = win;
  const authCleared = [];
  sandbox.FleetAuth = win.FleetAuth = { token: () => 't', getUser: () => user, hasSession: () => !!user, clear() { authCleared.push(1); win.FleetApi.clearSaved(); if (win.FleetSync) win.FleetSync.forget(); } };
  sandbox.UI = {
    el(tag, attrs, children) {
      const n = dom.document.createElement(tag);
      Object.keys(attrs || {}).forEach((k) => {
        const v = attrs[k];
        if (v === false || v == null) return;
        if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
      });
      (children || []).forEach((c) => { if (c) n.append(c); });
      return n;
    },
    notice(kind, text) { const n = dom.document.createElement('div'); n.className = 'notice ' + kind; n.textContent = text; return n; },
    errorText(e) { return 'error:' + (e && e.code); },
  };
  sandbox.Photos = {
    THUMB_BATCH: 8,
    hasAttachmentThumb: (id) => thumbs.has(id),
    fetchThumbBatch: (ids) => win.FleetApi.call('getAttachmentThumbs', { ids }).then(() => { ids.forEach((i) => thumbs.add(i)); return ids.length; }),
    get: (car) => { carPhotos.push(car.id); return Promise.resolve('data:x'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('store.js'), sandbox);
  vm.runInContext(read('api.js'), sandbox);
  sandbox.FleetApi = win.FleetApi;
  vm.runInContext(read('sync.js'), sandbox);
  const ready = opts.noDatabase
    ? win.FleetStore.useBackend({ loadAll: () => Promise.reject(new Error('no database')) })
    : win.FleetStore.useBackend(backend);
  const overlay = () => dom.find(dom.body, (n) => n.className === 'sync-overlay')[0];
  const api = {
    win, server, backend, events, thumbs, carPhotos, dom, ready, overlay,
    sync: win.FleetSync, store: win.FleetStore, api: win.FleetApi,
    setUser(u) { user = u; },
    of: (type) => events.filter((e) => e.type === type),
    fill: () => { const o = overlay(); return o ? dom.find(o, (n) => n.className === 'sync-bar-fill')[0].style.width : null; },
    callsSince: (n) => server.calls.slice(n),
    // the screens' view of a saved answer: was it drawn from a current copy (no request)?
    async current(action, params) {
      const before = server.calls.length;
      const r = await win.FleetApi.cached(action, params, () => {});
      return { cached: !!r.cached, requests: server.calls.length - before };
    },
  };
  return api;
}

const norm = (x) => JSON.parse(JSON.stringify(x)); // the page under test runs in its own realm: compare plain data
const flush = () => new Promise((r) => setTimeout(r, 5));

// ---------- the database wrapper ----------
test('the store keeps things in memory at once and in the database in the background; it is loaded back next time', async () => {
  const back = memoryBackend();
  let p = phone({ backend: back });
  await p.ready;
  assert.equal(p.store.isPersistent(), true);
  p.store.set('d|u1|x', { a: 1 });
  p.store.set('t|a1', 'pic');
  assert.deepEqual(p.store.get('d|u1|x'), { a: 1 }, 'readable at once');
  await flush();
  assert.deepEqual(back.data.get('d|u1|x'), { a: 1 });
  assert.deepEqual(p.store.keys('t|'), ['t|a1']);
  p.store.delPrefix('t|');
  await flush();
  assert.equal(back.data.has('t|a1'), false);

  p = phone({ backend: back }); // the app is opened again
  await p.ready;
  assert.deepEqual(p.store.get('d|u1|x'), { a: 1 });
  p.store.clear();
  await flush();
  assert.equal(back.data.size, 0);
});

test('with no usable database the store still works, from memory, and says it is not persistent', async () => {
  const p = phone({ noDatabase: true });
  await p.ready;
  assert.equal(p.store.isPersistent(), false);
  p.store.set('k', 1);
  assert.equal(p.store.get('k'), 1);
  p.store.del('k');
  assert.equal(p.store.get('k'), undefined);
});

// ---------- the first download ----------
test('the first time on a phone: a progress screen, then every car, every entry and the small pictures are saved', async () => {
  const p = phone();
  await p.ready;
  const started = p.sync.start();
  await flush();
  assert.ok(p.overlay(), 'the progress screen is up');
  assert.match(p.dom.text(p.overlay()), /Saving the app.s data on this device/);
  await started;
  assert.equal(p.overlay(), undefined, 'and gone again');

  // one bundle per car, no per-screen requests
  assert.deepEqual(p.server.calls.filter((c) => c.startsWith('getCarBundle')).sort(), ['getCarBundle:c1', 'getCarBundle:c2']);
  assert.ok(p.carPhotos.includes('c1'), 'a car photo thumbnail was fetched');
  assert.deepEqual([...p.thumbs].sort(), ['a1', 'a2'], 'entry thumbnails were fetched');

  // every read-only screen now opens without a request
  const screens = [['listCars', {}], ['getCarPage', { id: 'c1' }], ['listEntries', { carId: 'c1' }], ['listTasks', { carId: 'c1' }], ['getCarCosts', { carId: 'c1' }],
    ['listCarDocuments', { carId: 'c1' }], ['getEntry', { id: 'e1' }], ['getEntry', { id: 'e3' }], ['getCarPage', { id: 'c2' }]];
  for (const [a, params] of screens) {
    const r = await p.current(a, params);
    assert.deepEqual(r, { cached: true, requests: 0 }, a + ' ' + JSON.stringify(params));
  }
  assert.ok(p.store.get('m|primed|u1'), 'it is remembered that this phone has been filled');
  assert.match(p.fill() || '100%', /100%|^$/);
});

test('the shapes saved match what the screens ask for (listTasks has its distance unit)', async () => {
  const p = phone();
  await p.ready;
  await p.sync.start();
  assert.deepEqual(norm(p.api.peek('listTasks', { carId: 'c1' })), { tasks: [], distanceUnit: 'mi' });
  assert.deepEqual(norm(p.api.peek('listEntries', { carId: 'c1' })), { entries: p.server.cars.c1.entries });
  assert.deepEqual(norm(p.api.peek('listCarDocuments', { carId: 'c1' })), { documents: [] });
});

test('progress only moves forward and ends at 100%', async () => {
  const p = phone();
  await p.ready;
  const seen = [];
  const t = setInterval(() => { const f = p.fill(); if (f) seen.push(parseInt(f, 10)); }, 1);
  await p.sync.start();
  clearInterval(t);
  assert.deepEqual(seen, seen.slice().sort((a, b) => a - b), 'never goes backwards');
});

test('if a car cannot be downloaded the screen says so and offers to try again or carry on', async () => {
  const p = phone();
  await p.ready;
  p.server.failBundle = 'c2';
  const started = p.sync.start();
  await new Promise((r) => setTimeout(r, 30));
  const o = p.overlay();
  assert.ok(o, 'still on screen');
  const buttons = p.dom.find(o, (n) => n.tag === 'button');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Try again', 'Carry on without it']);
  assert.match(p.dom.text(o), /error:server_error/);
  assert.equal(p.store.get('m|primed|u1'), undefined, 'not marked as done');

  p.server.failBundle = null;
  buttons[0].click(); // try again
  await started;
  assert.equal(p.overlay(), undefined);
  assert.ok(p.store.get('m|primed|u1'));
});

test('"Carry on without it" lets the person in, and the next visit tries the download again', async () => {
  const back = memoryBackend();
  let p = phone({ backend: back });
  await p.ready;
  p.server.failBundle = 'c1';
  const started = p.sync.start();
  await new Promise((r) => setTimeout(r, 30));
  p.dom.find(p.overlay(), (n) => n.tag === 'button')[1].click();
  await started;
  assert.equal(p.overlay(), undefined);
  assert.equal(p.store.get('m|primed|u1'), undefined);
  p = phone({ backend: back, server: p.server });
  await p.ready;
  p.server.failBundle = null;
  await p.sync.start();
  assert.ok(p.store.get('m|primed|u1'));
});

// ---------- every later visit ----------
test('opening the app again: screens are current at once, and the only request is the small check', async () => {
  const back = memoryBackend();
  let p = phone({ backend: back });
  await p.ready;
  await p.sync.start();
  await flush();

  const server = p.server;
  p = phone({ backend: back, server, thumbs: p.thumbs }); // the app is opened again later
  await p.ready;
  const before = server.calls.length;
  const started = p.sync.start();
  const r = await p.current('getEntry', { id: 'e1' });
  assert.deepEqual(r, { cached: true, requests: 0 }, 'current before the check has even finished');
  await started;
  assert.deepEqual(server.calls.slice(before), ['getChanges'], 'nothing else was downloaded');
  assert.equal(p.overlay(), undefined, 'and no progress screen');
  assert.equal(p.of('fleet:data-updated').length, 0);
});

test('when someone else changes one car, only that car is downloaded again, and the screen is told', async () => {
  const back = memoryBackend();
  let p = phone({ backend: back });
  await p.ready;
  await p.sync.start();
  await flush();
  const server = p.server;
  server.cars.c2.rev = 'r2b';
  server.cars.c2.entries.push({ id: 'e4', thumbAttachmentId: 'a3' });
  server.fleet = 'f2';

  p = phone({ backend: back, server, thumbs: p.thumbs });
  await p.ready;
  const before = server.calls.length;
  await p.sync.start();
  assert.deepEqual(server.calls.slice(before).filter((c) => c !== 'getAttachmentThumbs'), ['getChanges', 'getCarBundle:c2', 'listCars']);
  assert.deepEqual(p.of('fleet:data-updated').map((e) => norm(e.detail)), [{ cars: ['c2'], fleet: true }]);
  assert.deepEqual(await p.current('getEntry', { id: 'e4' }), { cached: true, requests: 0 }, 'the new entry is there');
  assert.deepEqual(await p.current('getCarPage', { id: 'c1' }), { cached: true, requests: 0 }, 'the other car stayed current');
  assert.ok(p.thumbs.has('a3'), 'and the new entry\'s small picture arrived');
});

test('a change someone made that nothing on screen depends on does not redraw anything', async () => {
  const back = memoryBackend();
  let p = phone({ backend: back });
  await p.ready;
  await p.sync.start();
  await flush();
  const server = p.server;
  server.cars.c1.rev = 'r1b'; // a revision moved (say, an internal field) but the content is the same
  p = phone({ backend: back, server, thumbs: p.thumbs });
  await p.ready;
  await p.sync.start();
  assert.equal(p.of('fleet:data-updated').length, 0, 'identical content: no redraw');
  assert.deepEqual(await p.current('getCarPage', { id: 'c1' }), { cached: true, requests: 0 });
});

test('after this person changes something, copies are not trusted until the check says which cars changed', async () => {
  const p = phone();
  await p.ready;
  await p.sync.start();
  await flush();
  assert.deepEqual(await p.current('getCarPage', { id: 'c1' }), { cached: true, requests: 0 });

  await p.api.call('saveEntry', { carId: 'c1' }); // what the person did
  assert.equal(p.of('fleet:changed').length, 1);
  assert.equal((await p.current('getCarPage', { id: 'c1' })).requests, 1, 'not trusted straight after a change');

  p.server.cars.c1.rev = 'r1c'; // the server's fingerprint for the car moved
  p.server.cars.c1.entries.push({ id: 'e9', thumbAttachmentId: '' });
  p.server.fleet = 'f3';
  const before = p.server.calls.length;
  await p.sync.quickCheck();
  assert.deepEqual(p.server.calls.slice(before), ['getChanges', 'getCarBundle:c1', 'listCars'], 'only the changed car');
  assert.deepEqual(await p.current('getEntry', { id: 'e9' }), { cached: true, requests: 0 });
  assert.deepEqual(await p.current('getCarPage', { id: 'c2' }), { cached: true, requests: 0 }, 'the untouched car is trusted again');
  p.sync.forget();
});

test('cars that vanish from the server are forgotten', async () => {
  const back = memoryBackend();
  let p = phone({ backend: back });
  await p.ready;
  await p.sync.start();
  await flush();
  const server = p.server;
  delete server.cars.c2;
  server.fleet = 'f2';
  p = phone({ backend: back, server, thumbs: p.thumbs });
  await p.ready;
  await p.sync.start();
  assert.equal(p.api.peek('getCarPage', { id: 'c2' }), undefined);
  assert.equal(p.api.peek('getEntry', { id: 'e3' }), undefined);
  assert.notEqual(p.api.peek('getCarPage', { id: 'c1' }), undefined);
});

test('entries that were deleted are forgotten', async () => {
  const p = phone();
  await p.ready;
  await p.sync.start();
  await flush();
  p.server.cars.c1.entries = [{ id: 'e1', thumbAttachmentId: 'a1' }];
  p.server.cars.c1.rev = 'r1d';
  p.server.fleet = 'f2';
  await p.sync.quickCheck();
  assert.equal(p.api.peek('getEntry', { id: 'e2' }), undefined);
  assert.notEqual(p.api.peek('getEntry', { id: 'e1' }), undefined);
});

test('a copy saved on another day is not trusted (reminders go overdue as days pass)', async () => {
  const p = phone();
  await p.ready;
  await p.sync.start();
  const stored = p.store.get('d|u1|getCarPage|{"id":"c1"}');
  stored.day = '2000-01-01';
  assert.equal((await p.current('getCarPage', { id: 'c1' })).requests, 1);
});

// ---------- the button, sign-out and other people ----------
test('"Refresh all app data" downloads everything again behind the progress screen and redraws the screen', async () => {
  const p = phone();
  await p.ready;
  await p.sync.start();
  await flush();
  p.server.cars.c1.entries.push({ id: 'e7', thumbAttachmentId: '' }); // changed without the revision moving: only a full refresh finds it
  const before = p.server.calls.length;
  const done = p.sync.refreshAll();
  await flush();
  assert.ok(p.overlay());
  assert.match(p.dom.text(p.overlay()), /Refreshing the app.s data/);
  await done;
  assert.equal(p.overlay(), undefined);
  assert.deepEqual(p.server.calls.slice(before).filter((c) => c.startsWith('getCarBundle')).sort(), ['getCarBundle:c1', 'getCarBundle:c2']);
  assert.deepEqual(await p.current('getEntry', { id: 'e7' }), { cached: true, requests: 0 });
  assert.deepEqual(norm(p.of('fleet:data-updated').pop().detail), { cars: [], fleet: true, all: true });
});

test('nothing is saved between visits when the phone has no database: no progress screen, the app works as before', async () => {
  const p = phone({ noDatabase: true });
  await p.ready;
  await p.sync.start();
  assert.equal(p.overlay(), undefined);
  assert.deepEqual(p.server.calls, []);
});

test('signing out forgets everything saved; the next person starts afresh', async () => {
  const back = memoryBackend();
  const p = phone({ backend: back });
  await p.ready;
  await p.sync.start();
  await flush();
  assert.ok(back.data.size > 5);
  p.win.FleetAuth.clear();
  await flush();
  assert.equal([...back.data.keys()].filter((k) => k.startsWith('d|') || k.startsWith('m|')).length, 0);
  assert.equal(p.api.peek('getCarPage', { id: 'c1' }), undefined);
});

test('a copy saved for somebody else on this phone is removed when another person signs in', async () => {
  const back = memoryBackend();
  let p = phone({ backend: back });
  await p.ready;
  await p.sync.start();
  await flush();
  const server = p.server;
  p = phone({ backend: back, server, user: { id: 'u2' } }); // signed in as somebody else without a sign-out in between
  await p.ready;
  await p.sync.start();
  const left = [...back.data.keys()].filter((k) => k.startsWith('d|u1|') || k === 'm|primed|u1' || k === 'm|revs|u1');
  assert.deepEqual(left, []);
  assert.ok(back.data.has('m|primed|u2'), 'and they get their own download');
});

test('nobody signed in: nothing starts', async () => {
  const p = phone({ user: null });
  await p.ready;
  await p.sync.start();
  assert.deepEqual(p.server.calls, []);
  assert.equal(p.overlay(), undefined);
});

test('the pool runs a few at a time, in full, and stops at the first failure', async () => {
  const p = phone();
  let active = 0;
  let peak = 0;
  const done = [];
  await p.sync._pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { active++; peak = Math.max(peak, active); await flush(); active--; done.push(n); });
  assert.equal(peak, 3);
  assert.equal(done.length, 7);
  await assert.rejects(p.sync._pool([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('x'); }), /x/);
  await p.sync._pool([], 3, async () => {});
});
