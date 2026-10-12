/**
 * Service worker.
 *
 * The app must open on a phone that has had no signal since the bus station,
 * so the shell is precached and always answered from cache first. But it is
 * stale-while-revalidate, not cache-forever: every load also fetches a fresh
 * copy in the background, so a fix reaches phones on their next visit rather
 * than whenever someone remembers to bump VERSION.
 *
 * API: only public, non-personal GETs are cached (map flags, schedule,
 * notices, crowd warnings). Responses that carry one person's alerts or
 * group are never written to the shared cache, where the next person to use
 * the same handset could be served them. The app keeps its own per-user
 * last-good copies in localStorage.
 *
 * The SOS POST is never cached or replayed here — that is the outbox's job in
 * api.js, which has the idempotency keys and the real retry policy. Background
 * sync replaying a POST the app has already retried is how you get duplicates.
 */

const VERSION = 'km-v16';
const TILES = 'km-tiles-v1';
const TILE_LIMIT = 800;
const TILE_HOSTS = ['tile.openstreetmap.org', 'server.arcgisonline.com'];

const SHELL = [
  '/',
  '/app/',
  '/app/app.js',
  '/app/wristband.html',
  '/app/wristband.js',
  '/shared/styles.css',
  '/shared/api.js',
  '/shared/dom.js',
  '/shared/i18n.js',
  '/shared/mela-map.js',
  '/shared/routing.js',
  '/shared/mapview.js',
  '/shared/mitra.js',
  '/shared/mesh.js',
  '/shared/qr.js',
  '/shared/livemap.js',
  '/shared/location.js',
  '/shared/guidance.js',
  '/shared/mapswitch.js',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/shared/icons.js',
  '/shared/theme.js',
  '/shared/theme-boot.js',
  '/shared/landing.js',
];

const PUBLIC_API = ['/api/map/flags', '/api/map/graph', '/api/content/schedule', '/api/content/notices', '/api/crowd/warnings'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function store(request, response) {
  // Never cache an error page or an opaque response as if it were the app.
  if (!response || !response.ok || response.type !== 'basic') return;
  const copy = response.clone();
  caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Map tiles: keep the ones this phone has already looked at, so the map of
  // the area around them still has a picture after the tower gives out. We
  // never bulk-download tiles — the OSM usage policy forbids it, and a real
  // deployment should ship its own pre-bundled tiles instead.
  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(TILES).then((cache) => cache.match(request).then((hit) => hit ?? fetch(request).then((response) => {
        if (response.ok || response.type === 'opaque') {
          cache.put(request, response.clone()).then(() => trimTiles(cache)).catch(() => {});
        }
        return response;
      })))
    );
    return;
  }

  if (url.origin !== location.origin) return;
  if (url.pathname === '/ws') return;

  if (url.pathname.startsWith('/api/')) {
    if (!PUBLIC_API.includes(url.pathname)) return; // personal or live: network only
    event.respondWith(
      fetch(request)
        .then((response) => { store(request, response); return response; })
        .catch(() => caches.match(request).then((hit) => hit ?? new Response('{}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })))
    );
    return;
  }

  // Stale-while-revalidate for the shell and everything else same-origin.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      const network = fetch(request)
        .then((response) => { store(request, response); return response; })
        .catch(() => hit ?? (request.mode === 'navigate' ? caches.match('/app/') : Response.error()));
      if (hit) {
        event.waitUntil(network.catch(() => {}));
        return hit;
      }
      return network;
    })
  );
});

/** A tapped alert notification focuses the volunteer queue (or opens it). */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/volunteer/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const want = new URL(url, self.location.origin).pathname;
    const open = windows.find((w) => new URL(w.url).pathname === want);
    if (open) return open.focus();
    return self.clients.openWindow(url);
  })());
});

let trimming = false;
/** Oldest-first eviction so the tile cache cannot fill the phone. */
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - TILE_LIMIT; i += 1) await cache.delete(keys[i]);
  } finally {
    trimming = false;
  }
}
