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
  'api.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // No skipWaiting here: the page asks for it when the user taps "Update now".
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req))
  );
});
