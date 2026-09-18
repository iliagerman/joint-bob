import { chromium, type Browser, type LaunchOptions } from "playwright-core";
import { browserCapability } from "../../src/browser-runtime.js";

// Repository UI tests only. Drives the Chrome this node actually has, resolved by the same
// detection the product uses, so nodes without a system-wide Chrome still run the suite.
// Precedence: CHROME_PATH pins an absolute binary, CHROME_CHANNEL forces a named Playwright
// channel, otherwise browserCapability() resolves one.

/**
 * Absolute path of the Chrome this node drives. Tests that hand an executable to a dev node
 * need the path itself, not a launched browser. Fails with the product's own advice rather
 * than letting Playwright fall back to a bundled Chromium the node never downloaded.
 */
export async function chromeExecutable(): Promise<string> {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const capability = await browserCapability();
  if (!capability.executable) throw new Error(capability.reason ?? "No Chrome executable on this node");
  return capability.executable;
}

export async function launchChrome(options: LaunchOptions = {}): Promise<Browser> {
  if (!process.env.CHROME_PATH && process.env.CHROME_CHANNEL) return chromium.launch({ ...options, channel: process.env.CHROME_CHANNEL });
  return chromium.launch({ ...options, executablePath: await chromeExecutable() });
}
