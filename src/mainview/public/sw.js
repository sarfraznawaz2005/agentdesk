// Minimal PWA service worker (TASK-489): offline app shell + runtime caching.
//
// Caches same-origin GET responses so the static shell loads offline (it then
// shows the "desktop offline" banner). Data flows over WebSocket to the relay,
// which is NOT a fetch and is never cached — so there is no stale-data risk.
const CACHE = "agentdesk-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop old cache versions.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || !req.url.startsWith(self.location.origin)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      // Navigations: prefer fresh (fall back to cached shell offline).
      // Assets: prefer cache, refresh in the background.
      return req.mode === "navigate" ? (await network) || cached : cached || network;
    })(),
  );
});
