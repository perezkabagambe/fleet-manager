// Service worker: caches the app shell so the installed app opens instantly.
// API calls (cross-origin to Apps Script) are never cached.
// The deploy workflow replaces __COMMIT__, so each release gets its own cache
// and the browser sees a changed sw.js, which triggers the "Update now" banner.
const VERSION = '__COMMIT__';
const CACHE = 'fleet-shell-' + VERSION;
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'config.js',
  'ui.js',
  'auth.js',
  'guest.js',
  'store.js',
  'api.js',
  'photos.js',
  'viewer.js',
  'sync.js',
  'pdfkit.js',
  'zipkit.js',
  'exportreport.js',
  'export.js',
  'views-auth.js',
  'views-admin.js',
  'vendor/qrcode.js',
  'views-cars.js',
  'views-people.js',
  'views-entries.js',
  'views-reminders.js',
  'views-documents.js',
  'views-inbox.js',
  'views-guest.js',
  'views-feedback.js',
  'app.js',
  'manifest.webmanifest',
  'icons/logo.jpg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // No skipWaiting here: the page asks for it when the user taps "Update now".
  // cache: 'reload' bypasses the browser's HTTP cache, so a new release never
  // fills its cache with stale copies of the previous release's files.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fleet-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// Files shared to the app from another app on the phone (the Android share sheet) arrive as a POST to <scope>share-target.
// They are kept in this cache until the AI Inbox page picks them up and sends them for reading.
const SHARED = 'fm-shared-v1';

async function takeSharedFiles(req) {
  try {
    const form = await req.formData();
    const cache = await caches.open(SHARED);
    let n = 0;
    for (const f of form.getAll('file')) {
      if (!f || typeof f === 'string' || !f.size) continue;
      await cache.put('shared/' + Date.now() + '-' + (n++), new Response(f, {
        headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name || 'shared-file') },
      }));
    }
  } catch (e) { /* nothing was kept: the AI Inbox opens and says nothing is waiting */ }
  return Response.redirect(new URL('./#/inbox?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === self.location.origin && /\/share-target$/.test(url.pathname)) {
    event.respondWith(takeSharedFiles(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req))
  );
});
