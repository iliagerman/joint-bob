import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { chromium } from "playwright-core";
import { browserCapability, browserLaunchArguments, BrowserRuntime, shouldSendFrame, validateBrowserUploads } from "../src/browser-runtime.js";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { browserCommandSchema, browserStartSchema } from "../src/browser-types.js";

for (const platform of ["darwin", "linux", "win32", "freebsd"]) {
  test(`capability accepts an installed explicit executable on ${platform}`, async () => {
    assert.deepEqual(await browserCapability({ platform, executable: process.execPath }), {
      supported: true, available: true, executable: process.execPath, reason: null,
    });
  });
}

test("explicit browser path does not depend on Playwright platform discovery", async t => {
  t.mock.method(chromium, "executablePath", () => { throw new Error("Browser is not supported on current platform"); });
  const capability = await browserCapability({ platform: "freebsd", executable: process.execPath });
  assert.equal(capability.available, true);
  assert.equal(capability.executable, process.execPath);
});

async function installedOnly(t: TestContext, executable: string, cacheEntries: string[] = []) {
  const executableStat = await fs.stat(process.execPath);
  t.mock.method(fs, "stat", async (candidate: string) => {
    if (candidate === executable) return executableStat;
    throw Object.assign(new Error("Not installed"), { code: "ENOENT" });
  });
  t.mock.method(fs, "access", async (candidate: string) => { assert.equal(candidate, executable); });
  t.mock.method(fs, "readdir", async () => cacheEntries);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

for (const executable of [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
]) {
  test(`capability discovers installed macOS browser at ${executable}`, async t => {
    await installedOnly(t, executable);
    assert.equal((await browserCapability({ platform: "darwin", executable: "" })).executable, executable);
  });
}

for (const platform of ["darwin", "linux", "win32", "freebsd"]) {
  test(`capability discovers Playwright executable on ${platform} without launching`, async t => {
    const executable = chromium.executablePath();
    await installedOnly(t, executable);
    assert.equal((await browserCapability({ platform, executable: "" })).executable, executable);
  });
}

test("capability preserves Linux installed paths and cached Chromium fallback", async t => {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ms-playwright");
  for (const executable of ["/usr/bin/chromium", path.join(cache, "chromium-999999", "chrome-linux64/chrome")]) {
    await t.test(executable, async t => {
      await installedOnly(t, executable, ["chromium-999999"]);
      assert.equal((await browserCapability({ platform: "linux", executable: "" })).executable, executable);
    });
  }
});

test("capability requires absolute executable paths and reports missing Chrome on this node", async () => {
  const base = { platform: "darwin", candidates: [process.execPath], executable: "" };
  assert.match((await browserCapability({ ...base, executable: "chrome" })).reason!, /absolute.*this node/);
  const missing = await browserCapability({ ...base, executable: "/does-not-exist/chrome" });
  assert.equal(missing.available, false, "Invalid override must not fall back to installed candidates");
  assert.match(missing.reason!, /this node/);
  const absent = await browserCapability({ ...base, candidates: [] });
  assert.equal(absent.supported, true);
  assert.equal(absent.available, false);
  assert.match(absent.reason!, /Chrome.*this node/);
});

test("start reports unavailable local capability without launching Chrome", async t => {
  const launch = t.mock.method(chromium, "launchPersistentContext", async () => { throw Error("Unexpected browser launch"); });
  const runtime = new BrowserRuntime({ capability: async () => ({ supported: true, available: false, executable: null, reason: "Chrome missing on this node" }) });
  try {
    await assert.rejects(runtime.create({ projectId: "p", engine: "pi", conversationId: randomUUID(), appNodeId: randomUUID() }), /Chrome missing on this node/);
    assert.equal(launch.mock.callCount(), 0);
  } finally { await runtime.close(); }
});

test("Linux browser ignores virtual interface churn without changing other platforms", () => {
  assert.deepEqual(browserLaunchArguments("linux"), ["--window-size=1512,945", "--disable-network-change-notifier"]);
  assert.deepEqual(browserLaunchArguments("darwin"), ["--window-size=1512,945"]);
  assert.deepEqual(browserLaunchArguments("win32"), ["--window-size=1512,945"]);
});

test("runtime creates a direct-network context and closes it without a proxy", async t => {
  let contextsClosed = 0;
  const page = Object.assign(new EventEmitter(), { url: () => "about:blank", title: async () => "" });
  const context = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    pages: () => [],
    newPage: async () => { context.emit("page", page); return page; },
    close: async () => { contextsClosed++; },
  });
  const launch = t.mock.method(chromium, "launchPersistentContext", async () => context);
  const runtime = new BrowserRuntime({ capability: async () => ({ supported: true, available: true, executable: process.execPath, reason: null }) });
  try {
    const start = { projectId: "p", engine: "pi" as const, conversationId: randomUUID(), appNodeId: randomUUID() };
    const view = await runtime.create(start);
    assert.equal(view.state, "running");
    const movedAgent = await runtime.create({ ...start, appNodeId: randomUUID(), profileId: view.profileId });
    assert.equal(movedAgent.id, view.id, "Moving the agent must retain its existing browser and account");
    assert.equal(launch.mock.callCount(), 1, "Moving the agent must not launch another browser");
<<<<<<< Updated upstream
    assert.deepEqual(launch.mock.calls[0].arguments, [path.join(process.env.PI_WEB_DATA_DIR!, "browser", "profiles", view.profileId!), { executablePath: process.execPath, headless: true, handleSIGTERM: false, handleSIGINT: false, args: process.platform === "linux" ? ["--window-size=1512,945", "--disable-network-change-notifier"] : ["--window-size=1512,945"], viewport: { width: 1512, height: 945 }, acceptDownloads: true }]);
=======
    assert.deepEqual(launch.mock.calls[0].arguments, [path.join(process.env.PI_WEB_DATA_DIR!, "browser", "profiles", view.profileId!), { executablePath: process.execPath, headless: true, handleSIGTERM: false, handleSIGINT: false, args: browserLaunchArguments(), viewport: { width: 1512, height: 945 }, acceptDownloads: true }]);
>>>>>>> Stashed changes
    await runtime.execute(view.id, { action: "close" }, { kind: "agent" });
    assert.equal((await runtime.get(view.id)).state, "closed");
  } finally { await runtime.close(); }
  assert.equal(contextsClosed, 1);
});

test("browser navigation accepts only HTTP(S), never executor files or privileged browser URLs", () => {
  const start = {projectId:"p",engine:"pi",conversationId:"c",appNodeId:randomUUID()};
  for (const url of ["file:///etc/passwd", "data:text/html,hello", "javascript:alert(1)", "chrome://version", "http://user:password@example.com"]) {
    assert.equal(browserStartSchema.safeParse({...start,url}).success,false,url);
    assert.equal(browserCommandSchema.safeParse({action:"navigate",url}).success,false,url);
    assert.equal(browserCommandSchema.safeParse({action:"newTab",url}).success,false,url);
  }
  for (const url of ["http://localhost:3000", "https://example.com"]) assert.equal(browserCommandSchema.safeParse({action:"navigate",url}).success,true);
});

test("setViewport accepts phone and desktop sizes and rejects absurd dimensions", () => {
  // 320-tall pages cover a phone window shrunk by the on-screen keyboard.
  for (const [width, height] of [[320, 480], [412, 730], [412, 320], [1512, 945]]) {
    assert.equal(browserCommandSchema.safeParse({ action: "setViewport", width, height }).success, true, `${width}x${height}`);
  }
  for (const [width, height] of [[100, 730], [412, 100], [5000, 730], [412, 5000], [412.5, 730]]) {
    assert.equal(browserCommandSchema.safeParse({ action: "setViewport", width, height }).success, false, `${width}x${height}`);
  }
});

test("uploads reject traversal, malformed base64, duplicate names and cumulative size", () => {
  const file = (name: string, data = "aGVsbG8=") => ({ name, data });
  for (const name of ["../escape", "/absolute", "a/../b", "a\\b", "a//b", "./a", "x\u0000y", "C:/escape"]) assert.throws(() => validateBrowserUploads([file(name)]), /path|name/i);
  assert.throws(() => validateBrowserUploads([file("a", "%%%")]), /base64/i);
  assert.throws(() => validateBrowserUploads([file("a"), file("a")]), /duplicate/i);
  const big = Buffer.alloc(11 * 1024 * 1024).toString("base64");
  assert.throws(() => validateBrowserUploads([file("a", big), file("b", big)]), /20 MiB/);
  assert.deepEqual(validateBrowserUploads([file("directory/file.txt")])[0], { name: "directory/file.txt", buffer: Buffer.from("hello") });
});

// The live page streams a JPEG per repaint. A phone on a slow link cannot
// drain them, and a queue of whole frames adds seconds of latency before the
// socket finally fails. Frames are disposable: skip them while the viewer is
// behind, and keep the allowance far below the 1 MiB used for state messages.
test("frames are dropped while a viewer socket is behind", () => {
  assert.equal(shouldSendFrame(0), true, "an idle socket takes frames");
  assert.equal(shouldSendFrame(64 * 1024), true, "a small backlog still takes frames");
  assert.equal(shouldSendFrame(256 * 1024), false, "a quarter-megabyte backlog skips frames");
  assert.equal(shouldSendFrame(1024 * 1024), false, "a megabyte backlog skips frames");
});
