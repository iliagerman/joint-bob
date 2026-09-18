import assert from "node:assert/strict";
import test from "node:test";
import { chromeExecutable, launchChrome } from "./ui/launch-chrome.js";

const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };

// A node whose only Chrome is Joint Bob's bundled copy must hear that, not Playwright's
// "Executable doesn't exist at .../ms-playwright/..." from a browser it never downloaded.
test("test browser resolution reports the node's own advice instead of a bundled-Chromium miss", async t => {
  const previous = { CHROME_PATH: process.env.CHROME_PATH, CHROME_CHANNEL: process.env.CHROME_CHANNEL, JOINT_BOB_BROWSER_EXECUTABLE: process.env.JOINT_BOB_BROWSER_EXECUTABLE };
  t.after(() => { for (const [name, value] of Object.entries(previous)) restore(name, value); });
  delete process.env.CHROME_PATH;
  delete process.env.CHROME_CHANNEL;
  process.env.JOINT_BOB_BROWSER_EXECUTABLE = "/does-not-exist/google-chrome";

  await assert.rejects(chromeExecutable(), /Browser executable unavailable on this node/);
  await assert.rejects(launchChrome({ headless: true }), /Browser executable unavailable on this node/);

  process.env.CHROME_PATH = "/pinned/google-chrome";
  assert.equal(await chromeExecutable(), "/pinned/google-chrome", "CHROME_PATH must outrank detection");
});

// test/setup.mjs redirects HOME to a throwaway directory, which is where the homeserver's UI
// suite lost the cached Chromium: detection rebuilds the cache path from the redirected home.
test("test harness keeps Playwright's browser cache reachable after HOME is redirected", () => {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH;
  assert.ok(cache, "test/setup.mjs must pin PLAYWRIGHT_BROWSERS_PATH before redirecting HOME");
  assert.ok(!cache.startsWith(process.env.HOME!), `Browser cache ${cache} must not resolve under the throwaway home`);
});
