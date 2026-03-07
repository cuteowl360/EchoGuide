const CACHE_NAME = "echoguide-v1";
const ASSETS = [
  "/",
  "/static/style.css",
  "/static/app.js",
  "/static/guide.js",
  "/static/navigation.js",
  "/static/voice.js",
  "/static/manifest.webmanifest",
  "/static/icon-192.png",
  "/static/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          if (!res || res.status !== 200 || res.type !== "basic") return res;
          const respClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, respClone));
          return res;
        })
        .catch(() => caches.match("/") || caches.match("/static/app.js"));
    })
  );
});
