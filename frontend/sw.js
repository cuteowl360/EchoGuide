// Service worker — registered for PWA installability only.
// No caching: all requests go straight to the network so the app
// is always fresh and there is no startup lag from cache lookups.

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  // Clear any old caches left from previous versions
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  self.clients.claim();
});
