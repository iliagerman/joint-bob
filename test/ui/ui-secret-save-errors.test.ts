import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser, type Locator } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

/** True when the element is what the user sees at its centre, not something under a modal backdrop. */
function onTop(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  });
}

test("secret account save errors show on the dialog on top and leave a trace in the client and server logs", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-secret-save-errors-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let serverLog = "";
  server.stderr!.on("data", (chunk) => { serverLog += String(chunk); });
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-secrets").click();
    await page.getByTestId("secret-account-add-button").click();
    const dialog = page.getByTestId("secret-account-dialog");
    const error = dialog.getByTestId("secret-account-error");
    assert.equal(await error.isVisible(), false, "a fresh form shows no error");

    // Refused by the form itself: nothing reaches the server, so only the client log can tell.
    await page.getByTestId("secret-account-label-input").fill("Synthetic AWS");
    await page.getByTestId("secret-account-save-button").click();
    await error.waitFor();
    assert.match(await error.textContent() ?? "", /Enter at least one variable with a value/);
    assert.ok(await onTop(error), "the error is above every backdrop, not under one");
    const colours = await error.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--danger)";
      element.append(probe);
      const result = { error: getComputedStyle(element).color, danger: getComputedStyle(probe).color };
      probe.remove();
      return result;
    });
    assert.equal(colours.error, colours.danger, "the error uses the danger colour, not the muted dialog text");
    const refused = await page.evaluate(`window.jointBobClientLogs.entries().filter((entry) => entry.includes("Could not save secret account"))`) as string[];
    assert.equal(refused.length, 1, refused.join("\n"));
    assert.match(refused[0], /WARN .*"provider":"aws".*"status":null.*Enter at least one variable/);

    // A toast raised while Settings and the account dialog are both open lands in the top one.
    await page.evaluate(`import("/app/shell.js").then(({ toast }) => toast("Synthetic toast above the dialog"))`);
    const toast = page.locator(".toast", { hasText: "Synthetic toast above the dialog" });
    await toast.waitFor();
    assert.equal(await toast.evaluate((element) => element.closest("dialog")?.id), "secretAccountDialog");
    assert.ok(await onTop(toast), "the toast is not hidden behind the account dialog's backdrop");

    // Rejected by the server's validation: once silent there, now logged without the values.
    for (const value of await page.getByTestId("secret-variable-value-input").all()) await value.fill("synthetic-secret-value-123");
    await page.getByTestId("secret-account-label-input").fill("L".repeat(65));
    const rejected = page.waitForResponse((response) => response.url().endsWith("/api/secrets/accounts") && response.request().method() === "POST");
    await page.getByTestId("secret-account-save-button").click();
    assert.equal((await rejected).status(), 400);
    await page.waitForFunction(() => document.querySelector('[data-testid="secret-account-error"]')?.textContent?.includes("64"));
    assert.ok(await onTop(error));
    assert.ok(await dialog.isVisible(), "the form stays open so the user can correct it");
    const logged = await page.evaluate(`window.jointBobClientLogs.entries().filter((entry) => entry.includes("Could not save secret account"))`) as string[];
    assert.equal(logged.length, 2, logged.join("\n"));
    assert.match(logged[1], /"method":"POST","status":400/);
    const deadline = Date.now() + 5_000;
    while (!serverLog.includes("Rejected POST /api/secrets/accounts") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(serverLog, /Rejected POST \/api\/secrets\/accounts \(400\): label: String must contain at most 64 character/);
    assert.ok(![...logged, serverLog].some((text) => text.includes("synthetic-secret-value-123")), "secret values never reach either log");

    // Correcting it saves, closes the dialog and clears the error for next time.
    await page.getByTestId("secret-account-label-input").fill("Synthetic AWS");
    const created = page.waitForResponse((response) => response.url().endsWith("/api/secrets/accounts") && response.request().method() === "POST");
    await page.getByTestId("secret-account-save-button").click();
    assert.equal((await created).status(), 201);
    await dialog.waitFor({ state: "hidden" });
    await page.getByTestId("secret-account-add-button").click();
    assert.equal(await error.isVisible(), false, "a reopened form starts without the old error");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
