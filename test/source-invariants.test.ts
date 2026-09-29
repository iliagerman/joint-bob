import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { appSource, serverSource } from "./source.js";

test("every app module ships in the offline service-worker shell", async () => {
  const serviceWorker = await readFile("public/sw.js", "utf8");
  const shell = new Set(JSON.parse(serviceWorker.match(/const APP_SHELL = (\[[^\]]*\]);/)![1]) as string[]);
  const modules = (await readdir("public/app")).filter((name) => name.endsWith(".js")).map((name) => `/app/${name}`);
  assert.deepEqual(modules.filter((module) => !shell.has(module)), []);
});

test("only canvas panes may be framed, and only by the same origin", async () => {
  assert.match(await serverSource(), /request\.path === "\/" && request\.query\.canvasPane === "1" \? "SAMEORIGIN" : "DENY"/);
});

test("the UI exposes no peer bearer tokens or hardcoded account token inputs", async () => {
  const [html, app] = await Promise.all([readFile("public/index.html", "utf8"), appSource()]);
  assert.doesNotMatch(html, /clusterLocalToken|clusterPeerUrlInput|clusterPeerTokenInput/);
  assert.doesNotMatch(html + app, /personalTokenInput|selaTokenInput/);
});
