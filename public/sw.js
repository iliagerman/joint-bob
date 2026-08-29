const CACHE_NAME = "joint-bob-v51";
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
    tag: payload.url || "/",
    renotify: true,
    // A phone with the app closed only announces a conversation through the notification itself, so
    // it must ring and buzz rather than arrive silently.
    silent: false,
    vibrate: [200, 100, 200],
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: payload.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((openClients) => {
    const client = openClients.find((candidate) => candidate.url === targetUrl) || openClients[0];
    if (!client) return self.clients.openWindow(targetUrl);
    return client.navigate(targetUrl).then(() => client.focus());
  }));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;
  event.respondWith(fetch(request).catch(async () => (await caches.match(request)) || caches.match("/")));
});
