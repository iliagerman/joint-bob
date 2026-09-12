import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const settle = () => new Promise(resolve => setImmediate(resolve));
async function fixture(confirm = async () => true, configuredNode: string | null = "mac", fixtureOptions: { identity?: Record<string, string>; sessionId?: string; nodeId?: string; failPath?: string; completeDiscovery?: boolean } = {}) {
  const source = await readFile("public/app/browser-viewer.js", "utf8");
  const nodes = new Map<string, any>(), requests: any[] = [], sockets: any[] = [], images: any[] = [];
  function element() {
    return { dataset: {}, value: "", textContent: "", hidden: false, disabled: false, children: [] as any[], handlers: {} as Record<string, Function>,
      classList: { add() {} }, setAttribute() {}, querySelectorAll: () => [],
      append(...children: any[]) { this.children.push(...children); }, replaceChildren(...children: any[]) { this.children = children; },
      addEventListener(name: string, handler: Function) { this.handlers[name] = handler; } };
  }
  const root = { ...element(), querySelector(selector: string) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); } };
  const get = (name: string) => root.querySelector(`[data-testid="browser-${name}"]`);
  const identity = { projectId: "project", conversationId: "conversation", engine: "pi", appNodeId: "owner" };
  const sessions = ["Work", "Personal"].map((label, index) => ({ ...identity, appNodeId: index ? "previous-agent-node" : identity.appNodeId, nodeId: index ? "linux" : "mac", id: `s${index}`, profileId: `p${index}`, profileLabel: label, restoreOnRestart: true, state: "running", owner: "human", canControl: true, activePageId: "same-page", tabs: [], downloads: [] }));
  const profiles = sessions.map(s => ({ id: s.profileId, label: s.profileLabel, persistent: true }));
  let deleteError = false, profileError = false;
  let profileGate: Promise<void> | undefined;
  let commandGate: Promise<void> | undefined;
  let refreshGate: { path: string; promise: Promise<void> } | undefined;
  class Socket {
    static OPEN = 1; readyState = 1; bufferedAmount = 0; handlers: Record<string, Function> = {};
    constructor(public url: URL) { sockets.push(this); }
    addEventListener(name: string, handler: Function) { this.handlers[name] = handler; }
    close() {} send() {}
  }
  const { createBrowserViewer } = runInNewContext(`${source.replace(/export /g, "")}\n({ createBrowserViewer })`, {
    URL, URLSearchParams, location: new URL("https://app.example/browser.html"),
    document: { querySelector: () => null, documentElement: { dataset: {} }, createElement: element, createRange: () => ({ createContextualFragment: () => ({}) }) },
    Option: class { constructor(public label: string, public value: string) {} }, WebSocket: Socket,
    Image: class { constructor() { images.push(this); } },
    FileReader: class { result = "data:text/plain;base64,Zml4dHVyZQ=="; onload!: () => void; readAsDataURL() { this.onload(); } },
    setTimeout: () => 1, clearTimeout() {},
  });
  const viewer = createBrowserViewer(root, { identity: fixtureOptions.identity ?? identity, sessionId: fixtureOptions.sessionId, nodeId: fixtureOptions.nodeId, confirm, api: async (path: string, options: any = {}) => {
    const url = new URL(path, "https://app.example"), body = options.body && JSON.parse(options.body); requests.push({ url, ...options, body });
    if (url.pathname === fixtureOptions.failPath) throw new Error("Discovery unavailable");
    if (url.pathname === "/api/browser/sessions/missing") throw new Error("Requested account unavailable");
    if (options.method === "DELETE") { if (deleteError) throw new Error("Profile is in use"); return {}; }
    if (url.pathname === "/api/browser/status") return { config: { executorNodeId: configuredNode }, nodes: [{ id: "mac", name: "Mac", available: true, reachable: true }, { id: "linux", name: "Ubuntu", available: true, reachable: true }] };
    if (url.pathname === "/api/browser/preferences") return { nodeId: body ? body.nodeId : null, effectiveNodeId: body?.nodeId || configuredNode };
    if (url.pathname === "/api/browser/profiles") {
      if (profileGate) await profileGate;
      if (profileError) throw new Error("Machine unavailable");
      return { profiles };
    }
    if (options.method === "POST" && url.pathname === "/api/browser/sessions") {
      const session = { ...sessions[0], id: "s2", profileId: body.profileId || "p2", profileLabel: body.profileName || "Work" }; sessions.push(session); return { session };
    }
    const session = sessions.find(s => url.pathname.includes(`/${s.id}`));
    if (body?.action === "close") session!.state = "closed";
    const response = session ? { session: { ...session } } : { sessions: sessions.map(item => ({ ...item })), unavailableNodes: fixtureOptions.completeDiscovery ? [] : [{ nodeId: "offline", reason: "Peer unreachable" }] };
    if (refreshGate?.path === url.pathname) await refreshGate.promise;
    if (body && commandGate) await commandGate;
    return response;
  } });
  await settle();
  const state = (session: any, socket = sockets.at(-1)) => socket.handlers.message({ data: JSON.stringify({ type: "browserState", session }) });
  return { get, root, viewer, requests, sockets, images, sessions, profiles, state, refuseDelete: () => { deleteError = true; },
    delayProfiles: (gate: Promise<void>) => { profileGate = gate; }, refuseProfiles: () => { profileError = true; },
    delayCommands: (gate: Promise<void>) => { commandGate = gate; },
    delayRefresh: (path: string, promise: Promise<void>) => { refreshGate = { path, promise }; } };
}

test("account picker changes only viewer, fences stale sockets and decoded frames, ends selected account", async () => {
  const f = await fixture();
  try {
    assert.equal(f.get("session-select").children.length, 2, "show both conversation accounts");
    assert.equal(f.get("start").disabled, false, "another profile can start while running");
    f.state(f.sessions[0]);
    const old = f.sockets[0];
    old.handlers.message({ data: JSON.stringify({ type: "browserFrame", pageId: "same-page", data: "old" }) });
    f.get("session-select").value = "s1"; await f.get("session-select").handlers.change(); await settle();
    assert.equal(f.viewer.session.id, "s1");
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0, "view selection cannot retarget agent");
    old.handlers.message({ data: JSON.stringify({ type: "browserState", session: f.sessions[0] }) });
    f.images[0].onload();
    assert.equal(f.viewer.session.id, "s1"); assert.equal(f.get("screen").hidden, true, "old account frame must stay hidden even with same page ID");
    await f.get("end").handlers.click(); await settle();
    const commands = f.requests.filter(r => r.url.pathname.endsWith("/command"));
    assert.deepEqual(commands.map(r => r.url.pathname), ["/api/browser/sessions/s1/command", "/api/browser/sessions/s1/command"]);
    assert.equal(f.sessions[0].state, "running");
  } finally { f.viewer.dispose(); }
});

test("named profiles validate and start explicitly; persistence and failed restore are visible", async () => {
  const f = await fixture();
  try {
    f.get("profile-select").value = "new"; await f.get("profile-select").handlers.change();
    f.get("profile-name").value = "   "; await f.get("start").handlers.click(); await settle();
    assert.match(f.get("error").textContent, /1.*80/);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    f.get("profile-name").value = "  Second account  "; await f.get("start").handlers.click(); await settle();
    const start = f.requests.find(r => r.method === "POST");
    assert.equal(start.body.profileName, "Second account"); assert.equal("profileId" in start.body, false);
    assert.match(f.get("session-status").textContent, /automatically.*restart/i);
    f.state({ ...f.viewer.session, state: "interrupted", error: "Restore failed", restoreOnRestart: true });
    assert.match(f.get("session-status").textContent, /Restore failed/);
    assert.match(f.get("session-status").textContent, /no automatic retry/i);
  } finally { f.viewer.dispose(); }
});

test("profile rename uses current session; project deletion refusal stays visible", async () => {
  const f = await fixture();
  try {
    f.state(f.sessions[0]);
    f.get("profile-label").value = "Renamed";
    await f.root.querySelector('[data-part="profile-form"]').handlers.submit({ preventDefault() {} }); await settle();
    assert.deepEqual(f.requests.find(r => r.body?.action === "saveProfile").body, { action: "saveProfile", label: "Renamed" });
    assert.match(f.get("profiles-list").children[0].children[0].textContent, /Persistent/);
    f.refuseDelete(); await f.get("profiles-list").children[0].children[1].handlers.click(); await settle();
    const deletion = f.requests.find(r => r.method === "DELETE");
    assert.equal(deletion.url.searchParams.get("projectId"), "project"); assert.equal(deletion.url.searchParams.get("nodeId"), "mac");
    assert.match(f.get("error").textContent, /in use/); assert.equal(f.get("profiles-list").children.length, 2);
  } finally { f.viewer.dispose(); }
});

test("a delayed HTTP command response cannot erase newer streamed dialog state", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    f.state(f.sessions[0]);
    f.delayCommands(new Promise(resolve => { release = resolve; }));
    const pending = f.get("resume-agent").handlers.click();
    await settle();
    const dialog = { id: "new-dialog", pageId: "same-page", type: "prompt", message: "New prompt", defaultValue: "" };
    f.state({ ...f.sessions[0], dialog });
    release(); await pending; await settle();
    assert.equal(f.viewer.session.dialog?.id, "new-dialog", "An older HTTP snapshot must not overwrite live browser state");
    assert.equal(f.root.querySelector('[data-part="dialog"]').hidden, false);
  } finally { release(); f.viewer.dispose(); }
});

for (const failUpload of [false, true]) test(`upload ${failUpload ? "failure" : "completion"} feedback stays with its account after switching`, async () => {
  const f = await fixture();
  let finish!: () => void, reject!: (error: Error) => void;
  try {
    f.state({ ...f.sessions[0], fileChooser: true, fileChooserRequest: { id: "chooser", pageId: "same-page" } });
    f.delayCommands(new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; }));
    f.get("upload").files = [{ name: "fixture.txt", size: 7 }];
    f.get("upload").handlers.click(); f.get("upload").handlers.change(); await settle();
    assert.equal(f.requests.find(request => request.body?.action === "upload").url.pathname, "/api/browser/sessions/s0/command");
    f.get("session-select").value = "s1"; await f.get("session-select").handlers.change(); f.state(f.sessions[1]);
    const switchedStatus = f.get("upload-status").textContent;
    if (failUpload) reject(new Error("Work upload failed")); else finish();
    await settle();
    assert.equal(f.viewer.session.id, "s1");
    assert.deepEqual({ switchedStatus, status: f.get("upload-status").textContent, error: f.get("error").textContent },
      { switchedStatus: "", status: "", error: "" }, "Work upload feedback must not appear in Personal");
  } finally { finish(); f.viewer.dispose(); }
});

test("takeover confirmation cannot switch control to a different account", async () => {
  let approve!: (value: boolean) => void;
  const f = await fixture(() => new Promise(resolve => { approve = resolve; }));
  try {
    f.state({ ...f.sessions[0], canControl: false });
    const takeover = f.get("take-control").handlers.click();
    f.get("session-select").value = "s1"; await f.get("session-select").handlers.change(); await settle();
    approve(true); await takeover; await settle();
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0, "Confirmation must remain bound to its original account");
    assert.match(f.get("error").textContent, /account changed/i);
  } finally { f.viewer.dispose(); }
});

test("a failed restore can be ended without taking control of a nonexistent browser", async () => {
  const f = await fixture();
  try {
    f.sessions[0].state = "interrupted";
    f.state({ ...f.sessions[0], error: "Browser executable missing", restoreOnRestart: true });
    assert.equal(f.get("end").disabled, false, "Restore intent must be cancellable after recovery fails");
    await f.get("end").handlers.click(); await settle();
    const commands = f.requests.filter(r => r.url.pathname.endsWith("/command"));
    assert.deepEqual(commands.map(r => r.body.action), ["close"]);
    assert.equal(commands[0].url.pathname, "/api/browser/sessions/s0/command");
    assert.equal(f.viewer.session.state, "closed");
  } finally { f.viewer.dispose(); }
});

test("End confirmation cannot close a different account selected while confirmation was open", async () => {
  let approve!: (value: boolean) => void;
  const f = await fixture(() => new Promise(resolve => { approve = resolve; }));
  try {
    const ending = f.get("end").handlers.click();
    f.get("session-select").value = "s1"; await f.get("session-select").handlers.change(); await settle();
    approve(true); await ending; await settle();
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0, "confirmation for Work cannot close Personal");
    assert.match(f.get("error").textContent, /account changed/i);
  } finally { f.viewer.dispose(); }
});


test("machine overrides affect new starts, never the viewed account owner", async () => {
  const f = await fixture();
  try {
    assert.equal(f.get("conversation-node").children[0].label, "Use Settings default · Mac");
    assert.equal(f.get("start-node").children[0].label, "Use conversation setting · Mac");
    assert.match(f.get("session-status").textContent, /Mac/);
    assert.equal(f.requests.find(r => r.url.pathname === "/api/browser/sessions").url.searchParams.has("nodeId"), false);
    f.get("conversation-node").value = "linux"; await f.get("conversation-node").handlers.change(); await settle();
    assert.equal(f.requests.find(r => r.method === "PUT").body.nodeId, "linux");
    assert.equal(f.viewer.session.nodeId, "mac");
    f.get("start-node").value = "linux"; await f.get("start-node").handlers.change(); await settle();
    assert.equal(f.requests.filter(r => r.url.pathname === "/api/browser/profiles").at(-1).url.searchParams.get("nodeId"), "linux");
    f.get("session-select").value = "s1"; await f.get("session-select").handlers.change(); await settle();
    assert.equal(f.requests.find(r => r.url.pathname === "/api/browser/sessions/s1").url.searchParams.get("nodeId"), "linux");
    assert.equal(f.sockets.at(-1).url.searchParams.get("nodeId"), "linux");
    f.state({ ...f.sessions[1], downloads: [{ id: "download", name: "fixture.txt", ready: true }] });
    assert.match(f.get("downloads-list").children[0].children[0].href, /nodeId=linux/);
    assert.match(f.get("open-tab").href, /nodeId=linux/);
    await f.get("end").handlers.click(); await settle();
    assert.ok(f.requests.filter(r => r.body?.action).every(r => r.url.searchParams.get("nodeId") === "linux"));
    await f.get("start").handlers.click(); await settle();
    const start = f.requests.find(r => r.method === "POST" && r.url.pathname === "/api/browser/sessions");
    assert.equal(start.url.searchParams.get("nodeId"), "linux");
    assert.equal(start.body.appNodeId, "owner");
  } finally { f.viewer.dispose(); }
});


test("partial machine discovery is visible without losing attached accounts", async () => {
  const f = await fixture();
  try {
    assert.match(f.get("discovery-status").textContent, /offline.*Peer unreachable/);
    assert.equal(f.get("session-select").children.length, 2);
  } finally { f.viewer.dispose(); }
});

test("failed profile discovery blocks starts on the new machine, not existing account controls", async () => {
  const f = await fixture();
  try {
    f.state(f.sessions[0]); f.refuseProfiles();
    f.get("start-node").value = "linux"; await f.get("start-node").handlers.change(); await settle();
    assert.match(f.get("error").textContent, /Machine unavailable/);
    assert.equal(f.get("start").disabled, true, "Do not start an account from incomplete profile discovery");
    assert.equal(f.get("end").disabled, false);
    assert.equal(f.viewer.session.nodeId, "mac");
  } finally { f.viewer.dispose(); }
});


test("inheritance clears the saved override and leaves start routing to server resolution", async () => {
  const f = await fixture();
  try {
    f.get("conversation-node").value = "linux"; await f.get("conversation-node").handlers.change();
    f.get("conversation-node").value = ""; await f.get("conversation-node").handlers.change();
    assert.equal(f.requests.filter(r => r.method === "PUT").at(-1).body.nodeId, null);
    assert.match(f.get("start-node").children[0].label, /Use conversation setting · Mac/);
    await f.get("start").handlers.click(); await settle();
    const start = f.requests.find(r => r.method === "POST");
    assert.equal(start.url.searchParams.has("nodeId"), false);
    assert.equal(start.body.appNodeId, "owner");
  } finally { f.viewer.dispose(); }
});

test("missing default requires configuration but leaves existing accounts usable", async () => {
  const f = await fixture(async () => true, null);
  try {
    assert.equal(f.get("start").disabled, true);
    assert.match(f.get("machine-status").textContent, /Not configured/);
    assert.equal(f.requests.some(r => r.url.pathname === "/api/browser/profiles"), false);
    assert.equal(f.viewer.session.nodeId, "mac");
    assert.equal(f.get("end").disabled, false);
  } finally { f.viewer.dispose(); }
});

test("profile deletion confirmation cannot cross a start-machine change", async () => {
  let approve!: (value: boolean) => void;
  const f = await fixture(() => new Promise(resolve => { approve = resolve; }));
  try {
    const deletion = f.get("profiles-list").children[0].children[1].handlers.click();
    f.get("start-node").value = "linux"; await f.get("start-node").handlers.change();
    approve(true); await deletion; await settle();
    assert.equal(f.requests.some(r => r.method === "DELETE"), false);
    assert.match(f.get("error").textContent, /Start machine changed/);
  } finally { f.viewer.dispose(); }
});


test("reopening a listed profile pins its known machine even when start selector inherits", async () => {
  const f = await fixture();
  try {
    f.get("profile-select").value = "p0";
    await f.get("start").handlers.click(); await settle();
    const start = f.requests.find(r => r.method === "POST");
    assert.equal(start.body.profileId, "p0");
    assert.equal(start.url.searchParams.get("nodeId"), "mac", "Settings may change after the profile list loads; profile owner cannot inherit a new node");
  } finally { f.viewer.dispose(); }
});

for (const identity of [{}, { engine: "claude", appNodeId: "live-host" }]) test(`legacy exact ID hydrates only missing identity: ${JSON.stringify(identity)}`, async () => {
  const f = await fixture(async () => true, "mac", { identity, sessionId: "s1" });
  try {
    assert.equal(f.requests[0].url.pathname, "/api/browser/sessions/s1");
    assert.equal(f.requests[0].url.searchParams.has("nodeId"), false);
    assert.equal(f.viewer.session.id, "s1");
    assert.equal(f.sockets[0].url.searchParams.get("nodeId"), "linux");
    f.get("conversation-node").value = "mac"; await f.get("conversation-node").handlers.change();
    const preference = f.requests.find(r => r.method === "PUT");
    assert.equal(preference.url.searchParams.get("engine"), identity.engine || "pi");
    await f.get("start").handlers.click();
    assert.deepEqual(f.requests.find(r => r.method === "POST").body, { projectId: "project", conversationId: "conversation", engine: identity.engine || "pi", appNodeId: identity.appNodeId || "previous-agent-node" });
  } finally { f.viewer.dispose(); }
});

for (const completeDiscovery of [false, true]) test(`missing explicit account is retained through ${completeDiscovery ? "complete" : "partial"} discovery until deliberate selection`, async () => {
  const f = await fixture(async () => true, "mac", { sessionId: "missing", completeDiscovery });
  try {
    assert.equal(f.viewer.session, null, "Do not substitute a reachable account for the requested account");
    assert.equal(f.sockets.length, 0);
    assert.match(f.get("error").textContent, /Requested account unavailable/);
    assert.match(f.get("open-tab").href, /browserSessionId=missing/);
    assert.equal(f.get("session-select").children.length, 2);
    await f.get("reconnect").handlers.click();
    assert.equal(f.requests.filter(r => r.url.pathname === "/api/browser/sessions/missing").length, 2);
    f.get("session-select").value = "s0"; await f.get("session-select").handlers.change();
    assert.equal(f.viewer.session.id, "s0");
  } finally { f.viewer.dispose(); }
});

test("historic cross-engine account cannot rewrite live preference or new-start identity", async () => {
  const f = await fixture();
  try {
    f.sessions[1].engine = "claude";
    f.get("session-select").value = "s1"; await f.get("session-select").handlers.change();
    f.get("conversation-node").value = "linux"; await f.get("conversation-node").handlers.change();
    await f.get("start").handlers.click();
    assert.equal(f.requests.find(r => r.method === "PUT").url.searchParams.get("engine"), "pi");
    assert.deepEqual(f.requests.find(r => r.method === "POST").body, { projectId: "project", conversationId: "conversation", engine: "pi", appNodeId: "owner" });
  } finally { f.viewer.dispose(); }
});

for (const failPath of ["/api/browser/status", "/api/browser/preferences", "/api/browser/sessions"]) test(`known account connects despite optional ${failPath} failure`, async () => {
  const f = await fixture(async () => true, "mac", { sessionId: "s0", nodeId: "mac", failPath });
  try {
    assert.equal(f.sockets.length, 1, "Known account attachment must precede optional discovery");
    f.state(f.sessions[0]);
    assert.equal(f.get("end").disabled, false);
    assert.match(f.get("error").textContent, /Discovery unavailable/);
    await f.get("reconnect").handlers.click();
    assert.equal(f.sockets.length, 2);
  } finally { f.viewer.dispose(); }
});

for (const path of ["/api/browser/sessions/s0", "/api/browser/sessions"]) test(`refresh ${path} cannot erase streamed dialog or resurrect closed account`, async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    f.state(f.sessions[0]);
    f.delayRefresh(path, new Promise(resolve => { release = resolve; }));
    const pending = f.get("reconnect").handlers.click(); await settle();
    const closed = path === "/api/browser/sessions";
    f.state({ ...f.sessions[0], state: closed ? "closed" : "running", dialog: { id: "new-dialog", type: "alert", message: "Newest" } });
    const connections = f.sockets.length;
    release(); await pending;
    assert.equal(f.viewer.session.dialog?.id, "new-dialog");
    assert.equal(f.viewer.session.state, closed ? "closed" : "running");
    if (closed) assert.equal(f.sockets.length, connections, "Old list cannot reconnect a closed account");
  } finally { release(); f.viewer.dispose(); }
});
