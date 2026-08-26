const CACHE_NAME = "joint-bob-v30";
const APP_SHELL = ["/", "/index.html", "/styles.css", "/boot.js", "/app.js", "/board.js", "/markdown.js", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(payload.title || "Pi finished", {
    body: payload.body || "Tap to open the conversation.",
    tag: payload.url || "joint-bob",
    renotify: true,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: payload.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      const client = windowClients.find((candidate) => candidate.url === targetUrl) || windowClients[0];
      if (client) {
        client.navigate(targetUrl);
        return client.focus();
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;
  event.respondWith(fetch(request).catch(() => caches.match(request).then((cached) => cached || caches.match("/"))));
});
