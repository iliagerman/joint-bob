import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserRuntime } from "../../src/browser-runtime.js";

const agent = { kind: "agent" } as const;
const human = { kind: "human", id: "alice" } as const;
const other = { kind: "human", id: "bob" } as const;

test("real browser isolates profiles, enforces ownership, streams popups, retains uploads and restores native logins", { timeout: 120000 }, async () => {
  let longStarted = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/long-started") { longStarted = true; res.end("started"); return; }
    if (req.url === "/download") { res.writeHead(200, { "content-disposition": 'attachment; filename="proof.txt"' }); res.end("download-proof"); return; }
    res.setHeader("content-type", "text/html");
    res.end(`<title>Runtime fixture</title><label>Name<input id="name"></label><button onclick="window.open('/popup','login','width=520,height=400')">Popup</button><button onclick="alert('hello dialog')">Dialog</button><input type="file" id="files" multiple><input type="file" id="directory" webkitdirectory><a href="/download">Download</a>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(wss, "listening");
  let runtime = new BrowserRuntime();
  const start = { projectId: randomUUID(), engine: "pi" as const, conversationId: randomUUID(), appNodeId: randomUUID(), url };
  let viewer: WebSocket | undefined;
  try {
    const a = await runtime.create(start);
    assert.equal((await runtime.create(start)).id, a.id);
    await runtime.execute(a.id, { action: "takeControl" }, human);
    const switched = await runtime.create({ ...start, engine: "claude" });
    assert.equal(switched.id, a.id, "Harness switches must keep the same logical conversation browser");
    assert.equal(switched.owner, "human");
    await runtime.execute(a.id, { action: "resumeAgent" }, human);
    const moved = await runtime.create({ ...start, appNodeId: randomUUID(), profileId: a.profileId });
    assert.equal(moved.id, a.id, "Moving the agent keeps the same real browser and account");
    assert.equal(moved.nodeId, a.nodeId, "Browser physical owner stays pinned");
    const b = await runtime.create({ ...start, conversationId: randomUUID() });
    const execute = (command: any, actor: any = agent) => runtime.execute(a.id, command, actor);
    await assert.rejects(execute({ action: "fill", selector: "label=Name", text: "never disclose", expectedOrigin: "https://wrong-origin.test" }), /origin/i);
    await execute({ action: "fill", selector: "label=Name", text: "agent value", expectedOrigin: url });
    const snapshot = await execute({ action: "snapshot" });
    assert.match(JSON.stringify(snapshot), /Name/);
    await assert.rejects(execute({ action: "text", text: "bad" }, human), /control/i);
    await execute({ action: "takeControl" }, human);
    await assert.rejects(execute({ action: "takeControl" }, other), /another|owned/i);
    await assert.rejects(execute({ action: "resumeAgent" }, other), /another|owned/i);
    await execute({ action: "takeControl", force: true }, other);
    await assert.rejects(execute({ action: "text", text: "old controller" }, human), /another|owned/i);
    await execute({ action: "takeControl", force: true }, human);
    await assert.rejects(execute({ action: "takeControl" }), /human/i);
    await assert.rejects(execute({ action: "fill", selector: "#name", text: "bad" }), /human control/i);
    await execute({ action: "snapshot" });
    await execute({ action: "resumeAgent" }, human);
    const takeover = execute({ action: "takeControl" }, human);
    const queued = execute({ action: "fill", selector: "#name", text: "queued bad" });
    await takeover; await assert.rejects(queued, /human control/i);
    await execute({ action: "resumeAgent" }, human);
    assert.equal(await execute({ action: "evaluate", expression: "document.querySelector('#name').value" }), "agent value");
    const connection = once(wss, "connection");
    viewer = new WebSocket(`ws://127.0.0.1:${(wss.address() as net.AddressInfo).port}`);
    const frames: any[] = []; viewer.on("message", raw => frames.push(JSON.parse(raw.toString())));
    await runtime.attachViewer(a.id, (await connection)[0], human);
    await waitFor(() => frames.some(frame => frame.type === "browserFrame"));
    viewer.send(JSON.stringify({ type: "browserCommand", command: { action: "fill", selector: "#name", text: "unauthorized" } }));
    await waitFor(() => frames.some(frame => frame.type === "browserError" && /control/i.test(frame.error)));
    viewer.send(JSON.stringify({ type: "browserCommand", command: { action: "click", x: -1, y: 0 } }));
    await waitFor(() => frames.filter(frame => frame.type === "browserError").length === 2);
    await execute({ action: "clickElement", selector: "role=button[name=Popup]" });
    await waitFor(async () => (await runtime.get(a.id)).tabs.length === 2);
    const popup = (await runtime.get(a.id)).activePageId!;
    await assert.rejects(execute({ action: "fill", selector: "#name", text: "wrong page", expectedPageId: a.tabs[0].id }), /page|tab/i);
    await waitFor(() => frames.some(frame => frame.type === "browserFrame" && frame.pageId === popup));
    const frame = frames.find(frame => frame.type === "browserFrame" && frame.pageId === popup);
    const viewport = await execute({ action: "evaluate", expression: "({width:innerWidth,height:innerHeight})" }) as any;
    assert.equal(viewport.width, 520, "popup keeps its requested natural width");
    assert.equal(frame.width, viewport.width); assert.equal(frame.height, viewport.height);
    await execute({ action: "closeTab", pageId: popup });
    await execute({ action: "takeControl" }, human);
    viewer.close(); await once(viewer, "close");
    assert.equal((await runtime.get(a.id)).owner, "human");
    await execute({ action: "resumeAgent" }, human);
    const screenshot = await execute({ action: "screenshot" }) as any;
    assert.equal(Buffer.from(screenshot.data, "base64").subarray(1, 4).toString(), "PNG");
    await execute({ action: "clickElement", selector: "#files" });
    assert.equal((await runtime.get(a.id)).fileChooser, true);
    await execute({ action: "upload", files: [{ name: "one.txt", data: Buffer.from("lazy-file-proof").toString("base64") }] });
    assert.equal(await execute({ action: "evaluate", expression: "document.querySelector('#files').files[0].text()" }), "lazy-file-proof");
    await execute({ action: "upload", selector: "#directory", files: [{ name: "folder/nested/file.txt", data: Buffer.from("directory-proof").toString("base64") }] });
    assert.equal(await execute({ action: "evaluate", expression: "document.querySelector('#directory').files[0].webkitRelativePath" }), "folder/nested/file.txt");
    await execute({ action: "clickElement", selector: "text=Dialog" });
    assert.equal((await runtime.get(a.id)).dialog?.message, "hello dialog");
    await execute({ action: "dialog", accept: true });
    await execute({ action: "clickElement", selector: "text=Download" });
    await waitFor(async () => (await runtime.get(a.id)).downloads.some(item => item.ready));
    const download = (await runtime.get(a.id)).downloads[0];
    assert.equal(await readFile((await runtime.download(a.id, download.id)).path, "utf8"), "download-proof");
    await assert.rejects(runtime.download(b.id, download.id), /download/i);
    await execute({ action: "evaluate", expression: "localStorage.setItem('login','saved-login'); document.cookie='login=cookie-proof; path=/; Max-Age=3600'" });
    const profile = await execute({ action: "saveProfile", label: "Saved login" }) as any;
    assert.equal(await runtime.execute(b.id, { action: "evaluate", expression: "localStorage.getItem('login')" }, agent), null);
    await assert.rejects(runtime.create({ ...start, projectId: "wrong", conversationId: randomUUID(), profileId: profile.id }), /profile/i);
    await execute({ action: "close" });
    assert.equal((runtime as unknown as { sessions: Map<string, unknown> }).sessions.has(a.id), false, "Ended browser must release its live context and retained command results");
    assert.equal((await runtime.get(b.id)).state, "running");
    await runtime.close(); runtime = new BrowserRuntime();
    await runtime.ready();
    assert.equal((await runtime.get(b.id)).state, "running", "Running native profiles restore automatically on restart");
    assert.equal(await readFile((await runtime.download(a.id, download.id)).path, "utf8"), "download-proof");
    const restored = await runtime.create({ ...start, profileId: profile.id });
    assert.equal(await runtime.execute(restored.id, { action: "evaluate", expression: "localStorage.getItem('login')" }, agent), "saved-login");
    const blank = await runtime.create({ ...start, conversationId: randomUUID() });
    assert.equal(await runtime.execute(blank.id, { action: "evaluate", expression: "document.cookie" }, agent), "");
    assert.match(String(await runtime.execute(restored.id, { action: "evaluate", expression: "document.cookie" }, agent)), /cookie-proof/);
    await assert.rejects(runtime.deleteProfile(profile.id, start.projectId), /in use/i);
    await runtime.execute(restored.id, { action: "close" }, agent);
    await runtime.deleteProfile(profile.id, start.projectId);
    const pending = runtime.execute(blank.id, { action: "evaluate", expression: `fetch('${url}/long-started').then(() => new Promise(() => {}))` }, agent).catch(() => undefined);
    await waitFor(() => longStarted);
    await runtime.execute(blank.id, { action: "takeControl" }, human);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([runtime.execute(blank.id, { action: "close" }, human), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("End browser stuck behind an in-flight command")), 3000); })]);
    } finally { clearTimeout(timer); }
    await pending;
    assert.equal((await runtime.get(blank.id)).state, "closed");
  } finally {
    viewer?.terminate(); for (const socket of wss.clients) socket.terminate();
    await runtime.close(); wss.close(); server.closeAllConnections(); server.close();
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) { if (Date.now() > deadline) throw Error("Timed out waiting for browser state/frame"); await new Promise(resolve => setTimeout(resolve, 25)); }
}
