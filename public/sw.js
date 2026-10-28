const CACHE_NAME = "joint-bob-v440";
const APP_SHELL = ["/", "/index.html", "/styles.css", "/focus.css", "/app/focus-ui.js", "/app/focus-creation-gestures.js", "/app/focus-project-controls.js", "/boot.js", "/client-logs.js", "/app.js", "/browser.html", "/browser.css", "/app/browser.js", "/app/browser-viewer.js", "/app/browser-login.js", "/app/browser-panel.js", "/app/browser-profile-access.js", "/app/browser-profiles-settings.js", "/app/api.js", "/app/usage-dashboard.js", "/app/usage-request.js", "/app/usage-format.js", "/app/usage-charts.js", "/app/usage-periods.js", "/app/usage-compare.js", "/app/usage-insights.js", "/app/usage-feature-reports.js", "/app/usage-insight-data.js", "/app/usage-skill-detail.js", "/app/usage-skill-suggestions-view.js", "/app/usage-changes.js", "/app/usage-changes-data.js", "/app/usage-progress.js", "/app/by-the-way.js", "/app/conversation-chat.js", "/app/attachments.js", "/app/auth.js", "/app/auto-respond.js", "/app/transcript-conflict.js", "/app/mfa.js", "/app/background-tasks.js", "/app/chat-controls.js", "/app/chat-time.js", "/app/classification.js", "/app/label-icons.js", "/app/cron.js", "/app/automation-tags.js", "/app/automation-tag-picker.js", "/app/dashboards.js", "/app/dashboard-picker.js", "/app/dashboard-creator.js", "/dashboards.css", "/app/chat-shortcuts.js", "/app/chat-transcript.js", "/app/activity-panel.js", "/app/activity-skill-draft.js", "/app/summary-model-settings.js", "/app/cluster-panel.js", "/app/cluster-sharing.js", "/app/cluster-budget.js", "/app/budget-dialog.js", "/app/cluster-canvas.js", "/app/cluster-twins.js", "/app/twin-skill-sync.js", "/app/cluster-filters.js", "/app/relay-ui.js", "/app/relay-serving.js", "/app/relay-memberships.js", "/app/webhooks.js", "/app/qr.js", "/app/fuzzy.js", "/app/multi-select.js", "/app/composer-dialogs.js", "/app/composer.js", "/app/saved-commands.js", "/app/command-sharing.js", "/app/elements.js", "/app/icons.js", "/app/layout.js", "/app/list-shortcuts.js", "/app/new-session.js", "/app/ntfy.js", "/app/ntfy-manage.js", "/app/ownership.js", "/app/project-files.js", "/app/project-explorer.js", "/app/git-review.js", "/app/project-git.js", "/app/project-git-url.js", "/app/project-issues.js", "/app/git-diff-view.js", "/app/git-story.js", "/app/git-story-diagram.js", "/app/git-story-dom.js", "/app/git-reviewer-options.js", "/app/git-hosting.js", "/app/project-forms.js", "/app/project-list.js", "/app/project-selection.js", "/app/quick-notes.js", "/app/focus-input.js", "/app/key-capture.js", "/app/recents.js", "/app/conversation-switcher.js", "/app/conversation-sharing.js", "/app/context-reference-draft.js", "/app/context-references.js", "/app/running.js", "/app/shortcut-settings.js", "/app/shortcut-hints.js", "/app/quick-tooltips.js", "/app/spotlight.js", "/app/reviews.js", "/app/resources.js", "/app/routing-configs.js", "/app/row-menu.js", "/app/searchable-select.js", "/app/secrets.js", "/app/ssh-session-import.js", "/app/session-identity.js", "/app/session-list.js", "/app/session-transfer.js", "/app/session-rows.js", "/app/settings.js", "/app/settings-search.js", "/app/shell.js", "/app/socket.js", "/app/transcript-diagnostics.js", "/app/error-reporting.js", "/app/error-reporting-settings.js", "/app/state.js", "/app/tasks.js", "/app/terminal.js", "/app/updates.js", "/app/workspaces.js", "/app/workspace-sharing.js", "/app/worktrees.js", "/canvas.js", "/canvas-layout.js", "/harness-metadata.js", "/board.js", "/composer-commands.js", "/markdown.js", "/file-view.js", "/vendor/codemirror/lib/codemirror.css", "/vendor/codemirror/addon/dialog/dialog.css", "/vendor/codemirror/lib/codemirror.js", "/vendor/codemirror/addon/dialog/dialog.js", "/vendor/codemirror/addon/search/searchcursor.js", "/vendor/codemirror/keymap/vim.js", "/vendor/codemirror/addon/mode/loadmode.js", "/vendor/codemirror/addon/mode/overlay.js", "/vendor/codemirror/addon/mode/multiplex.js", "/vendor/codemirror/addon/mode/simple.js", "/vendor/codemirror/mode/meta.js", "/vendor/codemirror/mode/xml/xml.js", "/vendor/codemirror/mode/markdown/markdown.js", "/vendor/codemirror/mode/gfm/gfm.js", "/vendor/xterm/xterm.js", "/vendor/xterm/xterm.css", "/vendor/xterm/addon-fit.js", "/manifest.webmanifest", "/assistant.html", "/assistant.js", "/icon.svg", "/icon-192.png", "/icon-512.png", "/app/node-admin.js", "/app/roaming.js", "/app/file-sync-settings.js", "/app/provider-profiles.js", "/app/provider-profile-picker.js"];


self.addEventListener("install", (event) => {
  // "reload" skips the browser's HTTP cache, so a new cache never stores an older file. Each file is
  // cached on its own: one refused or timed-out request (a busy relay gateway, a slow link) must not
  // fail the install and leave the previous worker, with its older cache, in charge.
  // Only the app page itself is required: without it the network is down, and the old worker stays.
  event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
    const results = await Promise.allSettled(APP_SHELL.map((url) => cache.add(new Request(url, { cache: "reload" }))));
    const page = results[APP_SHELL.indexOf("/")];
    if (page?.status === "rejected") throw page.reason;
  }));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const staleKeys = keys.filter((key) => key.startsWith("joint-bob-") && key !== CACHE_NAME);
    await Promise.all(staleKeys.map((key) => caches.delete(key)));
    await self.clients.claim();
    if (!staleKeys.length) return;
    const clients = await self.clients.matchAll({ type: "window" });
    await Promise.all(clients.map((client) => client.navigate(client.url)));
  })());
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
  if (request.method === "POST" && url.pathname === "/assistant-share") {
    event.respondWith((async () => {
      try {
        const data = await request.formData();
        const images = data.getAll("images").filter(file => file instanceof File && file.size);
        if (images.length > 4 || images.reduce((total, file) => total + file.size, 0) > 20 * 1024 * 1024) throw new Error("Too many screenshots (limit: four, 20 MiB)");
        const database = await new Promise((resolve, reject) => {
          const open = indexedDB.open("joint-bob-assistant-shares", 1);
          open.onupgradeneeded = () => open.result.createObjectStore("pending");
          open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
        });
        const id = crypto.randomUUID();
        await new Promise((resolve, reject) => {
          const transaction = database.transaction("pending", "readwrite");
          transaction.objectStore("pending").put({ title: String(data.get("title") || ""), text: String(data.get("text") || ""), url: String(data.get("url") || ""), images, createdAt: Date.now() }, id);
          transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
        });
        database.close();
        return Response.redirect(`/assistant.html?share=${encodeURIComponent(id)}`, 303);
      } catch (error) { return new Response(`Could not receive share: ${error.message}`, { status: 400, headers: { "Content-Type": "text/plain" } }); }
    })());
    return;
  }
  if (request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;
  // Offline answers come only from this release's cache. Another release's stylesheet under this
  // release's scripts draws a broken page, and the app page is no answer to a script or stylesheet.
  event.respondWith(fetch(request).catch(async () => {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(request)) || (request.mode === "navigate" && await cache.match("/")) || Response.error();
  }));
});
