import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import type { Request, Response } from "express";
import { securityHeaders } from "../src/server/http-auth.js";
import { appSource } from "./source.js";

test("every app module ships in the offline service-worker shell", async () => {
  const serviceWorker = await readFile("public/sw.js", "utf8");
  const shell = new Set(JSON.parse(serviceWorker.match(/const APP_SHELL = (\[[^\]]*\]);/)![1]) as string[]);
  const modules = (await readdir("public/app")).filter((name) => name.endsWith(".js")).map((name) => `/app/${name}`);
  assert.deepEqual(modules.filter((module) => !shell.has(module)), []);
});

test("only canvas panes and file previews may be framed, and only by the same origin", () => {
  for (const [url, expected] of [
    ["/?canvasPane=1", "SAMEORIGIN"],
    ["/api/projects/project-id/file?path=report.pdf", "SAMEORIGIN"],
    ["/", "DENY"],
    ["/?canvasPane=0", "DENY"],
    ["/assistant.html?canvasPane=1", "DENY"],
    ["/api/projects", "DENY"],
    ["/api/projects/project-id/file?browser=1", "DENY"],
    ["/api/projects/project-id/file?download=1", "DENY"],
    ["/api/projects/project-id/file-resolution", "DENY"],
  ]) {
    const parsed = new URL(url, "http://127.0.0.1");
    const headers = new Map<string, string>();
    securityHeaders(
      { path: parsed.pathname, query: Object.fromEntries(parsed.searchParams) } as Request,
      { setHeader: (name: string, value: string) => headers.set(name, value) } as unknown as Response,
      () => {},
    );
    assert.equal(headers.get("X-Frame-Options"), expected, url);
  }
});

test("the UI exposes no peer bearer tokens or hardcoded account token inputs", async () => {
  const [html, app] = await Promise.all([readFile("public/index.html", "utf8"), appSource()]);
  assert.doesNotMatch(html, /clusterLocalToken|clusterPeerUrlInput|clusterPeerTokenInput/);
  assert.doesNotMatch(html + app, /personalTokenInput|selaTokenInput/);
});
