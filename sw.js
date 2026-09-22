/* AirMark service worker — the app shell loads with no internet.
 *
 * Strategy: one release per load. Every shell file, index.html included, is
 * served from the cache THIS worker installed with (network only on a miss),
 * so a page never mixes scripts from two releases — a stale-while-revalidate
 * shell could hand out a new index.html with old scripts, or the reverse, and
 * break in ways no one can reproduce. A new release lands whole when the next
 * worker installs (the browser checks sw.js on every navigation; the cache is
 * named after the version so the switch is atomic), or straight away through
 * Home's "tap to update" pill, which empties the cache and reloads.
 * AroFlo / cloud calls and Home's ?live version probe are never cached.
 */
'use strict';

importScripts('js/version.js');                // APP_VERSION — one release number for the app and its shell cache
const CACHE = 'abmt-shell-' + APP_VERSION;
const CORE = [
  './',
  'index.html',
  'css/app.css',
  'js/version.js',
  'js/geometry.js', 'js/units.js', 'js/symbols.js', 'js/state.js',
  'js/store.js', 'js/viewer.js', 'js/render.js', 'js/loupe.js', 'js/tools.js',
  'js/props.js', 'js/markuplist.js', 'js/project.js', 'js/export.js', 'js/docket.js',
  'js/aroflo.js', 'js/cloud.js', 'js/drawings.js', 'js/home.js', 'js/app.js',
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
  if (url.searchParams.has('live')) return;         // Home's version probe must see the deployment, never this cache

  // every navigation (/, /?proj=…) is the shell page
  const key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(
    caches.open(CACHE)
      .then(c => c.match(key))
      .then(cached => cached || fetch(req).then(resp => {
        if (resp && resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {});
        }
        return resp;
      }))
  );
});
