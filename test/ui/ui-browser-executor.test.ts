import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Page, type WebSocketRoute } from "playwright-core";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

// Only the new browser API is stubbed. Authentication, app state, conversation
// selection and rendering run against the real isolated dev node.
test("browser executor UI", { timeout: 180_000 }, async (t) => {
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
    const commands: any[] = [], starts: any[] = [], saves: any[] = [], queries: URL[] = [];
    const sessions: any[] = [];
    let profiles = [{ id: profileId, projectId: "unused", label: "Work login" }];
    let socket: WebSocketRoute | undefined;
    let connections = 0, unavailable = false;
    const frame = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 800;
      const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#eee"; ctx.fillRect(0, 0, 1200, 800);
      ctx.fillStyle = "#17191b"; ctx.font = "32px sans-serif"; ctx.fillText("Remote Ubuntu browser", 80, 120);
      return canvas.toDataURL("image/jpeg").split(",")[1];
    });
    function sendState() { if (socket && sessions.length) socket.send(JSON.stringify({ type: "browserState", session: sessions.at(-1) })); }
    function sendFrame(id = pageId, data = frame) { socket?.send(JSON.stringify({ type: "browserFrame", pageId: id, data, width: 1200, height: 800 })); }
    function apply(command: any) {
      commands.push(command);
      const session = sessions.at(-1);
      if (command.action === "takeControl") session.owner = "human";
      if (command.action === "resumeAgent") session.owner = "agent";
      if (command.action === "close") session.state = "closed";
      if (command.action === "dialog") session.dialog = null;
      if (command.action === "upload") session.fileChooser = false;
      if (command.action === "newTab") { session.tabs.push({ id: profileId, url: "about:blank", title: "Popup" }); session.activePageId = profileId; }
      if (command.action === "selectTab") session.activePageId = command.pageId;
      if (command.action === "saveProfile") profiles.push({ id: executorId, projectId: session.projectId, label: command.label });
      sendState();
      return session;
    }
    await page.route("**/api/browser/**", async (route) => {
      const request = route.request(), url = new URL(request.url());
      const method = request.method();
      const body = request.postDataJSON();
      let result: any;
      if (url.pathname === "/api/browser/status") {
        if (unavailable) return route.fulfill({ status: 503, json: { error: "Executor is offline" } });
        result = { config: { executorNodeId: null }, nodes: [
          { id: executorId, name: "Ubuntu worker", supported: true, available: true, executable: "/usr/bin/chromium", reason: null },
          { id: profileId, name: "Mac laptop", supported: false, available: false, executable: null, reason: "Ubuntu required" },
          { id: pageId, name: "Offline Ubuntu", supported: true, available: false, executable: null, reason: "Node offline" },
        ] };
      } else if (url.pathname === "/api/browser/config") {
        saves.push({ body, csrf: request.headers()["x-csrf-token"] }); result = { config: body };
      } else if (url.pathname === "/api/browser/profiles") result = { profiles };
      else if (url.pathname.startsWith("/api/browser/profiles/") && method === "DELETE") {
        profiles = profiles.filter((profile) => profile.id !== url.pathname.split("/").at(-1)); result = {};
      } else if (url.pathname === "/api/browser/sessions" && method === "GET") {
        queries.push(url); result = { sessions: sessions.filter((session) => session.conversationId === url.searchParams.get("conversationId")) };
      } else if (url.pathname === "/api/browser/sessions" && method === "POST") {
        starts.push(body);
        const session = { ...body, id: `browser-${sessions.length + 1}`, state: "running", owner: "agent", activePageId: pageId,
          tabs: [{ id: pageId, title: "Example", url: "https://example.com" }], downloads: [], fileChooser: false, dialog: null };
        sessions.push(session); result = { session };
      } else if (url.pathname.endsWith("/command")) {
        if (body.action === "close" && sessions.at(-1).owner !== "human") return route.fulfill({ status: 409, json: { error: "Take control before browser input" } });
        result = { result: {}, session: apply(body) };
      }
      else result = { session: sessions.find((session) => session.id === url.pathname.split("/").at(-1)) };
      return route.fulfill({ json: result });
    });
    await page.routeWebSocket(/\/ws\?mode=browser/, (ws) => {
      socket = ws; connections++; sendState(); sendFrame();
      ws.onMessage((message) => apply(JSON.parse(String(message)).command));
    });
    const login = await signIn(environment, node);
    await page.context().addCookies(login.cookie.split("; ").map((cookie) => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
    await page.goto(node.url);
    try { await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click(); }
    catch (error) { console.error("browser-ui boot:", await page.locator("body").innerText()); throw error; }
    return { page, commands, starts, saves, sessions, queries, sendState, sendFrame, disconnect: () => socket?.close(), connections: () => connections, offline: () => { unavailable = true; } };
  }
  async function openConversation(page: Page, title = "Short one") {
    await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: title }) }).first().click();
    await page.locator("#sessionTitle").filter({ hasText: title }).waitFor();
    if (await page.getByTestId("chat-more-button").isVisible()) await page.getByTestId("chat-more-button").click();
    assert.equal(await page.getByTestId("chat-open-browser-button").count(), 1, "conversation controls need Browser action");
    await page.getByTestId("chat-open-browser-button").click();
  }
  try {
    await t.test("Ubuntu-only executor selection saves with CSRF and recovers from offline status", async () => {
      const f = await setup();
      try {
        await f.page.getByTestId("settings-open-button").click();
        await f.page.getByTestId("settings-tab-cluster").click();
        const select = f.page.getByTestId("browser-executor-select");
        assert.equal(await select.count(), 1, "Cluster settings need a browser executor selector");
        await select.locator("option").filter({ hasText: "Ubuntu worker" }).waitFor({ state: "attached" });
        assert.equal(await select.locator(`option[value="${profileId}"]`).evaluate((option: HTMLOptionElement) => option.disabled), true);
        await select.selectOption(executorId);
        await f.page.getByTestId("browser-executor-save").click();
        await f.page.getByTestId("browser-executor-status").filter({ hasText: "saved" }).waitFor();
        assert.equal(f.saves[0].body.executorNodeId, executorId);
        assert.ok(f.saves[0].csrf, "settings write must carry login CSRF token");
        await select.selectOption("");
        await Promise.all([
          f.page.waitForResponse((response) => response.url().endsWith("/api/browser/config") && response.request().postDataJSON().executorNodeId === null),
          f.page.getByTestId("browser-executor-save").click(),
        ]);
        assert.equal(f.saves.at(-1).body.executorNodeId, null);
        f.offline();
        await f.page.getByTestId("browser-executor-check").click();
        await f.page.getByTestId("browser-executor-status").filter({ hasText: "Executor is offline" }).waitFor();
        assert.equal(await f.page.locator("#settingsDialog").isVisible(), true);
      } finally { await f.page.close(); }
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
        assert.match((await f.page.getByTestId("browser-download").getAttribute("href"))!, /browser-1\/downloads\/download-1$/);
        await f.page.getByTestId("browser-profile-label").fill("Saved login");
        await f.page.getByTestId("browser-save-profile").click();
        await f.page.getByTestId("browser-profiles-list").getByText("Saved login", { exact: true }).waitFor();
        await f.page.getByTestId("browser-delete-profile").last().click();
        await f.page.getByTestId("confirm-accept-button").click();
        await f.page.getByTestId("browser-profiles-list").getByText("Saved login", { exact: true }).waitFor({ state: "detached" });
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
        f.sessions.push({ id: "browser-dedicated", projectId, conversationId: "conversation-dedicated", engine: "pi", appNodeId: node.nodeId, state: "running", owner: "agent", activePageId: pageId, tabs: [{ id: pageId, title: "Example", url: "https://example.com" }], dialog: null, fileChooser: false, downloads: [] });
        await f.page.goto(`${node.url}/browser.html?${new URLSearchParams({ projectId, engine: "pi", conversationId: "conversation-dedicated", appNodeId: node.nodeId, browserSessionId: "browser-dedicated", theme: "dark" })}`);
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
