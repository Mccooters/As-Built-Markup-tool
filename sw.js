/* AirMark service worker — the app shell loads with no internet.
 *
 * Strategy: navigations are network-first (fresh deploys win when online)
 * with the cached shell as the offline fallback; static assets are
 * stale-while-revalidate (instant from cache, refreshed in the background).
 * AroFlo proxy calls are never cached — live data or nothing.
 */
'use strict';

const CACHE = 'abmt-shell-v3';
const CORE = [
  './',
  'index.html',
  'css/app.css',
  'js/geometry.js', 'js/units.js', 'js/symbols.js', 'js/state.js',
  'js/store.js', 'js/viewer.js', 'js/render.js', 'js/tools.js',
  'js/props.js', 'js/markuplist.js', 'js/project.js', 'js/export.js',
  'js/aroflo.js', 'js/cloud.js', 'js/app.js',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/pdf-lib.min.js', 'vendor/zxing.min.js',
  'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(CORE.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;       // CDN-free app; leave cross-origin alone
  if (url.pathname.includes('/api/')) return;       // AroFlo proxy: live data or nothing

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put('index.html', copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => {
      const refresh = fetch(req).then(resp => {
        if (resp && resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => cached);
      return cached || refresh;
    })
  );
});
