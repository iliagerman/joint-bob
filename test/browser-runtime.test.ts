import assert from "node:assert/strict";
import { test } from "node:test";
import { browserCapability, BrowserRuntime, validateBrowserUploads } from "../src/browser-runtime.js";
import { randomUUID } from "node:crypto";
import { browserCommandSchema, browserStartSchema } from "../src/browser-types.js";

test("capability rejects non-Ubuntu Linux and non-Linux even with executable override", async () => {
  for (const options of [{ platform: "darwin", osRelease: 'ID=ubuntu' }, { platform: "linux", osRelease: 'ID=debian\nID_LIKE=ubuntu' }]) {
    const result = await browserCapability({ ...options, executable: process.execPath });
    assert.equal(result.supported, false);
    assert.equal(result.available, false);
    assert.match(result.reason!, /Ubuntu/);
  }
});

test("Ubuntu detection requires executable absolute path and reports missing Chrome", async () => {
  const base = { platform: "linux", osRelease: 'NAME="Ubuntu"\nID="ubuntu"', candidates: [], executable: "" };
  assert.equal((await browserCapability({ ...base, executable: process.execPath })).available, true);
  assert.match((await browserCapability({ ...base, executable: "chrome" })).reason!, /absolute/);
  assert.match((await browserCapability({ ...base, executable: "/does-not-exist/chrome" })).reason!, /executable|install/i);
  assert.match((await browserCapability(base)).reason!, /install.*Chrome|Chrome.*install/i);
});

test("start fails clearly on unavailable executor without asking proxy to route elsewhere", async () => {
  let proxies = 0;
  const runtime = new BrowserRuntime({ proxyFor: async () => { proxies++; throw Error("unexpected proxy"); }, capability: async () => ({ supported: false, available: false, executable: null, reason: "Ubuntu required" }) });
  try {
    await assert.rejects(runtime.create({ projectId: "p", engine: "pi", conversationId: randomUUID(), appNodeId: randomUUID() }), /Ubuntu required/);
    assert.equal(proxies, 0);
  } finally { await runtime.close(); }
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

test("uploads reject traversal, malformed base64, duplicate names and cumulative size", () => {
  const file = (name: string, data = "aGVsbG8=") => ({ name, data });
  for (const name of ["../escape", "/absolute", "a/../b", "a\\b", "a//b", "./a", "x\u0000y", "C:/escape"]) assert.throws(() => validateBrowserUploads([file(name)]), /path|name/i);
  assert.throws(() => validateBrowserUploads([file("a", "%%%")]), /base64/i);
  assert.throws(() => validateBrowserUploads([file("a"), file("a")]), /duplicate/i);
  const big = Buffer.alloc(11 * 1024 * 1024).toString("base64");
  assert.throws(() => validateBrowserUploads([file("a", big), file("b", big)]), /20 MiB/);
  assert.deepEqual(validateBrowserUploads([file("directory/file.txt")])[0], { name: "directory/file.txt", buffer: Buffer.from("hello") });
});
