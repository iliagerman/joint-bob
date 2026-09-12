import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Page, type WebSocketRoute } from "playwright-core";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Settings lists paired browser machines and saves the independent default", async () => {
  const source = await readFile("public/app/browser.js", "utf8");
  const status = { textContent: "" };
  const check = { disabled: false, addEventListener() {} };
  const select = { value: "", disabled: false, children: [] as any[], handlers: {} as Record<string, Function>,
    replaceChildren(...children: any[]) { this.children = children; }, addEventListener(name: string, handler: Function) { this.handlers[name] = handler; } };
  const requests: { url: string; body: any }[] = [];
  const state: { activeNodeId: string | null } = { activeNodeId: "owner" };
  let saveGate: Promise<void> | undefined;
  let result: any = { config: { executorNodeId: "mac" }, nodes: [
    { id: "mac", name: "Mac laptop", available: true, reachable: true, runningCount: 2 },
    { id: "linux", name: "Ubuntu", available: true, reachable: true, runningCount: 0 },
    { id: "offline", name: "Offline", available: false, reachable: false, reason: "Unreachable", runningCount: 0 },
  ] };
  const context = runInNewContext(`${source.replace(/^import .*;\n/gm, "").replace(/export /g, "")}\n({ load: loadBrowserStatus })`, {
    URLSearchParams,
    api: async (url: string, options: any = {}) => { requests.push({ url, body: options.body && JSON.parse(options.body) }); if (url === "/api/browser/config") { await saveGate; result.config.executorNodeId = JSON.parse(options.body).executorNodeId; } if (result instanceof Error) throw result; return result; },
    Option: class { disabled = false; constructor(public label: string, public value: string) {} }, toast() {},
    document: { querySelector: (selector: string) => selector === "#browserStatus" ? status : selector === "#browserStatusCheck" ? check : select, body: {} },
    state, elements: { openBrowserButton: check, expandProjectsButton: check, expandChatsButton: check },
    MutationObserver: class { observe() {} }, window: { addEventListener() {} },
  });
  await context.load();
  assert.equal(requests[0].url, "/api/browser/status");
  assert.match(status.textContent, /Mac laptop: Ready/);
  assert.match(status.textContent, /2 running/);
  assert.equal(select.value, "mac");
  assert.equal(select.children.find(option => option.value === "linux").disabled, false);
  assert.equal(select.children.find(option => option.value === "offline").disabled, true);
  select.value = "linux"; await select.handlers.change({ currentTarget: select });
  assert.deepEqual(requests.find(request => request.url === "/api/browser/config")!.body, { executorNodeId: "linux" });
  let release!: () => void;
  saveGate = new Promise(resolve => { release = resolve; });
  select.value = "mac";
  const saving = select.handlers.change({ currentTarget: select });
  try {
    const count = requests.length;
    await context.load();
    assert.equal(requests.length, count, "Tab re-entry must not load stale Settings during save");
    assert.equal(select.disabled, true);
    assert.equal(check.disabled, true);
    assert.equal(select.value, "mac");
  } finally { release(); await saving; }
  assert.equal(select.value, "mac");
  assert.equal(select.disabled, false);
  state.activeNodeId = null;
  await context.load();
  assert.equal(requests.at(-1)!.url, "/api/browser/status");
  result = new Error("Node offline");
  await context.load();
  assert.match(status.textContent, /Node offline/);
  assert.equal(check.disabled, false);
});

test("local browser identity closes viewer when owner node changes", async () => {
  const source = await readFile("public/app/browser.js", "utf8");
  let disposed = 0;
  const button = { addEventListener() {}, setAttribute() {} };
  const state = { activeProjectId: "project", engine: "pi", activeConversationId: "conversation", activeNodeId: "one" };
  const context = runInNewContext(`${source.replace(/^import .*;\n/gm, "").replace(/export /g, "")}\nviewer = { dispose() { recordDispose(); } }; viewerKey = identityKey(browserIdentity()); ({ syncBrowserButton })`, {
    state, recordDispose: () => disposed++, elements: { openBrowserButton: button, expandProjectsButton: button, expandChatsButton: button },
    document: { querySelector: () => button, body: { classList: { remove() {} } } },
    MutationObserver: class { observe() {} }, window: { addEventListener() {} },
  });
  context.syncBrowserButton(); assert.equal(disposed, 0);
  state.activeNodeId = "two";
  context.syncBrowserButton(); assert.equal(disposed, 1);
});

test("local browser viewer routes HTTP, downloads and WebSocket to owner", async () => {
  const source = await readFile("public/app/browser-viewer.js", "utf8");
  const nodes = new Map<string, any>();
  function element() {
    return { dataset: {}, value: "", hidden: false, children: [] as any[], handlers: {} as Record<string, Function>,
      classList: { add() {} }, setAttribute() {}, querySelectorAll: () => [],
      append(...children: any[]) { this.children.push(...children); },
      replaceChildren(...children: any[]) { this.children = children; },
      addEventListener(name: string, handler: Function) { this.handlers[name] = handler; },
    };
  }
  const root = { ...element(), querySelector(selector: string) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); } };
  const get = (name: string) => root.querySelector(`[data-testid="browser-${name}"]`);
  const requests: URL[] = [], sockets: any[] = [];
  const session = { id: "session", state: "running", owner: "human", canControl: true, projectId: "project", engine: "pi", conversationId: "conversation", appNodeId: "owner node", nodeId: "browser node", activePageId: "page", tabs: [], downloads: [{ id: "download", name: "file.txt", ready: true }] };
  class Socket {
    handlers: Record<string, Function> = {};
    constructor(public url: URL) { sockets.push(this); }
    addEventListener(name: string, handler: Function) { this.handlers[name] = handler; }
    close() {}
  }
  const { createBrowserViewer } = runInNewContext(`${source.replace(/export /g, "")}\n({ createBrowserViewer })`, {
    URL, URLSearchParams, location: { href: "https://app.example/browser.html", protocol: "https:" },
    document: { querySelector: () => null, documentElement: { dataset: {} }, createElement: element, createRange: () => ({ createContextualFragment: () => ({}) }) },
    Option: class { constructor(public label: string, public value: string) {} }, WebSocket: Socket,
    setTimeout: () => 1, clearTimeout() {},
  });
  const identity = { projectId: "project", engine: "pi", conversationId: "conversation", appNodeId: "owner node" };
  const viewer = createBrowserViewer(root, { identity, confirm: async () => true, api: async (path: string) => {
    const url = new URL(path, "https://app.example"); requests.push(url);
    if (url.pathname === "/api/browser/status") return { config: { executorNodeId: session.nodeId }, nodes: [{ id: session.nodeId, name: "Mac", reachable: true, available: true }] };
    if (url.pathname === "/api/browser/preferences") return { nodeId: null, effectiveNodeId: session.nodeId };
    if (url.pathname === "/api/browser/profiles") return { profiles: [{ id: "profile", label: "Login" }] };
    if (url.pathname === "/api/browser/sessions") return { sessions: [session], session };
    return { session };
  } });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  assert.equal(requests.length, 4);
  assert.equal(sockets[0].url.searchParams.get("nodeId"), session.nodeId);
  assert.equal(sockets[0].url.searchParams.get("mode"), "browser");
  const link = new URL(get("open-tab").href, "https://app.example");
  assert.equal(link.searchParams.get("appNodeId"), identity.appNodeId);
  const download = new URL(get("downloads-list").children[0].children[0].href, "https://app.example");
  assert.equal(download.searchParams.get("nodeId"), session.nodeId);
  sockets[0].handlers.message({ data: JSON.stringify({ type: "browserState", session }) });
  await get("resume-agent").handlers.click(); await settle();
  await get("profiles-list").children[0].children[1].handlers.click(); await settle();
  await get("reconnect").handlers.click(); await settle();
  session.state = "closed";
  sockets.at(-1).handlers.message({ data: JSON.stringify({ type: "browserState", session }) });
  await get("start").handlers.click(); await settle();
  assert.ok(requests.some(url => url.pathname.endsWith("/command")));
  assert.ok(requests.some(url => url.pathname.endsWith("/profiles/profile")));
  assert.ok(requests.some(url => url.pathname.endsWith("/sessions/session")));
  for (const url of requests.filter(url => /\/sessions\/|\/profiles/.test(url.pathname))) assert.equal(url.searchParams.get("nodeId"), session.nodeId, url.href);
  viewer.dispose();
});

async function standaloneViewer(search: string, appNodeId: string) {
  const source = await readFile("public/app/browser-viewer.js", "utf8");
  const nodes = new Map<string, any>(), requests: { url: URL; options: any }[] = [], sockets: any[] = [];
  function element() {
    return { dataset: {}, value: "", hidden: false, children: [] as any[], handlers: {} as Record<string, Function>,
      classList: { add() {} }, setAttribute() {}, querySelectorAll: () => [],
      append(...children: any[]) { this.children.push(...children); },
      replaceChildren(...children: any[]) { this.children = children; },
      addEventListener(name: string, handler: Function) { this.handlers[name] = handler; },
    };
  }
  const root = { ...element(), querySelector(selector: string) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); } };
  const get = (name: string) => root.querySelector(`[data-testid="browser-${name}"]`);
  const session = { id: "session", projectId: "project", engine: "pi", conversationId: "conversation", appNodeId, nodeId: "browser-node",
    state: "running", owner: "agent", activePageId: "page", tabs: [], downloads: [{ id: "download", name: "file.txt", ready: true }] };
  const windowHandlers: Record<string, Function> = {};
  class Socket {
    handlers: Record<string, Function> = {};
    constructor(public url: URL) { sockets.push(this); }
    addEventListener(name: string, handler: Function) { this.handlers[name] = handler; }
    close() {}
  }
  runInNewContext(source.replace(/export /g, ""), {
    URL, URLSearchParams, location: new URL(`https://app.example/browser.html?${search}`),
    document: { querySelector: (selector: string) => selector === "[data-browser-standalone]" ? root : null,
      documentElement: { dataset: {} }, createElement: element, createRange: () => ({ createContextualFragment: () => ({}) }) },
    window: { addEventListener(name: string, handler: Function) { windowHandlers[name] = handler; } },
    Option: class { constructor(public label: string, public value: string) {} }, WebSocket: Socket,
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (path: string, options: any) => {
      const url = new URL(path, "https://app.example"); requests.push({ url, options });
      const body = url.pathname === "/api/auth/status" ? { authenticated: true, csrfToken: "csrf" }
        : url.pathname === "/api/browser/status" ? { config: { executorNodeId: session.nodeId }, nodes: [{ id: session.nodeId, name: "Ubuntu", available: true, reachable: true }] }
        : url.pathname === "/api/browser/preferences" ? { nodeId: null, effectiveNodeId: session.nodeId }
        : url.pathname === "/api/browser/profiles" ? { profiles: [] } : { session: { ...session }, sessions: [{ ...session }] };
      return { ok: true, status: 200, json: async () => body };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { get, session, requests, sockets, dispose: () => windowHandlers.pagehide() };
}

for (const nodeId of [null, "22222222-2222-4222-8222-222222222222"]) {
  test(`local browser standalone ${nodeId ? "explicit remote nodeId" : "session-ID-only"} routes and restarts`, async () => {
    const appNodeId = nodeId || "11111111-1111-4111-8111-111111111111";
    const params = new URLSearchParams(nodeId ? { browserSessionId: "session", projectId: "project", engine: "pi", conversationId: "conversation", appNodeId } : { browserSessionId: "session" });
    if (nodeId) params.set("nodeId", nodeId);
    const f = await standaloneViewer(params.toString(), appNodeId);
    try {
      const first = f.requests[1].url;
      assert.equal(first.pathname, "/api/browser/sessions/session");
      assert.equal(first.searchParams.get("nodeId"), nodeId, "Legacy exact lookup resolves physical owner before scoped discovery");
      assert.equal(f.sockets[0].url.searchParams.get("nodeId"), f.session.nodeId);
      const download = new URL(f.get("downloads-list").children[0].children[0].href, "https://app.example");
      assert.equal(download.searchParams.get("nodeId"), f.session.nodeId);
      const link = new URL(f.get("open-tab").href, "https://app.example");
      assert.equal(link.searchParams.get("appNodeId"), appNodeId);
      assert.equal(link.searchParams.get("nodeId"), f.session.nodeId, "physical owner stays separate from appNodeId");
      f.session.state = "closed";
      f.sockets[0].handlers.message({ data: JSON.stringify({ type: "browserState", session: f.session }) });
      assert.equal(f.get("start").disabled, false, "loaded metadata must enable restart without conversation URL parameters");
      f.session.state = "running";
      await f.get("start").handlers.click();
      const start = f.requests.find(request => request.options.method === "POST")!;
      assert.equal(start.url.pathname, "/api/browser/sessions");
      assert.deepEqual(JSON.parse(start.options.body), { projectId: "project", engine: "pi", conversationId: "conversation", appNodeId });
      assert.equal(start.options.headers["X-CSRF-Token"], "csrf");
      assert.equal(start.url.searchParams.has("nodeId"), false, "inherited starts resolve server-side");
      assert.equal(f.sockets.at(-1).url.searchParams.get("nodeId"), f.session.nodeId);
    } finally { f.dispose(); }
  });
}

// Only the new browser API is stubbed. Authentication, app state, conversation
// selection and rendering run against the real isolated dev node.
test("browser viewer UI", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-ui-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: process.env.CHROME_CHANNEL ?? "chrome" }), headless: true });
  } catch (error) { await stopDevNode(server); await rm(root, { recursive: true, force: true }); throw error; }
  const pageErrors: string[] = [];
  const executorId = "11111111-1111-4111-8111-111111111111";
  const pageId = "22222222-2222-4222-8222-222222222222";
  const profileId = "33333333-3333-4333-8333-333333333333";
  async function setup() {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
    page.on("pageerror", (error) => { pageErrors.push(error.message); console.error("browser-ui page error:", error.message); });
    page.on("console", (message) => { if (message.type() === "error") console.error("browser-ui console:", message.text()); });
    page.on("requestfailed", (request) => console.error("browser-ui request failed:", request.url(), request.failure()));
    const commands: any[] = [], starts: any[] = [], queries: URL[] = [], requests: URL[] = [];
    let defaultNodeId = node.nodeId, conversationNodeId: string | null = null;
    let profileGate: Promise<void> | undefined, configGate: Promise<void> | undefined;
    const sessions: any[] = [];
    let profiles = [{ id: profileId, projectId: "unused", label: "Work login", persistent: true, nodeId: node.nodeId }];
    let socket: WebSocketRoute | undefined;
    let viewedSessionId: string;
    let connections = 0, unavailable = false;
    const frame = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 800;
      const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#eee"; ctx.fillRect(0, 0, 1200, 800);
      ctx.fillStyle = "#17191b"; ctx.font = "32px sans-serif"; ctx.fillText("Owner node browser", 80, 120);
      return canvas.toDataURL("image/jpeg").split(",")[1];
    });
    function sendState() { const session = sessions.find(item => item.id === viewedSessionId); if (socket && session) socket.send(JSON.stringify({ type: "browserState", session })); }
    function sendFrame(id = pageId, data = frame) { socket?.send(JSON.stringify({ type: "browserFrame", pageId: id, data, width: 1200, height: 800 })); }
    function apply(command: any, id = viewedSessionId) {
      commands.push(command);
      const session = sessions.find(item => item.id === id);
      if (command.action === "takeControl") session.owner = "human";
      if (command.action === "resumeAgent") session.owner = "agent";
      if (command.action === "close") session.state = "closed";
      if (command.action === "dialog") session.dialog = null;
      if (command.action === "upload") session.fileChooser = false;
      if (command.action === "newTab") { session.tabs.push({ id: profileId, url: "about:blank", title: "Popup" }); session.activePageId = profileId; }
      if (command.action === "selectTab") session.activePageId = command.pageId;
      if (command.action === "saveProfile") { profiles.find(profile => profile.id === session.profileId)!.label = command.label; session.profileLabel = command.label; }
      sendState();
      return session;
    }
    await page.route("**/api/browser/**", async (route) => {
      const request = route.request(), url = new URL(request.url());
      requests.push(url);
      if (/\/sessions\//.test(url.pathname) && (url.searchParams.has("nodeId") || request.method() !== "GET")) assert.equal(url.searchParams.get("nodeId"), sessions.find(session => session.id === url.pathname.split("/")[4]).nodeId, url.href);
      const method = request.method();
      const body = request.postDataJSON();
      let result: any;
      if (url.pathname === "/api/browser/status") {
        if (unavailable) return route.fulfill({ status: 503, json: { error: "Node offline" } });
        result = { config: { executorNodeId: defaultNodeId }, nodes: [{ id: node.nodeId, name: "Mac laptop", available: true, reachable: true, runningCount: sessions.length }, { id: executorId, name: "Ubuntu", available: true, reachable: true, runningCount: 0 }] };
      } else if (url.pathname === "/api/browser/preferences") {
        if (method === "PUT") conversationNodeId = body.nodeId;
        result = { nodeId: conversationNodeId, effectiveNodeId: conversationNodeId || defaultNodeId };
      } else if (url.pathname === "/api/browser/config") { if (configGate) await configGate; defaultNodeId = body.executorNodeId; result = { executorNodeId: defaultNodeId }; }
      else if (url.pathname === "/api/browser/profiles") {
        if (profileGate) await profileGate;
        result = { profiles: profiles.filter(profile => profile.nodeId === url.searchParams.get("nodeId")) };
      }
      else if (url.pathname.startsWith("/api/browser/profiles/") && method === "DELETE") {
        const id = url.pathname.split("/").at(-1);
        if (sessions.some(session => session.profileId === id && session.state === "running")) return route.fulfill({ status: 409, json: { error: "Profile is in use" } });
        profiles = profiles.filter((profile) => profile.id !== id); result = {};
      } else if (url.pathname === "/api/browser/sessions" && method === "GET") {
        queries.push(url); result = { sessions: sessions.filter((session) => session.conversationId === url.searchParams.get("conversationId")) };
      } else if (url.pathname === "/api/browser/sessions" && method === "POST") {
        starts.push(body);
        const ownerNodeId = url.searchParams.get("nodeId") || conversationNodeId || defaultNodeId;
        const profile = body.profileId ? profiles.find(profile => profile.id === body.profileId)!
          : { id: `profile-${sessions.length + 1}`, projectId: body.projectId, label: body.profileName || "Default", persistent: true, nodeId: ownerNodeId };
        if (!body.profileId) profiles.push(profile);
        const session = { ...body, nodeId: ownerNodeId, profileId: profile.id, profileLabel: profile.label, restoreOnRestart: true, id: `browser-${sessions.length + 1}`, state: "running", owner: "agent", activePageId: pageId,
          tabs: [{ id: pageId, title: "Example", url: "https://example.com" }], downloads: [], fileChooser: false, dialog: null };
        sessions.push(session); result = { session };
      } else if (url.pathname.endsWith("/command")) {
        const id = url.pathname.split("/").at(-2);
        if (body.action === "close" && sessions.find(session => session.id === id).owner !== "human") return route.fulfill({ status: 409, json: { error: "Take control before browser input" } });
        result = { result: {}, session: apply(body, id) };
      }
      else result = { session: sessions.find((session) => session.id === url.pathname.split("/").at(-1)) };
      return route.fulfill({ json: result });
    });
    await page.routeWebSocket(/\/ws\?mode=browser/, (ws) => {
      const params = new URL(ws.url()).searchParams;
      assert.equal(params.get("nodeId"), sessions.find(session => session.id === params.get("browserSessionId")).nodeId);
      socket = ws; viewedSessionId = new URL(ws.url()).searchParams.get("browserSessionId")!; connections++; sendState(); sendFrame();
      ws.onMessage((message) => apply(JSON.parse(String(message)).command));
    });
    const login = await signIn(environment, node);
    await page.context().addCookies(login.cookie.split("; ").map((cookie) => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
    await page.goto(node.url);
    try { await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click(); }
    catch (error) { console.error("browser-ui boot:", await page.locator("body").innerText()); throw error; }
    return { page, commands, starts, sessions, queries, requests, sendState, sendFrame, setDefault: (id: string) => { defaultNodeId = id; }, delayConfig: (gate: Promise<void>) => { configGate = gate; }, delayProfiles: (gate: Promise<void>) => { profileGate = gate; }, disconnect: () => socket?.close(), connections: () => connections, offline: () => { unavailable = true; } };
  }
  async function openConversation(page: Page, title = "Short one") {
    await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: title }) }).first().click();
    await page.locator("#sessionTitle").filter({ hasText: title }).waitFor();
    if (await page.getByTestId("chat-more-button").isVisible()) await page.getByTestId("chat-more-button").click();
    assert.equal(await page.getByTestId("chat-open-browser-button").count(), 1, "conversation controls need Browser action");
    await page.getByTestId("chat-open-browser-button").click();
  }
  try {
    for (const configured of [true, false]) await t.test(`empty viewer explains setup with machine configured=${configured}`, async () => {
      const f = await setup();
      try {
        if (!configured) f.setDefault("");
        await openConversation(f.page);
        await f.page.getByTestId("browser-session-status").filter({ hasText: "No browser selected" }).waitFor();
        const hint = await f.page.locator('[data-part="frame-hint"]').innerText();
        assert.match(hint, configured ? /Choose a project profile/ : /Choose a browser machine in Machine settings/);
        assert.equal(await f.page.getByTestId("browser-end").isDisabled(), true);
        assert.equal(await f.page.getByTestId("browser-start").isDisabled(), !configured);
      } finally { await f.page.close(); }
    });
    for (const width of [1600, 390]) await t.test(`compact viewer geometry at ${width}px`, async () => {
      const f = await setup();
      try {
        await openConversation(f.page); await f.page.getByTestId("browser-start").click();
        await f.page.getByTestId("browser-screen").waitFor();
        const link = await f.page.getByTestId("browser-open-tab").getAttribute("href");
        await f.page.goto(`${node.url}${link}`);
        await f.page.setViewportSize({ width, height: 1000 });
        await f.page.getByTestId("browser-screen").waitFor();
        await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const heading = (await f.page.locator(".browser-heading").boundingBox())!;
        const stop = (await f.page.getByTestId("browser-end").boundingBox())!;
        assert.ok(stop.y >= heading.y && stop.y + stop.height <= heading.y + heading.height, "Stop browser must stay in the header, not below the page");
        assert.equal(await f.page.getByTestId("browser-end").innerText(), "Stop browser");
        assert.equal(await f.page.getByTestId("browser-conversation-node").isVisible(), false, "Advanced machine overrides start collapsed");
        assert.equal(await f.page.getByTestId("browser-profile-label").isVisible(), false, "Profile management starts collapsed");
        assert.equal(await f.page.getByTestId("browser-session-select").isVisible(), true);
        const profile = (await f.page.getByTestId("browser-profile-select").boundingBox())!;
        const start = (await f.page.getByTestId("browser-start").boundingBox())!;
        assert.ok(Math.abs(profile.y + profile.height - start.y - start.height) < 2, "Profile and Start align on one compact row");
        const stage = (await f.page.locator(".browser-stage").boundingBox())!;
        assert.ok(stage.y < 500 && stage.height >= 350, `Browser stage must dominate: ${JSON.stringify(stage)}`);
        assert.ok(await f.page.locator(".browser-body").evaluate(el => el.scrollWidth <= el.clientWidth), "No internal horizontal overflow");
        await f.page.screenshot({ path: path.resolve(`tmp/restyle-${width}.png`) });
        await f.page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
        await f.page.screenshot({ path: path.resolve(`tmp/restyle-${width}-dark.png`), animations: "disabled" });
      } finally { await f.page.close(); }
    });
    await t.test("closed viewer hides input and reopens selected account on its owner", async () => {
      const f = await setup();
      try {
        await openConversation(f.page); await f.page.getByTestId("browser-start").click();
        await f.page.getByTestId("browser-screen").waitFor();
        const original = { ...f.sessions[0] };
        f.sessions[0].state = "closed"; f.sessions[0].restoreOnRestart = false;
        f.setDefault(executorId); f.sendState();
        // Discover the closed account at its actual owner, with a different inherited default.
        await f.page.getByTestId("browser-reconnect").click();
        await f.page.getByTestId("browser-session-select").selectOption(original.id);
        await f.page.getByTestId("browser-session-status").filter({ hasText: "closed" }).waitFor();
        assert.equal(await f.page.getByTestId("browser-url").isVisible(), false, "Closed browser must hide navigation");
        assert.equal(await f.page.getByTestId("browser-send-tab").isVisible(), false, "Closed browser must hide keyboard input");
        assert.equal(await f.page.getByTestId("browser-take-control").isVisible(), false);
        assert.equal(await f.page.getByTestId("browser-reconnect").isEnabled(), true);
        await f.page.screenshot({ path: path.resolve("tmp/restyle-closed.png") });
        await f.page.getByRole("button", { name: "Reopen browser", exact: true }).click();
        await f.page.getByTestId("browser-screen").waitFor();
        assert.equal(f.sessions.at(-1).nodeId, original.nodeId);
        assert.deepEqual(f.starts[1], { projectId: original.projectId, conversationId: original.conversationId, engine: original.engine, appNodeId: original.appNodeId, profileId: original.profileId });
        assert.equal(await f.page.getByTestId("browser-start-node").inputValue(), "");
        assert.equal(await f.page.getByTestId("browser-conversation-node").inputValue(), "");
      } finally { await f.page.close(); }
    });
    await t.test("Settings shows Mac and Ubuntu choices and reports offline errors", async () => {
      const f = await setup();
      try {
        await f.page.getByTestId("settings-open-button").click();
        await f.page.getByTestId("settings-tab-cluster").click();
        await f.page.getByTestId("browser-status").filter({ hasText: "Mac laptop: Ready" }).waitFor();
        const select = f.page.getByTestId("settings-browser-executor");
        assert.deepEqual(await select.locator("option").allTextContents(), ["Not configured", "Mac laptop", "Ubuntu"]);
        let release!: () => void;
        f.delayConfig(new Promise(resolve => { release = resolve; }));
        try {
          const saving = f.page.waitForRequest(request => new URL(request.url()).pathname === "/api/browser/config");
          await select.selectOption(executorId); await saving;
          const statusRequests = f.requests.filter(url => url.pathname === "/api/browser/status").length;
          await f.page.getByTestId("settings-tab-account").click();
          await f.page.getByTestId("settings-tab-cluster").click();
          assert.equal(await select.isDisabled(), true, "Tab re-entry must retain save lock");
          assert.equal(await select.inputValue(), executorId);
          assert.equal(f.requests.filter(url => url.pathname === "/api/browser/status").length, statusRequests);
        } finally { release(); }
        await f.page.getByText("Default browser machine saved. Existing accounts are unchanged.", { exact: true }).waitFor();
        await f.page.waitForFunction(() => !(document.querySelector("#settingsBrowserExecutor") as HTMLSelectElement).disabled);
        assert.equal(await select.inputValue(), executorId);
        f.offline();
        await f.page.getByTestId("browser-status-check").click();
        await f.page.getByTestId("browser-status").filter({ hasText: "Node offline" }).waitFor();
        assert.equal(await f.page.locator("#settingsDialog").isVisible(), true);
      } finally { await f.page.close(); }
    });
    await t.test("expanding side panels leaves the browser viewer open", async () => {
      const f = await setup();
      try {
        await openConversation(f.page);
        await f.page.getByTestId("browser-close-viewer").click();
        await f.page.getByTestId("projects-panel-collapse-button").click();
        await f.page.getByTestId("chats-panel-collapse-button").click();
        await f.page.keyboard.press("Control+Alt+B");
        await f.page.locator("#browserPanel").waitFor();

        await f.page.getByTestId("projects-panel-expand-button").click();
        assert.equal(await f.page.locator("#browserPanel").count(), 1, "expanding projects must not close browser viewer");
        assert.equal(await f.page.locator("#projectsPanel .panel-bar").isVisible(), true);

        await f.page.getByTestId("chats-panel-expand-button").click();
        assert.equal(await f.page.locator("#browserPanel").count(), 1, "expanding conversations must not close browser viewer");
        assert.equal(await f.page.locator("#chatsPanel .panel-bar").isVisible(), true);
      } finally {
        await f.page.evaluate(async () => {
          const { setPanelCollapsed } = await import("/app/layout.js" as string);
          setPanelCollapsed("projects", false);
          setPanelCollapsed("chats", false);
        });
        await f.page.close();
      }
    });
    await t.test("viewer reconnects by conversation, scales input, gates control, and closes without ending", async () => {
      const f = await setup();
      try {
        await openConversation(f.page);
        await f.page.getByTestId("browser-start").waitFor();
        assert.equal(f.starts.length, 0, "opening viewer must not create a browser");
        await f.page.getByTestId("browser-profile-select").selectOption(profileId);
        await f.page.getByTestId("browser-start").click();
        const screen = f.page.getByTestId("browser-screen");
        await screen.waitFor();
        await f.page.waitForFunction(() => (document.querySelector('[data-testid="browser-screen"]') as HTMLImageElement)?.naturalWidth === 1200);
        const identity = await f.page.evaluate(async () => {
          const { state } = await import("/app/state.js" as string);
          return { projectId: state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.activeNodeId };
        });
        assert.deepEqual(f.starts[0], { ...identity, profileId });
        assert.equal(f.queries[0].searchParams.has("sessionPath"), false);
        await screen.click();
        assert.equal(f.commands.filter((command) => command.action === "click").length, 0, "agent-owned viewer must reject human input");
        await f.page.getByTestId("browser-take-control").click();
        await f.page.getByTestId("browser-control-status").filter({ hasText: "Human control" }).waitFor();
        const box = (await screen.boundingBox())!;
        const chatBox = (await f.page.locator("#chatPanel").boundingBox())!;
        assert.ok(chatBox.x + chatBox.width <= box.x, "desktop browser belongs beside conversation, not over it");
        assert.ok(box.width >= 400, `remote image should remain usable: ${box.width}px`);
        await f.page.screenshot({ path: "/tmp/browser-ui-desktop.png" });
        await screen.click({ position: { x: box.width / 2, y: box.height / 2 } });
        await f.page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "browser-screen");
        await screen.press("Control+a");
        await screen.evaluate((el) => { const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", "pasted text"); el.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true })); });
        await f.page.getByTestId("browser-url").fill("https://example.org");
        await f.page.getByTestId("browser-url").press("Enter");
        await f.page.getByTestId("browser-control-status").waitFor();
        assert.ok(f.commands.some((c) => c.action === "click" && Math.abs(c.x - 600) < 3 && Math.abs(c.y - 400) < 3), JSON.stringify(f.commands));
        assert.ok(f.commands.some((c) => c.action === "key" && c.key === "Control+a"));
        assert.ok(f.commands.some((c) => c.action === "text" && c.text === "pasted text"));
        const src = await screen.getAttribute("src");
        f.sendFrame("not-current-page", "AAAA");
        await f.page.getByTestId("browser-url").focus();
        assert.equal(await screen.getAttribute("src"), src, "frames from inactive tabs are ignored");
        f.sessions[0].dialog = { id: executorId, pageId, type: "prompt", message: "Your name?", defaultValue: "Bob" };
        f.sessions[0].fileChooser = true;
        f.sessions[0].fileChooserRequest = { id: profileId, pageId };
        f.sessions[0].downloads = [{ id: "download-1", name: "report.pdf", ready: true }];
        f.sendState();
        await f.page.getByTestId("browser-dialog-input").fill("Alice");
        await f.page.getByTestId("browser-dialog-accept").click();
        await f.page.getByTestId("browser-upload").setInputFiles({ name: "sample.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
        await f.page.getByTestId("browser-upload-status").filter({ hasText: "Uploaded" }).waitFor();
        assert.ok(f.commands.some((c) => c.action === "upload" && c.files[0].data === "aGVsbG8=" && c.expectedPageId === pageId && c.requestId === profileId));
        const download = new URL((await f.page.getByTestId("browser-download").getAttribute("href"))!, node.url);
        assert.match(download.pathname, /browser-1\/downloads\/download-1$/);
        assert.equal(download.searchParams.get("nodeId"), identity.appNodeId);
        await f.page.getByTestId("browser-profiles-toggle").click();
        await f.page.getByTestId("browser-profile-label").fill("Saved login");
        await f.page.getByTestId("browser-save-profile").click();
        await f.page.getByTestId("browser-profiles-list").getByText("Saved login · Persistent", { exact: false }).waitFor();
        await f.page.getByTestId("browser-delete-profile").last().click();
        await f.page.getByTestId("confirm-accept-button").click();
        await f.page.getByTestId("browser-error").filter({ hasText: "Profile is in use" }).waitFor();
        assert.equal(await f.page.getByTestId("browser-profiles-list").getByText("Saved login · Persistent", { exact: false }).count(), 1);
        await f.page.getByTestId("browser-close-viewer").click();
        await f.page.getByTestId("confirm-accept-button").click();
        assert.equal(f.commands.filter((c) => c.action === "close").length, 0, "Close viewer must leave session running");
        if (await f.page.getByTestId("chat-more-button").isVisible()) await f.page.getByTestId("chat-more-button").click();
        await f.page.getByTestId("chat-open-browser-button").click();
        await screen.waitFor();
        assert.equal(f.starts.length, 1, "reopening must reconnect, never recreate");
        f.disconnect();
        await f.page.getByTestId("browser-connection-status").filter({ hasText: "Live" }).waitFor();
        assert.ok(f.connections() >= 3, "socket reconnects to existing session");
        await f.page.getByTestId("browser-resume-agent").click();
        await f.page.getByTestId("browser-control-status").filter({ hasText: "Agent control" }).waitFor();
        await f.page.getByTestId("browser-end").click();
        await f.page.getByTestId("confirm-accept-button").click();
        await f.page.getByTestId("browser-session-status").filter({ hasText: "closed" }).waitFor();
        assert.equal(f.commands.filter((c) => c.action === "close").length, 1);
        await f.page.getByTestId("browser-profiles-toggle").click();
        await f.page.getByTestId("browser-delete-profile").last().click();
        await f.page.getByTestId("confirm-accept-button").click();
        await f.page.getByTestId("browser-profiles-list").getByText("Saved login · Persistent", { exact: false }).waitFor({ state: "detached" });
        await f.page.getByTestId("browser-close-viewer").click();
        await openConversation(f.page, "[Claude] Makor deployment information");
        await f.page.getByTestId("browser-start").click();
        await screen.waitFor();
        assert.equal(f.starts.length, 2, "different conversations need separate browser sessions");
        assert.notEqual(f.starts[1].conversationId, f.starts[0].conversationId);
        assert.equal(f.starts[1].engine, "claude");
        assert.equal(f.queries.at(-1)!.searchParams.get("conversationId"), f.starts[1].conversationId);
      } finally { await f.page.close(); }
    });
    await t.test("two accounts stay running while viewer switches and End closes only selected account", async () => {
      const f = await setup();
      try {
        await openConversation(f.page);
        await f.page.getByTestId("browser-profile-select").selectOption(profileId);
        await f.page.getByTestId("browser-start").click();
        await f.page.getByTestId("browser-screen").waitFor();
        await f.page.getByTestId("browser-profile-select").selectOption("new");
        await f.page.getByTestId("browser-profile-name").fill("Personal");
        await f.page.getByTestId("browser-start").click();
        await f.page.getByTestId("browser-session-status").filter({ hasText: "Personal" }).waitFor();
        assert.equal(f.starts[1].profileName, "Personal");
        assert.equal(f.starts[1].conversationId, f.starts[0].conversationId);
        assert.deepEqual(f.sessions.map(session => session.state), ["running", "running"]);
        const before = f.commands.length;
        await f.page.getByTestId("browser-session-select").selectOption("browser-1");
        await f.page.getByTestId("browser-session-status").filter({ hasText: "Work login" }).waitFor();
        assert.equal(f.commands.length, before, "viewer selection sends no agent command");
        assert.match(await f.page.getByTestId("browser-session-status").innerText(), /automatically.*restart/);
        await f.page.getByTestId("browser-end").click();
        await f.page.getByTestId("confirm-accept-button").click();
        await f.page.getByTestId("browser-session-status").filter({ hasText: "closed" }).waitFor();
        assert.deepEqual(f.sessions.map(session => session.state), ["closed", "running"]);
        await f.page.getByTestId("browser-session-select").selectOption("browser-2");
        await f.page.getByTestId("browser-screen").waitFor();
        await f.page.setViewportSize({ width: 390, height: 844 });
        await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      } finally { await f.page.close(); }
    });
    await t.test("machine changes fence profile loads and leave accounts pinned to their owners", async () => {
      const f = await setup();
      let release!: () => void;
      try {
        await openConversation(f.page);
        await f.page.getByTestId("browser-profile-select").selectOption(profileId);
        await f.page.getByTestId("browser-start").click();
        await f.page.getByTestId("browser-screen").waitFor();
        assert.match(await f.page.getByTestId("browser-session-status").innerText(), /Mac laptop/);
        f.delayProfiles(new Promise(resolve => { release = resolve; }));
        await f.page.getByTestId("browser-machines-toggle").click();
        await f.page.getByTestId("browser-start-node").selectOption(executorId);
        await f.page.waitForFunction(() => (document.querySelector('[data-testid="browser-start-node"]') as HTMLSelectElement).disabled);
        assert.equal(await f.page.getByTestId("browser-conversation-node").isDisabled(), true);
        assert.equal(await f.page.getByTestId("browser-start").isDisabled(), true);
        assert.equal(await f.page.getByTestId("browser-profile-select").inputValue(), "", "Old machine's profile selection must be cleared before loading");
        release();
        await f.page.waitForFunction(() => !(document.querySelector('[data-testid="browser-start-node"]') as HTMLSelectElement).disabled);
        assert.deepEqual(await f.page.getByTestId("browser-profile-select").locator("option").allTextContents(), ["Conversation default", "New named profile…"]);
        await f.page.getByTestId("browser-profile-select").selectOption("new");
        await f.page.getByTestId("browser-profile-name").fill("Ubuntu account");
        await f.page.getByTestId("browser-start").click();
        await f.page.getByTestId("browser-session-status").filter({ hasText: "Ubuntu account" }).waitFor();
        assert.deepEqual(f.sessions.map(session => session.nodeId), [node.nodeId, executorId]);
        await f.page.getByTestId("browser-conversation-node").selectOption(executorId);
        await f.page.getByTestId("browser-start-node").selectOption("");
        assert.match(await f.page.getByTestId("browser-start-node").locator("option").first().innerText(), /Use conversation setting · Ubuntu/);
        await f.page.getByTestId("browser-session-select").selectOption("browser-1");
        await f.page.getByTestId("browser-session-status").filter({ hasText: "Work login" }).waitFor();
        assert.match(await f.page.getByTestId("browser-session-status").innerText(), /Mac laptop/);
        assert.equal(new URL((await f.page.getByTestId("browser-open-tab").getAttribute("href"))!, node.url).searchParams.get("nodeId"), node.nodeId);
        await f.page.getByTestId("browser-end").click(); await f.page.getByTestId("confirm-accept-button").click();
        await f.page.getByTestId("browser-session-status").filter({ hasText: "closed" }).waitFor();
        assert.deepEqual(f.sessions.map(session => session.state), ["closed", "running"]);
        assert.ok(f.requests.filter(url => url.pathname.endsWith("/command")).every(url => url.searchParams.get("nodeId") === node.nodeId));
        await f.page.setViewportSize({ width: 390, height: 844 });
        await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Machine selectors must fit mobile viewer");
        assert.ok((await f.page.getByTestId("browser-start-node").boundingBox())!.width > 300, "Inherited machine labels need a full mobile row, not a clipped half-width select");
        await f.page.screenshot({ path: path.resolve("tmp/machine-ui-mobile.png") });
      } finally { release?.(); await f.page.close(); }
    });
    await t.test("dialog response uses the displayed request page, not the active image", async () => {
      const f = await setup();
      try {
        await openConversation(f.page); await f.page.getByTestId("browser-start").click();
        await f.page.getByTestId("browser-take-control").click();
        await f.page.getByTestId("browser-control-status").filter({ hasText: "Human control" }).waitFor();
        f.sessions[0].dialog = { id: executorId, pageId: profileId, type: "prompt", message: "Background approval", defaultValue: "" };
        f.sendState();
        await f.page.getByTestId("browser-dialog-input").fill("approve this only");
        await f.page.getByTestId("browser-dialog-accept").click();
        await f.page.locator('[data-part="dialog"]').waitFor({ state: "hidden" });
        assert.deepEqual(f.commands.find(c => c.action === "dialog"), { action: "dialog", accept: true, promptText: "approve this only", expectedPageId: profileId, requestId: executorId });
      } finally { await f.page.close(); }
    });
    for (const samePage of [false, true]) await t.test(`file reads cannot redirect to a ${samePage ? "same-page" : "cross-page"} replacement chooser`, async () => {
      const f = await setup();
      try {
        await openConversation(f.page); await f.page.getByTestId("browser-start").click();
        await f.page.getByTestId("browser-take-control").click();
        await f.page.getByTestId("browser-control-status").filter({ hasText: "Human control" }).waitFor();
        f.sessions[0].fileChooser = true;
        f.sessions[0].fileChooserRequest = { id: executorId, pageId };
        f.sendState();
        await f.page.getByTestId("browser-upload").waitFor();
        await f.page.waitForFunction(() => !(document.querySelector('[data-testid="browser-upload"]') as HTMLInputElement).disabled);
        await f.page.evaluate(() => {
          const read = FileReader.prototype.readAsDataURL;
          FileReader.prototype.readAsDataURL = function(file) { (window as any).finishFileRead = () => read.call(this, file); };
        });
        await f.page.getByTestId("browser-upload").setInputFiles({ name: "private.txt", mimeType: "text/plain", buffer: Buffer.from("private bytes") });
        await f.page.waitForFunction(() => Boolean((window as any).finishFileRead));
        f.sessions[0].fileChooserRequest = { id: profileId, pageId: samePage ? pageId : profileId };
        f.sessions[0].dialog = { id: profileId, pageId, type: "alert", message: "Replacement ready", defaultValue: "" };
        f.sendState();
        await f.page.getByText("alert: Replacement ready", { exact: true }).waitFor();
        await f.page.evaluate(() => (window as any).finishFileRead());
        await f.page.getByTestId("browser-upload-status").filter({ hasText: /Uploaded|discarded/ }).waitFor();
        assert.equal(f.commands.filter(c => c.action === "upload").length, 0, "Bytes chosen for old request must not be sent to replacement");
        assert.match(await f.page.getByTestId("browser-error").textContent() || "", /changed|request/i);
      } finally { await f.page.close(); }
    });
    await t.test("native file selection binds before change and rejects a replaced chooser", async () => {
      const f = await setup();
      try {
        await openConversation(f.page); await f.page.getByTestId("browser-start").click();
        await f.page.getByTestId("browser-take-control").click();
        await f.page.getByTestId("browser-control-status").filter({ hasText: "Human control" }).waitFor();
        f.sessions[0].fileChooser = true;
        f.sessions[0].fileChooserRequest = { id: executorId, pageId }; f.sendState();
        const upload = f.page.getByTestId("browser-upload"); await upload.waitFor();
        const pickerOpened = f.page.waitForEvent("filechooser");
        await upload.click(); const picker = await pickerOpened;
        f.sessions[0].fileChooserRequest = { id: profileId, pageId };
        f.sessions[0].dialog = { id: profileId, pageId, type: "alert", message: "Chooser replaced", defaultValue: "" }; f.sendState();
        await f.page.getByText("alert: Chooser replaced", { exact: true }).waitFor();
        await picker.setFiles({ name: "private.txt", mimeType: "text/plain", buffer: Buffer.from("private bytes") });
        await f.page.getByTestId("browser-upload-status").filter({ hasText: /Uploaded|discarded/ }).waitFor();
        assert.equal(f.commands.filter(c => c.action === "upload").length, 0, "Native picker must retain request shown before it opened");
      } finally { await f.page.close(); }
    });
    await t.test("dialog and End remain usable while a file read is pending", async () => {
      const f = await setup();
      try {
        await openConversation(f.page); await f.page.getByTestId("browser-start").click();
        await f.page.getByTestId("browser-take-control").click();
        await f.page.getByTestId("browser-control-status").filter({ hasText: "Human control" }).waitFor();
        f.sessions[0].fileChooser = true;
        f.sessions[0].fileChooserRequest = { id: executorId, pageId }; f.sendState();
        await f.page.getByTestId("browser-upload").waitFor();
        await f.page.waitForFunction(() => !(document.querySelector('[data-testid="browser-upload"]') as HTMLInputElement).disabled);
        await f.page.evaluate(() => { FileReader.prototype.readAsDataURL = function() { (window as any).readingFile = true; }; });
        await f.page.getByTestId("browser-upload").setInputFiles({ name: "private.txt", mimeType: "text/plain", buffer: Buffer.from("private bytes") });
        await f.page.waitForFunction(() => (window as any).readingFile);
        f.sessions[0].dialog = { id: profileId, pageId, type: "alert", message: "Urgent dialog", defaultValue: "" }; f.sendState();
        await f.page.getByText("alert: Urgent dialog", { exact: true }).waitFor();
        assert.equal(await f.page.getByTestId("browser-dialog-dismiss").isEnabled(), true, "File read must not block dialog response");
        assert.equal(await f.page.getByTestId("browser-end").isEnabled(), true, "File read must not block End browser");
        await f.page.getByTestId("browser-dialog-dismiss").click();
        await f.page.locator('[data-part="dialog"]').waitFor({ state: "hidden" });
        await f.page.getByTestId("browser-end").click(); await f.page.getByTestId("confirm-accept-button").click();
        await f.page.getByTestId("browser-session-status").filter({ hasText: "closed" }).waitFor();
        assert.equal(f.commands.filter(c => c.action === "upload").length, 0);
      } finally { await f.page.close(); }
    });
    await t.test("dedicated viewer bounds reconnects, selects popups, and leaves shortcuts outside the image alone", async () => {
      const f = await setup();
      try {
        const projectId = node.projects.find((project) => project.name === "Internal Assistant")!.id;
        f.sessions.push({ id: "browser-dedicated", projectId, conversationId: "conversation-dedicated", engine: "pi", appNodeId: node.nodeId, nodeId: node.nodeId, state: "running", owner: "agent", activePageId: pageId, tabs: [{ id: pageId, title: "Example", url: "https://example.com" }], dialog: null, fileChooser: false, downloads: [] });
        await f.page.goto(`${node.url}/browser.html?${new URLSearchParams({ browserSessionId: "browser-dedicated", theme: "dark" })}`);
        await f.page.getByTestId("browser-screen").waitFor({ timeout: 5000 });
        assert.equal(await f.page.locator("#messages").count(), 0, "browser-only page must not boot conversation UI");
        assert.equal(await f.page.locator("html").getAttribute("data-theme"), "dark");
        await f.page.getByTestId("browser-take-control").click();
        await f.page.getByTestId("browser-control-status").filter({ hasText: "Human control" }).waitFor();
        await f.page.getByTestId("browser-new-tab").click();
        await f.page.getByTestId("browser-select-tab").filter({ hasText: "Popup" }).waitFor();
        assert.equal(await f.page.getByTestId("browser-screen").isVisible(), false, "popup must hide old page's image until its own frame arrives");
        f.sendFrame(profileId);
        await f.page.getByTestId("browser-screen").waitFor();
        await f.page.getByTestId("browser-select-tab").filter({ hasText: "Example" }).click();
        f.sendFrame();
        const before = f.commands.filter((command) => command.action === "key").length;
        await f.page.getByTestId("browser-url").press("Control+a");
        assert.equal(f.commands.filter((command) => command.action === "key").length, before, "toolbar focus must not send remote keys");
        await f.page.getByTestId("browser-screen").focus();
        await f.page.getByTestId("browser-screen").press("Tab");
        assert.notEqual(await f.page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "browser-screen", "Tab must allow escaping remote input capture");
        await f.page.setViewportSize({ width: 390, height: 844 });
        await f.page.screenshot({ path: "/tmp/browser-ui-mobile-dark.png" });
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile viewer must not overflow horizontally");
        await f.page.clock.install();
        for (let attempt = 0; attempt < 5; attempt++) {
          f.disconnect();
          await f.page.getByTestId("browser-connection-status").filter({ hasText: "Disconnected" }).waitFor();
          await f.page.clock.runFor(Math.min(1000 * 2 ** attempt, 8000));
          await f.page.getByTestId("browser-connection-status").filter({ hasText: "Live" }).waitFor();
        }
        f.disconnect();
        await f.page.getByTestId("browser-connection-status").filter({ hasText: "automatic retries stopped" }).waitFor();
        assert.equal(f.connections(), 6);
        await f.page.clock.runFor(60000);
        assert.equal(f.connections(), 6, "automatic retry count must remain bounded");
        assert.equal(f.starts.length, 0, "disconnects never recreate browser sessions");
        await f.page.getByTestId("browser-reconnect").click();
        await f.page.getByTestId("browser-connection-status").filter({ hasText: "Live" }).waitFor();
        assert.equal(f.connections(), 7);
        await f.page.getByTestId("browser-close-viewer").click();
        await f.page.getByTestId("browser-confirm-accept").click();
        await f.page.getByText("Viewer closed.", { exact: false }).waitFor();
        assert.equal(f.commands.filter((command) => command.action === "close").length, 0);
      } finally { await f.page.close(); }
    });
    await t.test("placeholder cannot start a browser and canvas pane uses its own conversation identity", async () => {
      const f = await setup();
      try {
        await f.page.evaluate(async () => {
          const { state } = await import("/app/state.js" as string);
          const { renderChatSessionControls } = await import("/app/chat-controls.js" as string);
          state.activeSessionId = null; state.activeConversationId = null;
          renderChatSessionControls();
        });
        assert.equal(await f.page.getByTestId("chat-open-browser-button").count(), 1, "placeholder still explains Browser availability");
        assert.equal(await f.page.getByTestId("chat-open-browser-button").isDisabled(), true);
        assert.match((await f.page.getByTestId("chat-open-browser-button").getAttribute("title"))!, /conversation|message/i);
        assert.equal(f.starts.length, 0);
        // Real pane boot, same path and IDs the canvas passes to its iframe.
        await f.page.locator("#sessionList .list-row").filter({ has: f.page.locator("strong", { hasText: "Short one" }) }).first().click();
        await f.page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
        const params = await f.page.evaluate(async () => {
          const { state } = await import("/app/state.js" as string);
          return new URLSearchParams({ canvasPane: "1", projectId: state.activeProjectId, sessionPath: state.activeSessionPath, sessionId: state.activeSessionId, nodeId: state.activeNodeId }).toString();
        });
        await f.page.goto(`${node.url}/?${params}`);
        await f.page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
        if (await f.page.getByTestId("chat-more-button").isVisible()) await f.page.getByTestId("chat-more-button").click();
        await f.page.getByTestId("chat-open-browser-button").click();
        await f.page.getByTestId("browser-start").click();
        await f.page.getByTestId("browser-screen").waitFor();
        assert.equal(f.starts[0].conversationId, new URLSearchParams(params).get("sessionId"));
        assert.equal(f.starts[0].appNodeId, new URLSearchParams(params).get("nodeId"));
      } finally { await f.page.close(); }
    });
    assert.deepEqual(pageErrors, [], "browser UI must not throw unhandled page errors");
  } finally {
    await browser.close(); await stopDevNode(server); await rm(root, { recursive: true, force: true });
  }
});
