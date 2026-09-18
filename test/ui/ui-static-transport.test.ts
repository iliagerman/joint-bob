import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { installStaticBrowserTransport } from "../static-browser-transport.mjs";

test("static transport retries one reset and exposes permanent failures", async () => {
  await installStaticBrowserTransport();

  let styleAttempts = 0;
  let brokenAttempts = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><link rel="stylesheet" href="/style.css"><body>fixture</body>');
      return;
    }
    if (request.url === "/style.css") {
      styleAttempts += 1;
      if (styleAttempts === 1) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "text/css" });
      response.end("body{--fixture-ready:yes}");
      return;
    }
    if (request.url === "/broken.css") {
      brokenAttempts += 1;
      request.socket.destroy();
      return;
    }
    response.writeHead(404).end();
  });

  let browser: Browser | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    browser = await launchChrome({ headless: true });
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(origin);

    assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--fixture-ready")), "yes");
    assert.equal(styleAttempts, 2, "a reset static GET is retried exactly once");
    await assert.rejects(page.addStyleTag({ url: `${origin}/broken.css` }));
    assert.equal(brokenAttempts, 2, "a permanently failing static GET stops after one retry");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
