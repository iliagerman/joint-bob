// Browser suite for the relay screens: Settings → Relay (this machine as a relay) and
// Settings → Relay → Joined relays (this machine's memberships). It drives a real Chrome against a
// seeded node, turns relay serving on with a loopback address, creates tokens, and checks that
// the lists page instead of scrolling, secrets are shown once, and errors stay inline.
//
// Run with `npm run test:file -- test/ui/ui-relay.test.ts`. Like the rest of test/ui it needs a
// Chrome binary, and it fails rather than skipping when there is none.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "../dev-nodes.js";
import { qrMatrix } from "../../public/app/qr.js";

const RENAMED = "relay-home";
const TWO_FACTOR_MESSAGE = "Invalid username or password. Signing in from a phone through a relay also needs two-factor authentication on this machine.";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let session: SignedIn;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let relayOrigin: string;
let tokenSecret = "";
const consoleErrors: string[] = [];
const failedResponses: string[] = [];
const expectedFailures: string[] = [];

/** Error paths are tested on purpose; each one is announced here so the final check can tell it from a real failure. */
function expectFailure(status: number, method: string, pathname: string): void {
  expectedFailures.push(`${status} ${method} ${pathname}`);
}

/** Set JOINT_BOB_UI_SCREENSHOTS to a directory to keep a picture of each relay screen for review. */
async function shot(name: string): Promise<void> {
  const directory = process.env.JOINT_BOB_UI_SCREENSHOTS;
  if (directory) await page.screenshot({ path: path.join(directory, `relay-${name}.png`) });
}

async function openSettingsTab(tab: string): Promise<void> {
  if (!(await page.getByTestId("settings-dialog").isVisible())) await page.getByTestId("settings-open-button").click();
  await page.getByTestId(`settings-tab-${tab}`).click();
}

async function closeSettings(): Promise<void> {
  if (await page.getByTestId("settings-dialog").isVisible()) {
    await page.getByTestId("settings-cancel-button").click();
    await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
  }
}

async function openRelaySection(section: "serving" | "machines" | "tokens" | "audit"): Promise<void> {
  await openSettingsTab("relay");
  await page.getByTestId(`relay-tab-${section}`).click();
  await page.getByTestId(`relay-${section}-section`).waitFor({ state: "visible" });
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-relay-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  relayOrigin = `http://localhost:${node.port}`;
  server = await startDevNode(environment, node);
  session = await signIn(environment, node);

  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    serviceWorkers: "block",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  page = await context.newPage();
  page.setDefaultNavigationTimeout(60_000);
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
}, { timeout: 120_000 });

after(async () => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, "final.png") }).catch(() => undefined);
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("signing in reaches the app", async () => {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 20_000 });
});

test("the Relay tab sits right after Cluster and starts with serving off", async () => {
  await page.getByTestId("settings-open-button").click();
  const tabs = await page.locator("[data-settings-tab]").evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.settingsTab));
  assert.equal(tabs[tabs.indexOf("cluster") + 1], "relay", `Relay follows Cluster in the tab list: ${tabs.join(", ")}`);
  const options = await page.locator(".settings-tabs-select option").evaluateAll((items) => items.map((item) => (item as HTMLOptionElement).value));
  assert.equal(options[options.indexOf("cluster") + 1], "relay", `Relay follows Cluster in the select: ${options.join(", ")}`);

  await page.getByTestId("settings-tab-relay").click();
  await page.getByTestId("settingsPanel-relay").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("relay-tab-joined").getAttribute("aria-selected"), "true", "the joined relays open first");
  await page.getByTestId("relay-joined-section").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("relay-summary").isVisible(), false, "the serving summary stays on the serving sections");
  assert.equal(await page.getByTestId("relay-serving-section").isVisible(), false);
  await page.getByTestId("relay-tab-serving").click();
  await page.getByTestId("relay-serving-section").waitFor({ state: "visible" });
  await page.getByTestId("relay-summary-state").filter({ hasText: "Off" }).waitFor();
  assert.equal(await page.getByTestId("relay-enabled-toggle").isChecked(), false, "serving is off by default");
  assert.equal(await page.getByTestId("relay-check-button").isDisabled(), true, "the DNS and TLS check waits for serving to be on");
  assert.equal(await page.getByTestId("relay-check-hint").isVisible(), true, "the check explains why it is disabled");
});

test("a bad public address is refused with the server's own words", async () => {
  await page.getByTestId("relay-enabled-toggle").check();
  await page.getByTestId("relay-origin-input").fill("ftp://not-https.example.com");
  expectFailure(400, "PUT", "/api/relay/serving");
  await page.getByTestId("relay-serving-save-button").click();
  const message = await page.getByTestId("relay-serving-status").filter({ hasText: /HTTPS origin/ }).innerText();
  assert.match(message, /must be an HTTPS origin/, "the refusal names the rule");
  assert.equal(await page.getByTestId("relay-serving-status").getAttribute("data-state"), "error");
});

test("serving turns on with a loopback address and shows its fingerprint", async () => {
  await page.getByTestId("relay-origin-input").fill(relayOrigin);
  await page.getByTestId("relay-environment-input").fill("dev");
  await page.getByTestId("relay-monthly-cap-input").fill("5");
  await page.getByTestId("relay-serving-save-button").click();
  await page.getByTestId("relay-summary-state").filter({ hasText: "Serving" }).waitFor();
  await page.getByTestId("relay-serving-status").filter({ hasText: "Saved." }).waitFor();

  const fingerprint = (await page.getByTestId("relay-serving-fingerprint").innerText()).trim();
  assert.ok(fingerprint.length >= 8 && !/not available/i.test(fingerprint), `the relay's key fingerprint shows: ${fingerprint}`);
  assert.match(await page.getByTestId("relay-counts").innerText(), /\d+ connected · \d+ admitted · \d+ waiting for approval/);
  assert.equal(await page.getByTestId("relay-check-button").isDisabled(), false, "the check is available once serving is on");

  const saved = await api<{ settings: { enabled: boolean; origin: string; environment: string; monthlyCapGb: number } }>(node, session, "GET", "/relay/serving");
  assert.equal(saved.body.settings.enabled, true, "the server turned serving on");
  assert.equal(saved.body.settings.origin, relayOrigin);
  assert.equal(saved.body.settings.environment, "dev");
  assert.equal(saved.body.settings.monthlyCapGb, 5);
  await shot("serving");
});

test("the own-machines-only switch round-trips through the serving form", async () => {
  const toggle = page.getByTestId("relay-own-machines-only-toggle");
  assert.equal(await toggle.isChecked(), false, "any machine may use the relay by default");
  assert.match(await page.getByTestId("relay-serving-section").innerText(), /Your own machines are this machine's twins\. Other machines are disconnected and refused\./);
  await toggle.check();
  await page.getByTestId("relay-serving-save-button").click();
  await page.getByTestId("relay-serving-status").filter({ hasText: "Saved." }).waitFor();
  const saved = await api<{ settings: { ownMachinesOnly: boolean } }>(node, session, "GET", "/relay/serving");
  assert.equal(saved.body.settings.ownMachinesOnly, true, "the server stored the switch");
  await page.getByTestId("relay-refresh-button").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="relay-own-machines-only-toggle"]') as HTMLInputElement).checked);
  await toggle.uncheck();
  await page.getByTestId("relay-serving-save-button").click();
  await page.getByTestId("relay-serving-status").filter({ hasText: "Saved." }).waitFor();
  const cleared = await api<{ settings: { ownMachinesOnly: boolean } }>(node, session, "GET", "/relay/serving");
  assert.equal(cleared.body.settings.ownMachinesOnly, false, "turning it off is saved too");
});

test("the DNS and TLS check reports each name", async () => {
  await page.getByTestId("relay-check-button").click();
  await page.getByTestId("relay-check-row").nth(1).waitFor({ timeout: 30_000 });
  const rows = await page.getByTestId("relay-check-row").evaluateAll((items) => items.map((item) => ({ text: (item as HTMLElement).innerText, ok: (item as HTMLElement).dataset.ok })));
  assert.equal(rows.length, 2, "one row for the address and one for the machine names");
  assert.match(rows[0].text, /Relay address/);
  assert.match(rows[1].text, new RegExp(`Machine names \\(\\*\\.localhost:${node.port}\\)`));
  assert.equal(rows[0].ok, "true", `the relay's own address answers: ${rows[0].text}`);
  for (const row of rows) assert.ok(row.ok === "true" || /\w{3,}/.test(row.text), "a failing name carries its reason");
});

test("the node's own machine is listed, and cannot be suspended or removed", async () => {
  await openRelaySection("machines");
  const own = page.locator('[data-testid="relay-machine-row"][data-self="true"]');
  await own.waitFor();
  assert.equal(await own.count(), 1, "exactly one row is this machine");
  assert.match(await own.innerText(), /This machine/);
  assert.equal(await own.getByTestId("relay-machine-status").innerText(), "Admitted");
  assert.equal(await own.getByTestId("relay-machine-rename").isVisible(), true, "it can be renamed");
  for (const action of ["suspend", "resume", "remove", "approve", "decline"]) {
    assert.equal(await own.getByTestId(`relay-machine-${action}`).count(), 0, `${action} is not offered for the relay's own machine`);
  }
  assert.match(await own.getByTestId("relay-machine-address").innerText(), new RegExp(`^http://[a-z0-9-]+\\.localhost:${node.port}$`), "its phone address is name.host");
  assert.equal(await page.getByTestId("relay-machines-filter-pending").getAttribute("aria-pressed"), "false");
  await shot("machines");
});

test("filtering by status narrows the machine list", async () => {
  await page.getByTestId("relay-machines-filter-pending").click();
  await page.getByText("No machines here yet.").waitFor();
  assert.equal(await page.getByTestId("relay-machine-row").count(), 0, "no machine is waiting");
  await page.getByTestId("relay-machines-filter-admitted").click();
  await page.getByTestId("relay-machine-row").first().waitFor();
  assert.equal(await page.getByTestId("relay-machine-row").count(), 1, "the relay's own machine is admitted");
  await page.getByTestId("relay-machines-filter-all").click();
  await page.getByTestId("relay-machine-row").first().waitFor();
});

test("renaming a machine happens in place", async () => {
  const own = page.locator('[data-testid="relay-machine-row"][data-self="true"]');
  await own.getByTestId("relay-machine-rename").click();
  const input = own.getByTestId("relay-machine-rename-input");
  await input.fill(RENAMED);
  await input.press("Enter");
  await own.getByTestId("relay-machine-name").filter({ hasText: RENAMED }).waitFor();
  assert.equal(await own.getByTestId("relay-machine-address").innerText(), `http://${RENAMED}.localhost:${node.port}`, "the phone address follows the new name");
  const listed = await api<{ machines: Array<{ self: boolean; name: string }> }>(node, session, "GET", "/relay/serving/machines?status=all&page=1&pageSize=10");
  assert.equal(listed.body.machines.find((machine) => machine.self)?.name, RENAMED, "the server stored the new name");
});

test("a token link is shown once, copied on request, and kept out of storage", async () => {
  await openRelaySection("tokens");
  await page.getByTestId("relay-token-label-input").fill("Office Mac");
  await page.getByTestId("relay-token-name-input").fill("office-mac");
  await page.getByTestId("relay-token-create-button").click();
  await page.getByTestId("relay-token-reveal").waitFor({ state: "visible" });
  await shot("token-link");

  const link = await page.getByTestId("relay-token-link-input").inputValue();
  assert.match(link, new RegExp(`^${relayOrigin.replaceAll(".", "\\.")}/enroll#[^.]+\\.[A-Za-z0-9_-]{43}$`), `the link points at the relay's /enroll page: ${link}`);
  tokenSecret = link.slice(link.lastIndexOf(".") + 1);
  assert.match(await page.getByTestId("relay-token-reveal").innerText(), /Shown once\. Send it to the machine's owner; it adds one machine\./);

  await page.getByTestId("relay-token-copy-button").click();
  await page.waitForFunction(async (expected) => (await navigator.clipboard.readText()) === expected, link);

  const row = page.locator('[data-testid="relay-token-row"]', { hasText: "Office Mac" });
  await row.waitFor();
  assert.equal(await row.getByTestId("relay-token-state").innerText(), "Active");
  assert.match(await row.innerText(), /suggested name office-mac/);
  assert.equal(await page.getByTestId("relay-token-label-input").inputValue(), "", "the form is ready for the next token");

  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.equal(stored.includes(tokenSecret), false, "the secret is not in localStorage or sessionStorage");
  const listed = await api<{ tokens: Array<Record<string, unknown>> }>(node, session, "GET", "/relay/serving/tokens");
  assert.equal(JSON.stringify(listed.body).includes(tokenSecret), false, "the server lists tokens without their secret");

  await page.getByTestId("relay-token-dismiss-button").click();
  await page.getByTestId("relay-token-reveal").waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("relay-token-link-input").inputValue(), "", "dismissing clears the link");
});

test("closing Settings forgets a link that was not dismissed", async () => {
  await page.getByTestId("relay-token-label-input").fill("Left open");
  await page.getByTestId("relay-token-create-button").click();
  await page.getByTestId("relay-token-reveal").waitFor({ state: "visible" });
  await closeSettings();
  await openRelaySection("tokens");
  assert.equal(await page.getByTestId("relay-token-reveal").isVisible(), false, "the link is gone after Settings closes");
  assert.equal(await page.getByTestId("relay-token-link-input").inputValue(), "");
});

test("a token form asks for what is missing", async () => {
  await page.getByTestId("relay-token-label-input").fill("");
  await page.getByTestId("relay-token-create-button").click();
  await page.getByTestId("relay-tokens-status").filter({ hasText: /label/i }).waitFor();
  assert.equal(await page.getByTestId("relay-tokens-status").getAttribute("data-state"), "error");
  assert.equal(await page.getByTestId("relay-token-reveal").isVisible(), false, "nothing was created");
});

test("revoking a token takes a second click", async () => {
  const row = page.locator('[data-testid="relay-token-row"]', { hasText: "Office Mac" });
  await row.waitFor();
  await row.getByTestId("relay-token-revoke").click();
  assert.equal(await row.getByTestId("relay-token-revoke").innerText(), "Confirm revoke", "the first click only asks");
  assert.equal(await row.getByTestId("relay-token-state").innerText(), "Active", "nothing is revoked yet");
  await row.getByTestId("relay-token-revoke").click();
  await row.getByTestId("relay-token-state").filter({ hasText: "Revoked" }).waitFor();
  assert.equal(await row.getByTestId("relay-token-revoke").count(), 0, "a revoked token offers no revoke");
});

test("the token list pages to the height it has and never scrolls", async () => {
  for (let index = 0; index < 24; index += 1) {
    const created = await api(node, session, "POST", "/relay/serving/tokens", { label: `Bulk ${String(index).padStart(2, "0")}`, uses: 1, ttlHours: 24 });
    assert.equal(created.status, 201, "the fixture token is created");
  }
  await page.getByTestId("relay-refresh-button").click();
  await page.getByTestId("relay-tokens-page-label").waitFor();

  const measure = () => page.getByTestId("relay-tokens-list").evaluate((list) => {
    const box = list.getBoundingClientRect();
    const rows = [...list.querySelectorAll('[data-testid="relay-token-row"]')].map((row) => row.getBoundingClientRect());
    return { rows: rows.length, scrollable: list.scrollHeight > list.clientHeight + 1, overflowing: rows.some((row) => row.bottom > box.bottom + 1), listHeight: box.height };
  });
  const first = await measure();
  const label = await page.getByTestId("relay-tokens-page-label").innerText();
  const [, shown, total] = /^1–(\d+) of (\d+)$/.exec(label) ?? [];
  assert.ok(shown && total, `the pager names the rows on screen: ${label}`);
  assert.equal(Number(total), 26, "two earlier tokens and twenty-four fixtures are listed");
  assert.equal(first.rows, Number(shown), "the page holds exactly the rows the label names");
  assert.ok(first.rows >= 1 && first.rows < 26, `the page is smaller than the list (${first.rows} rows in ${first.listHeight}px)`);
  assert.equal(first.scrollable, false, "the list does not scroll");
  assert.equal(first.overflowing, false, "no row is cut off by the list's edge");
  await shot("tokens-paged");

  const firstLabel = await page.getByTestId("relay-token-label").first().innerText();
  await page.getByTestId("relay-tokens-page-next").click();
  await page.getByTestId("relay-tokens-page-label").filter({ hasText: new RegExp(`^${Number(shown) + 1}–`) }).waitFor();
  assert.notEqual(await page.getByTestId("relay-token-label").first().innerText(), firstLabel, "the next page shows other tokens");
  assert.equal((await measure()).scrollable, false, "the second page does not scroll either");
  assert.equal(await page.getByTestId("relay-tokens-page-previous").isDisabled(), false);
  await page.getByTestId("relay-tokens-page-previous").click();
  await page.getByTestId("relay-tokens-page-label").filter({ hasText: /^1–/ }).waitFor();
});

test("the audit log lists what the operator did", async () => {
  await openRelaySection("audit");
  await page.getByTestId("relay-audit-row").first().waitFor();
  const actions = await page.getByTestId("relay-audit-row").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.action));
  assert.ok(actions.includes("token-created") || actions.includes("renamed"), `recent operator actions are listed: ${actions.join(", ")}`);
  const scrollable = await page.getByTestId("relay-audit-list").evaluate((list) => list.scrollHeight > list.clientHeight + 1);
  assert.equal(scrollable, false, "the audit list does not scroll");
});

test("Relay → Joined relays shows this machine's relay with its phone access", async () => {
  await openSettingsTab("cluster");
  assert.equal(await page.locator('#settingsPanel-cluster [data-testid="relays-add-reveal"], #settingsPanel-cluster [data-testid="relays-list"]').count(), 0, "joining relays moved out of the Cluster tab");
  await openSettingsTab("relay");
  await page.getByTestId("relay-tab-joined").click();
  await page.getByTestId("relay-local-card").waitFor();
  assert.equal(await page.getByTestId("relay-summary").isVisible(), false);
  assert.equal(await page.getByTestId("relay-local-title").innerText(), "This machine's relay");
  const phoneAddress = `http://${RENAMED}.localhost:${node.port}`;
  const card = page.getByTestId("relay-local-card");
  const entry = card.getByTestId("relay-phone-entry");
  assert.equal(await entry.count(), 1, "the relay's phone access lists this machine");
  assert.equal(await entry.getAttribute("data-kind"), "this");
  assert.equal(await entry.getByTestId("relay-phone-entry-label").innerText(), "This machine");
  const link = entry.getByTestId("relay-phone-entry-link");
  assert.equal(await link.innerText(), phoneAddress);
  assert.equal(await link.getAttribute("href"), phoneAddress, "the address is a link");
  assert.equal(await link.getAttribute("target"), "_blank", "it opens in a new tab");
  assert.equal(await link.getAttribute("rel"), "noopener");
  assert.equal(await card.getByTestId("relay-phone-access-hint").innerText(), "Open these on your phone to sign in through this relay.");
  await entry.getByTestId("relay-phone-entry-copy").click();
  await page.waitForFunction(async (expected) => (await navigator.clipboard.readText()) === expected, phoneAddress);
  assert.equal(await page.locator('[data-testid="relay-clusters"], [data-testid="relay-move-up"], [data-testid="relay-move-down"]').count(), 0, "relay choice is automatic: no cluster control or order buttons");
  assert.match(await page.getByTestId("relays-address").innerText(), /^This machine's address for clusters: \S+/);
  assert.equal(await page.getByTestId("relay-phone-signin-toggle").isChecked(), true, "phone sign-in is on by default");
  assert.equal(await page.getByTestId("relay-mfa-hint").innerText(), "Phone sign-in through a relay needs two-factor authentication. Set it up under Account.", "an account without two-factor sign-in is told why");
  await page.getByTestId("relay-local-card").scrollIntoViewIfNeeded();
  await shot("joined-relays");
});

test("a phone address opens as a QR code to scan", async () => {
  const phoneAddress = `http://${RENAMED}.localhost:${node.port}`;
  const card = page.getByTestId("relay-local-card");
  const button = card.getByTestId("relay-phone-entry-qr");
  assert.equal(await card.getByTestId("relay-phone-qr").count(), 0, "QR codes stay closed until asked for");
  assert.equal(await button.getAttribute("aria-expanded"), "false");
  await button.click();
  const figure = card.getByTestId("relay-phone-qr");
  await figure.waitFor();
  assert.equal(await card.getByTestId("relay-phone-entry-qr").getAttribute("aria-expanded"), "true");
  assert.equal(await card.getByTestId("relay-phone-entry-qr").innerText(), "Hide QR code");
  assert.equal(await figure.locator("svg").getAttribute("aria-label"), `QR code for ${phoneAddress}`);
  assert.equal(await figure.innerText(), "Scan it with the phone's camera.");
  let expected = "";
  qrMatrix(phoneAddress).forEach((row, y) => row.forEach((dark, x) => { if (dark) expected += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  assert.equal(await figure.locator("svg path").getAttribute("d"), expected, "the picture is the address's QR code");
  const box = await figure.locator("svg").boundingBox();
  assert.ok(box && box.width >= 160 && box.width === box.height, "the code is large enough to scan and square");
  await figure.scrollIntoViewIfNeeded();
  await shot("joined-relays-qr");
  await card.getByTestId("relay-phone-entry-qr").click();
  await figure.waitFor({ state: "detached" });
  assert.equal(await card.getByTestId("relay-phone-entry-qr").innerText(), "QR code");
});

test("the phone sign-in switch saves at once", async () => {
  const toggle = page.getByTestId("relay-local-card").getByTestId("relay-phone-signin-toggle");
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/relays/local") && response.request().method() === "PATCH");
  await toggle.uncheck();
  assert.equal((await saved).status(), 200);
  await page.getByTestId("relays-status").filter({ hasText: "Phone sign-in is off." }).waitFor();
  const view = await api<{ local: { phoneSignIn: boolean } }>(node, session, "GET", "/relays");
  assert.equal(view.body.local.phoneSignIn, false, "the server turned phone sign-in off");
  assert.equal(await page.getByTestId("relay-local-card").getByTestId("relay-phone-signin-toggle").isChecked(), false);
  assert.equal(await page.getByTestId("relay-local-card").getByTestId("relay-phone-entry").count(), 0, "no phone address is offered while phone sign-in is off");
  await page.getByTestId("relay-local-card").getByTestId("relay-phone-signin-toggle").check();
  await page.getByTestId("relays-status").filter({ hasText: "Phone sign-in is on." }).waitFor();
  await page.getByTestId("relay-local-card").getByTestId("relay-phone-entry").waitFor();
});

test("the other-users phone switch sits in Joined relays and round-trips", async () => {
  const before = await api<{ otherUsersPhoneSignIn: boolean }>(node, session, "GET", "/relays");
  const toggle = page.getByTestId("relays-other-users-toggle");
  assert.equal(await toggle.isChecked(), before.body.otherUsersPhoneSignIn, "the switch shows the saved rule");
  assert.match(await page.getByTestId("relay-joined-section").innerText(), /Let other users sign in to this machine from a phone/);
  assert.match(await page.getByTestId("relay-joined-section").innerText(), /Other users are accounts whose home is another machine in your clusters\. Turning this off also ends their open phone sessions\./);
  const flipped = !before.body.otherUsersPhoneSignIn;
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/relays/settings") && response.request().method() === "PUT");
  await toggle.setChecked(flipped);
  assert.equal((await saved).status(), 200);
  await page.getByTestId("relays-status").filter({ hasText: /Other users can/ }).waitFor();
  const after = await api<{ otherUsersPhoneSignIn: boolean }>(node, session, "GET", "/relays");
  assert.equal(after.body.otherUsersPhoneSignIn, flipped, "the server stored the rule");
  assert.equal(await page.getByTestId("relays-other-users-toggle").isChecked(), flipped);
  const restored = page.waitForResponse((response) => response.url().endsWith("/api/relays/settings") && response.request().method() === "PUT");
  await page.getByTestId("relays-other-users-toggle").setChecked(before.body.otherUsersPhoneSignIn);
  assert.equal((await restored).status(), 200);
});

test("adding a relay offers a link or a request, and refusals stay inline", async () => {
  await page.getByTestId("relays-add-reveal").click();
  await page.getByTestId("relays-add-form").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("relays-add-reveal").getAttribute("aria-expanded"), "true");
  assert.equal(await page.getByTestId("relays-request-button").isVisible(), true, "a request-access choice sits beside the link");

  await page.getByTestId("relays-link-input").fill("https://nowhere.invalid/not-a-relay-link");
  const refused = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/relays" && response.request().method() === "POST");
  await page.getByTestId("relays-link-button").click();
  const response = await refused;
  expectFailure(response.status(), "POST", "/api/relays");
  assert.ok(response.status() >= 400 && response.status() < 500, `the server refuses the link with a client error, got ${response.status()}`);
  const body = await response.json() as { error: string };
  assert.equal((await page.getByTestId("relays-status").innerText()).trim(), body.error, "the server's message shows as it is");
  assert.equal(await page.getByTestId("relays-add-form").isVisible(), true, "the form stays open so the link can be fixed");
  await page.getByTestId("relays-add-cancel").click();
  await page.getByTestId("relays-add-form").waitFor({ state: "hidden" });
});

test("the sign-in form shows the relay's sign-in refusal as it is", async () => {
  const guest = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  try {
    const visitor = await guest.newPage();
    await visitor.route("**/api/auth/login", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: TWO_FACTOR_MESSAGE }) }));
    await visitor.goto(node.url, { waitUntil: "domcontentloaded" });
    await visitor.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
    await visitor.getByTestId("login-username-input").fill(environment.username);
    await visitor.getByTestId("login-password-input").fill(environment.password);
    await visitor.getByTestId("login-submit-button").click();
    await visitor.locator("#loginError:not([hidden])").waitFor();
    assert.equal((await visitor.locator("#loginError").innerText()).trim(), TWO_FACTOR_MESSAGE);
  } finally {
    await guest.close();
  }
});

test("a replicated user does not see the Relay tab", async () => {
  await closeSettings();
  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    const { syncSettingsAccess } = await import("/app/settings.js");
    state.isRemoteLogin = true;
    syncSettingsAccess();
  });
  try {
    await page.getByTestId("settings-open-button").click();
    assert.equal(await page.getByTestId("settings-tab-relay").isVisible(), false, "the tab is hidden");
    assert.equal(await page.locator('.settings-tabs-select option[value="relay"]').evaluate((option) => (option as HTMLOptionElement).disabled), true, "the narrow-screen menu cannot pick it either");
    assert.equal(await page.getByTestId("settings-tab-cluster").isVisible(), true, "other tabs stay");
  } finally {
    await page.evaluate(async () => {
      const { state } = await import("/app/state.js");
      const { syncSettingsAccess } = await import("/app/settings.js");
      state.isRemoteLogin = false;
      syncSettingsAccess();
    });
    await closeSettings();
  }
  await page.getByTestId("settings-open-button").click();
  assert.equal(await page.getByTestId("settings-tab-relay").isVisible(), true, "the tab returns for an administrator");
  await closeSettings();
});

test("the journey produced no console errors and only the failures it asked for", () => {
  const unexpected = failedResponses.filter((item) => !expectedFailures.includes(item));
  assert.deepEqual(unexpected, [], "no unexpected 4xx or 5xx responses");
  const surprising = consoleErrors.filter((message) => !/Failed to load resource: the server responded with a status of 4\d\d/.test(message));
  assert.deepEqual(surprising, [], "no console errors apart from the refusals the test provoked");
  assert.equal(consoleErrors.length - surprising.length, expectedFailures.length, "every provoked refusal was seen exactly once");
});
