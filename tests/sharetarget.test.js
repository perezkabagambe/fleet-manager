'use strict';
// Sharing a file to Fleet Manager from another app on the phone: the manifest declares the share target, and the service
// worker keeps the shared files for the AI Inbox and redirects there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web');

test('the web manifest is a share target for PDFs and photos, posting to a URL the service worker handles', () => {
  const m = JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.share_target.method, 'POST');
  assert.equal(m.share_target.enctype, 'multipart/form-data');
  assert.deepEqual(m.share_target.params.files, [{ name: 'file', accept: ['application/pdf', 'image/*'] }]);
  const action = new URL(m.share_target.action, 'https://perezkabagambe.github.io/fleet-manager/manifest.webmanifest');
  assert.equal(action.href, 'https://perezkabagambe.github.io/fleet-manager/share-target');
});

function loadWorker() {
  const listeners = {};
  const store = new Map(); // cache name -> Map(url -> Response)
  const caches = {
    open: async (name) => {
      if (!store.has(name)) store.set(name, new Map());
      const c = store.get(name);
      return { put: async (k, res) => { c.set(String(k), res); }, keys: async () => [...c.keys()], match: async (k) => c.get(String(k)), delete: async (k) => c.delete(String(k)) };
    },
    keys: async () => [...store.keys()],
    match: async () => undefined,
  };
  const self = { location: new URL('https://perezkabagambe.github.io/fleet-manager/sw.js'), registration: { scope: 'https://perezkabagambe.github.io/fleet-manager/' }, addEventListener: (t, fn) => { listeners[t] = fn; }, clients: { claim: async () => {} } };
  const ctx = vm.createContext({ self, caches, Response, URL, Request, fetch: async () => new Response('net'), Date, console });
  vm.runInContext(fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8'), ctx);
  return { listeners, store };
}

function fire(listeners, request) {
  let answer;
  listeners.fetch({ request, respondWith: (p) => { answer = p; } });
  return answer;
}

test('a file shared to the app is kept for the AI Inbox, and the person is sent there', async () => {
  const { listeners, store } = loadWorker();
  const form = new FormData();
  form.append('file', new File([Buffer.from('%PDF-1.4 receipt')], 'Garage invoice.pdf', { type: 'application/pdf' }));
  form.append('file', new File([Buffer.from('jpegdata')], 'photo.jpg', { type: 'image/jpeg' }));
  const req = new Request('https://perezkabagambe.github.io/fleet-manager/share-target', { method: 'POST', body: form });
  const res = await fire(listeners, req);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://perezkabagambe.github.io/fleet-manager/#/inbox?shared=1');
  const kept = store.get('fm-shared-v1');
  assert.equal(kept.size, 2);
  const first = [...kept.values()][0];
  assert.equal(first.headers.get('Content-Type'), 'application/pdf');
  assert.equal(decodeURIComponent(first.headers.get('X-File-Name')), 'Garage invoice.pdf');
  assert.equal(Buffer.from(await first.arrayBuffer()).toString(), '%PDF-1.4 receipt');
});

test('a share with no usable file still lands in the AI Inbox, and other requests are left alone', async () => {
  const { listeners, store } = loadWorker();
  const empty = await fire(listeners, new Request('https://perezkabagambe.github.io/fleet-manager/share-target', { method: 'POST', body: new FormData() }));
  assert.equal(empty.status, 303);
  assert.equal(store.get('fm-shared-v1') ? store.get('fm-shared-v1').size : 0, 0);
  // an ordinary page request is handled by the normal cache-then-network path, and a POST elsewhere is not touched
  assert.ok(fire(listeners, new Request('https://perezkabagambe.github.io/fleet-manager/styles.css')));
  assert.equal(fire(listeners, new Request('https://perezkabagambe.github.io/fleet-manager/other', { method: 'POST', body: 'x' })), undefined);
});

test('the AI Inbox picks shared files up from the same cache name the service worker writes to', () => {
  const inbox = fs.readFileSync(path.join(WEB, 'views-inbox.js'), 'utf8');
  const worker = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8');
  const name = /SHARED = '([^']+)'/.exec(worker)[1];
  assert.ok(inbox.includes("SHARED_CACHE = '" + name + "'"));
  assert.ok(!/startsWith\('fleet-shell-'\)[^;]*fm-shared/.test(worker), 'the shared cache is not cleaned up with the old app caches');
});
