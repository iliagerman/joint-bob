import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const ORIGIN = "https://node.test";

/** Runs public/sw.js against in-memory caches and a scripted network; returns its event handlers. */
async function loadWorker(network: (url: string) => Promise<Response>) {
  const source = (await readFile("public/sw.js", "utf8")).replace(/^const CACHE_NAME = "[^"]+";/m, 'const CACHE_NAME = "joint-bob-current";');
  const stores = new Map<string, Map<string, string>>();
  const key = (input: Request | string) => new URL(typeof input === "string" ? input : input.url, ORIGIN).pathname;
  const open = async (name: string) => {
    const entries = stores.get(name) ?? new Map<string, string>();
    stores.set(name, entries);
    return {
      add: async (request: Request) => {
        const response = await network(key(request));
        if (!response.ok) throw new TypeError(`Request failed: ${response.status}`);
        entries.set(key(request), await response.text());
      },
      // Like the browser's: nothing is stored unless every request succeeds.
      addAll: async (requests: Request[]) => {
        const fetched = await Promise.all(requests.map(async (request) => {
          const response = await network(key(request));
          if (!response.ok) throw new TypeError(`Request failed: ${response.status}`);
          return [key(request), await response.text()] as const;
        }));
        for (const [path, body] of fetched) entries.set(path, body);
      },
      match: async (request: Request | string) => entries.has(key(request)) ? new Response(entries.get(key(request))) : undefined,
    };
  };
  const handlers = new Map<string, (event: unknown) => void>();
  class WorkerRequest extends Request {
    constructor(input: string | Request, init?: RequestInit) { super(typeof input === "string" ? new URL(input, ORIGIN) : input, init); }
  }
  const context = vm.createContext({
    self: { addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler), skipWaiting: () => {} },
    caches: {
      open, keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name),
      // The worker must not search other releases' caches; a call here fails the test.
      match: async () => { throw new Error("caches.match searches every release's cache"); },
    },
    fetch: (request: Request) => network(key(request)),
    Request: WorkerRequest, Response, URL, Promise, console,
  });
  vm.runInContext(source, context);
  return { handlers, stores, open };
}

async function respond(handlers: Map<string, (event: unknown) => void>, path: string, mode: RequestMode = "no-cors") {
  let answer: Promise<Response> | undefined;
  const request = new Request(new URL(path, ORIGIN), { mode: mode === "navigate" ? "same-origin" : mode });
  if (mode === "navigate") Object.defineProperty(request, "mode", { value: "navigate" });
  handlers.get("fetch")!({ request, respondWith: (value: Promise<Response>) => { answer = value; } });
  assert.ok(answer, `the worker answers ${path}`);
  return answer;
}

test("one shell file that cannot be fetched does not fail the worker's install", async () => {
  const { handlers, stores } = await loadWorker(async (url) => url === "/styles.css" ? new Response("busy", { status: 429 }) : new Response(`file ${url}`));
  let installed: Promise<unknown> | undefined;
  handlers.get("install")!({ waitUntil: (value: Promise<unknown>) => { installed = value; } });
  await assert.doesNotReject(installed!, "a refused file must not keep the previous worker in charge");
  const current = stores.get("joint-bob-current")!;
  assert.equal(current.has("/styles.css"), false);
  assert.equal(current.get("/app/resources.js"), "file /app/resources.js", "the other shell files are still cached");
});

test("a worker that cannot fetch the app page itself does not take over", async () => {
  const { handlers } = await loadWorker(async () => { throw new TypeError("fetch failed"); });
  let installed: Promise<unknown> | undefined;
  handlers.get("install")!({ waitUntil: (value: Promise<unknown>) => { installed = value; } });
  await assert.rejects(installed!, /fetch failed/, "with the network down the previous worker keeps serving");
});

test("offline answers come only from this release's cache, never an older release's stylesheet", async () => {
  const worker = await loadWorker(async () => { throw new TypeError("fetch failed"); });
  // An older release's cache, as a worker that never finished updating leaves behind.
  worker.stores.set("joint-bob-older", new Map([["/styles.css", "old stylesheet"]]));
  const missing = await respond(worker.handlers, "/styles.css");
  assert.equal(missing.type, "error", "an older release's stylesheet is never served, and neither is the app page");

  worker.stores.set("joint-bob-current", new Map([["/styles.css", "current stylesheet"], ["/", "<!doctype html>"]]));
  assert.equal(await (await respond(worker.handlers, "/styles.css")).text(), "current stylesheet");
  assert.equal((await respond(worker.handlers, "/app/unknown.js")).type, "error", "a missing script is not answered with the app page");
  assert.equal(await (await respond(worker.handlers, "/some/page", "navigate")).text(), "<!doctype html>", "navigations still fall back to the app page offline");
});
