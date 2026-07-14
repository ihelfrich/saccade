/* Saccade service worker: network-first with cache fallback, so it works offline. */
const CACHE = 'saccade-v4';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'common-words.js',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'icon-180.png', 'icon-512.png',
  'fonts/atkinson-hyperlegible-latin-400-normal.woff2',
  'fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  'fonts/atkinson-hyperlegible-latin-400-italic.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
