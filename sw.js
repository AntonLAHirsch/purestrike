/**
 * PureStrike Service Worker
 * ─────────────────────────
 * Cache-first strategy with background update check.
 * When a new version is deployed to GitHub Pages, this worker
 * fetches it in the background and activates it on next app open.
 *
 * Deploy: upload sw.js to github.com/AntonLAHirsch/purestrike root
 * (same folder as index.html)
 */

const CACHE_NAME    = 'purestrike-v1';
const APP_SHELL     = [
  '/',
  '/index.html',
  '/icon.jpeg',
];

// ── Install: cache the app shell ─────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(APP_SHELL);
    }).then(() => self.skipWaiting()) // activate immediately
  );
});

// ── Activate: clean up old caches ────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim()) // take control of all open tabs
  );
});

// ── Fetch: serve from cache, update in background ────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Don't intercept Cloudflare Worker API calls — always go to network
  if (url.hostname.includes('workers.dev')) {
    return;
  }

  // Don't intercept Google Fonts — let browser handle caching
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('gstatic.com')) {
    return;
  }

  // For the app shell (index.html, icon) — cache first, update in background
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/icon.jpeg') {
    event.respondWith(cacheFirstWithBackgroundUpdate(event.request));
    return;
  }

  // Everything else — network first, fall back to cache
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

async function cacheFirstWithBackgroundUpdate(request) {
  const cache    = await caches.open(CACHE_NAME);
  const cached   = await cache.match(request);

  // Fetch fresh version in the background regardless
  const fetchPromise = fetch(request).then(async networkResponse => {
    if (networkResponse && networkResponse.status === 200) {
      // Check if content changed by comparing ETag or Last-Modified
      const cachedResponse = await cache.match(request);
      if (cachedResponse) {
        const cachedEtag  = cachedResponse.headers.get('etag');
        const networkEtag = networkResponse.headers.get('etag');
        const cachedDate  = cachedResponse.headers.get('last-modified');
        const networkDate = networkResponse.headers.get('last-modified');

        const changed = (networkEtag && cachedEtag && networkEtag !== cachedEtag) ||
                        (networkDate && cachedDate && networkDate !== cachedDate) ||
                        (!networkEtag && !cachedEtag); // no etag = always refresh
        if (changed) {
          await cache.put(request, networkResponse.clone());
          // Notify all open clients that a new version is available
          notifyClients('UPDATE_AVAILABLE');
        }
      } else {
        await cache.put(request, networkResponse.clone());
      }
    }
    return networkResponse;
  }).catch(() => null);

  // Return cached version immediately if available, otherwise wait for network
  if (cached) {
    fetchPromise; // run in background, don't await
    return cached;
  }

  return fetchPromise || new Response('Offline', { status: 503 });
}

async function notifyClients(type) {
  const allClients = await self.clients.matchAll({ includeUncontrolled: true });
  allClients.forEach(client => client.postMessage({ type }));
}
