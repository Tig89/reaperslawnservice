/**
 * Battle Plan - Service Worker v3
 * Network-first strategy: always fetch fresh when online, cache for offline
 */

const CACHE_NAME = 'battle-plan-v13';
const BASE_PATH = '/reaperslawnservice';
const ASSETS_TO_CACHE = [
  `${BASE_PATH}/`,
  `${BASE_PATH}/index.html`,
  `${BASE_PATH}/manifest.json`,
  `${BASE_PATH}/css/styles.css`,
  `${BASE_PATH}/js/groq.js`,
  `${BASE_PATH}/js/db.js`,
  `${BASE_PATH}/js/app.js`,
  `${BASE_PATH}/js/sw-register.js`,
  `${BASE_PATH}/icons/icon.svg`
];

// Install event - cache assets and skip waiting immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

// Activate event - delete ALL old caches and take control immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - NETWORK FIRST, fall back to cache when offline
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Got a fresh response - cache it for offline use
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(event.request, responseToCache));
        }
        return response;
      })
      .catch(() => {
        // Network failed - serve from cache (offline mode)
        return caches.match(event.request)
          .then((cachedResponse) => {
            if (cachedResponse) return cachedResponse;
            // Offline fallback for navigation
            if (event.request.mode === 'navigate') {
              return caches.match(`${BASE_PATH}/index.html`);
            }
          });
      })
  );
});
