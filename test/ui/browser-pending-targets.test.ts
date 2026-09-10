import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { resolveDataDirectory } from "../../src/data-directory.js";
import { chromium, type Page } from "playwright-core";
import { BrowserRuntime } from "../../src/browser-runtime.js";

const human = { kind: "human", id: "alice" } as const;
const agent = { kind: "agent" } as const;
const files = [{ name: "private.txt", data: Buffer.from("private bytes").toString("base64") }];
const stale = /changed|stale|request|page|tab/i;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("pending browser requests never redirect approval or files", { timeout: 120000 }, async t => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<title>Pending requests</title><input id="a" type="file"><input id="b" type="file">');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const proxy = http.createServer((req, res) => {
    const upstream = http.request(req.url!, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const runtime = new BrowserRuntime({
    capability: async () => ({ supported: true, available: true, executable: process.env.CHROME_PATH || chromium.executablePath(), reason: null }),
    proxyFor: async () => ({ server: `http://127.0.0.1:${(proxy.address() as import("node:net").AddressInfo).port}`, close: async () => {} }),
  });
  async function fixture() {
    const view = await runtime.create({ projectId: randomUUID(), conversationId: randomUUID(), engine: "pi", appNodeId: randomUUID(), url });
    const live = (runtime as any).sessions.get(view.id);
    const a = live.pages.get(view.activePageId) as Page;
    const b = await live.context.newPage() as Page; await b.goto(url);
    await runtime.execute(view.id, { action: "takeControl" }, human);
    const execute = (command: any, actor: any = human) => runtime.execute(view.id, command, actor);
    const state = () => runtime.get(view.id) as Promise<any>;
    return { live, a, b, execute, state, close: () => execute({ action: "close" }) };
  }
  async function dialog(page: Page, message = "Approve operation?") {
    const opened = page.waitForEvent("dialog");
    const result = page.evaluate(message => confirm(message), message).catch(() => false);
    return { dialog: await opened, result };
  }
  async function chooser(page: Page, selector: string) {
    const opened = page.waitForEvent("filechooser");
    await page.locator(selector).click(); await opened;
  }
  try {
    for (const samePage of [false, true]) {
      await t.test(`stale dialog approval rejected on ${samePage ? "same-page" : "cross-page"} replacement`, async () => {
        const f = await fixture();
        try {
          const first = await dialog(f.a);
          const old = (await f.state()).dialog;
          if (samePage) { await first.dialog.dismiss(); await first.result; }
          const second = await dialog(samePage ? f.a : f.b);
          await assert.rejects(f.execute({ action: "dialog", accept: true, expectedPageId: old.pageId || [...f.live.pages.keys()][0], requestId: old.id || randomUUID() }), stale);
          const current = (await f.state()).dialog;
          assert.ok(current, "Stale approval must leave replacement pending");
          await f.execute({ action: "dialog", accept: true, expectedPageId: current.pageId, requestId: current.id });
          assert.equal(await second.result, true);
          if (!samePage) { await first.dialog.dismiss(); await first.result; }
        } finally { await f.close(); }
      });
      await t.test(`stale upload rejected on ${samePage ? "same-page" : "cross-page"} replacement`, async () => {
        const f = await fixture();
        try {
          await chooser(f.a, "#a"); const old = (await f.state()).fileChooserRequest;
          const target = samePage ? f.a : f.b;
          await chooser(target, "#b");
          // Keep active page equal to the stale page: a page-only check is insufficient.
          f.live.activePageId = [...f.live.pages.keys()][0];
          await assert.rejects(f.execute({ action: "upload", files, expectedPageId: old?.pageId || f.live.activePageId, requestId: old?.id || randomUUID() }), stale);
          assert.equal(await target.locator("#b").evaluate((input: HTMLInputElement) => input.files!.length), 0);
          const current = (await f.state()).fileChooserRequest;
          await f.execute({ action: "upload", files, expectedPageId: current.pageId, requestId: current.id });
          assert.equal(await target.locator("#b").evaluate((input: HTMLInputElement) => input.files![0].text()), "private bytes");
        } finally { await f.close(); }
      });
    }
    await t.test("human responses require identities while agent dialog commands remain compatible", async () => {
      const f = await fixture();
      try {
        const pending = await dialog(f.b);
        await assert.rejects(f.execute({ action: "dialog", accept: true }), /request|target/i);
        await f.execute({ action: "resumeAgent" });
        await f.execute({ action: "dialog", accept: false }, agent);
        assert.equal(await pending.result, false);
      } finally { await f.execute({ action: "takeControl" }); await f.close(); }
    });
    await t.test("human uploads cannot omit identity or bypass chooser binding with a selector", async () => {
      const f = await fixture();
      try {
        await chooser(f.b, "#a");
        await assert.rejects(f.execute({ action: "upload", files }), /request|target/i);
        const current = (await f.state()).fileChooserRequest;
        await assert.rejects(f.execute({ action: "upload", selector: "#b", files, expectedPageId: current.pageId, requestId: current.id }), /selector|chooser/i);
        assert.equal(await f.b.locator("#b").evaluate((input: HTMLInputElement) => input.files!.length), 0);
      } finally { await f.close(); }
    });
    await t.test("agent implicit chooser is captured before queued work", async () => {
      const f = await fixture(); const blocked = gate();
      try {
        await f.execute({ action: "resumeAgent" });
        await chooser(f.b, "#a");
        f.live.queue = blocked.promise;
        const upload = f.execute({ action: "upload", files }, agent);
        const rejected = assert.rejects(upload, stale); void rejected.catch(() => {});
        await chooser(f.b, "#b"); blocked.resolve(); await rejected;
        assert.equal(await f.b.locator("#b").evaluate((input: HTMLInputElement) => input.files!.length), 0);
        await f.execute({ action: "upload", selector: "#a", files }, agent);
        assert.equal(await f.b.locator("#a").evaluate((input: HTMLInputElement) => input.files![0].text()), "private bytes");
      } finally { blocked.resolve(); await f.execute({ action: "takeControl" }); await f.close(); }
    });
    await t.test("legacy selector upload follows the preceding queued tab selection", async () => {
      const f = await fixture(); const blocked = gate();
      try {
        await f.execute({ action: "resumeAgent" });
        const [aId, bId] = [...f.live.pages.keys()];
        await f.execute({ action: "selectTab", pageId: aId }, agent);
        f.live.queue = blocked.promise;
        const select = f.execute({ action: "selectTab", pageId: bId }, agent);
        const upload = f.execute({ action: "upload", selector: "#a", files }, agent);
        void upload.catch(() => {});
        blocked.resolve(); await select; await upload;
        assert.equal(await f.a.locator("#a").evaluate((input: HTMLInputElement) => input.files!.length), 0);
        assert.equal(await f.b.locator("#a").evaluate((input: HTMLInputElement) => input.files![0].text()), "private bytes");
      } finally { blocked.resolve(); await f.execute({ action: "takeControl" }); await f.close(); }
    });
    await t.test("legacy upload can wait for its preceding click to open the first chooser", async () => {
      const f = await fixture(); const blocked = gate();
      try {
        await f.execute({ action: "resumeAgent" });
        assert.equal((await f.state()).fileChooser, false);
        f.live.queue = blocked.promise;
        const click = f.execute({ action: "clickElement", selector: "#a" }, agent);
        const upload = f.execute({ action: "upload", files }, agent);
        void upload.catch(() => {});
        blocked.resolve(); await click; await upload;
        assert.equal(await f.b.locator("#a").evaluate((input: HTMLInputElement) => input.files![0].text()), "private bytes");
      } finally { blocked.resolve(); await f.execute({ action: "takeControl" }); await f.close(); }
    });
    await t.test("End during staged writes cannot leave recreated private upload files", async () => {
      const f = await fixture(); const blocked = gate(); const entered = gate();
      const writeFile = fs.writeFile;
      const staging = path.join(resolveDataDirectory(), "browser", f.live.id, "staging");
      let upload: Promise<unknown> | undefined;
      try {
        await chooser(f.b, "#a"); const old = (await f.state()).fileChooserRequest;
        let gated = false;
        fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
          await writeFile(...args);
          if (!gated && String(args[0]).startsWith(staging + path.sep)) {
            gated = true; entered.resolve(); await blocked.promise;
          }
        }) as typeof fs.writeFile;
        syncBuiltinESMExports();
        upload = f.execute({ action: "upload", files: [...files, { ...files[0], name: "second.txt" }], expectedPageId: old.pageId, requestId: old.id });
        void upload.catch(() => {});
        await entered.promise;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([f.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("End blocked by staged writes")), 3000); })]);
        } finally { clearTimeout(timer); }
        blocked.resolve(); await assert.rejects(upload, /not running|closed/i);
        assert.deepEqual(await fs.readdir(staging).catch(error => { if (error.code === "ENOENT") return []; throw error; }), [], "Ended upload must remove its recreated staging directory and private files");
      } finally {
        fs.writeFile = writeFile; syncBuiltinESMExports(); blocked.resolve(); await upload?.catch(() => {});
        if (!f.live.stopped) await f.close();
      }
    });
    await t.test("ownership change during preparation rejects upload and removes private staging", async () => {
      const f = await fixture(); const blocked = gate(); const entered = gate();
      const staging = path.join(resolveDataDirectory(), "browser", f.live.id, "staging");
      try {
        await chooser(f.b, "#a"); const old = (await f.state()).fileChooserRequest;
        const element = f.live.chooser.chooser.element(); const evaluate = element.evaluate.bind(element);
        element.evaluate = async (...args: any[]) => { entered.resolve(); await blocked.promise; return evaluate(...args); };
        const upload = f.execute({ action: "upload", files, expectedPageId: old.pageId, requestId: old.id });
        void upload.catch(() => {});
        await entered.promise;
        await f.execute({ action: "takeControl", force: true }, { kind: "human", id: "bob" });
        blocked.resolve(); await assert.rejects(upload, /control|owned/i);
        assert.equal(await f.b.locator("#a").evaluate((input: HTMLInputElement) => input.files!.length), 0, "Former controller must not deliver files");
        assert.deepEqual(await fs.readdir(staging).catch(error => { if (error.code === "ENOENT") return []; throw error; }), [], "Failed ownership check must remove private staging");
      } finally { blocked.resolve(); await f.execute({ action: "takeControl", force: true }); await f.close(); }
    });
    await t.test("replacement during upload preparation rejects bytes and keeps dialog preemption", async () => {
      const f = await fixture(); const blocked = gate(); const entered = gate();
      try {
        await chooser(f.b, "#a");
        const old = (await f.state()).fileChooserRequest;
        const element = f.live.chooser.chooser.element();
        const evaluate = element.evaluate.bind(element);
        element.evaluate = async (...args: any[]) => { entered.resolve(); await blocked.promise; return evaluate(...args); };
        const upload = f.execute({ action: "upload", files, expectedPageId: old?.pageId || f.live.activePageId, requestId: old?.id || randomUUID() });
        const rejected = assert.rejects(upload, stale); void rejected.catch(() => {});
        await entered.promise;
        await chooser(f.b, "#b");
        const pending = await dialog(f.b);
        const current = (await f.state()).dialog;
        await f.execute({ action: "dialog", accept: false, expectedPageId: current.pageId || f.live.activePageId, requestId: current.id || randomUUID() });
        assert.equal(await pending.result, false, "Dialog must preempt blocked upload");
        blocked.resolve(); await rejected;
        assert.equal(await f.b.locator("#a").evaluate((input: HTMLInputElement) => input.files!.length), 0, "Invalidated chooser must not receive bytes either");
        assert.ok((await f.state()).fileChooserRequest, "Replacement chooser remains pending");
      } finally { blocked.resolve(); await f.close(); }
    });
    await t.test("dialog completion does not erase a same-page replacement", async () => {
      const f = await fixture();
      try {
        const first = await dialog(f.b, "first");
        const old = (await f.state()).dialog;
        const accept = first.dialog.accept.bind(first.dialog);
        let second: Awaited<ReturnType<typeof dialog>>;
        first.dialog.accept = async text => { await accept(text); await first.result; second = await dialog(f.b, "second"); };
        await f.execute({ action: "dialog", accept: true, expectedPageId: old.pageId || f.live.activePageId, requestId: old.id || randomUUID() });
        assert.equal((await f.state()).dialog?.message, "second", "Completing first dialog must not erase second");
        await second!.dialog.dismiss(); await second!.result;
      } finally { await f.close(); }
    });
    await t.test("upload completion does not erase a same-page replacement", async () => {
      const f = await fixture();
      try {
        await chooser(f.b, "#a"); const old = (await f.state()).fileChooserRequest;
        const first = f.live.chooser.chooser;
        const setFiles = first.setFiles.bind(first);
        first.setFiles = async (files: any) => { await setFiles(files); await chooser(f.b, "#b"); };
        await f.execute({ action: "upload", files, expectedPageId: old?.pageId || f.live.activePageId, requestId: old?.id || randomUUID() });
        assert.equal((await f.state()).fileChooser, true, "Completing first upload must not erase second chooser");
      } finally { await f.close(); }
    });
  } finally {
    await runtime.close(); proxy.closeAllConnections(); proxy.close(); server.closeAllConnections(); server.close();
  }
});
