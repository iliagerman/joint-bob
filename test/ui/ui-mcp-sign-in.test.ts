import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

// A stand-in Claude CLI: answers the MCP control requests and keeps "docs-search"'s token as
// a file, so the page's sign-in journey runs end to end without a real account or network.
const fakeClaude = (state: string) => `#!${process.execPath}
const fs = require("node:fs");
const state = ${JSON.stringify(state)};
const token = state + "/token";
if (process.argv.includes("--version")) { console.log("2.1.305 (Claude Code)"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const reply = (id, response) => process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response } }) + "\\n");
const fail = (id, error) => process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: id, error } }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    let message; try { message = JSON.parse(line); } catch { continue; }
    const { request_id: id, request } = message;
    if (!request) continue;
    fs.appendFileSync(state + "/requests.log", JSON.stringify({ subtype: request.subtype, serverName: request.serverName, cwd: process.cwd() }) + "\\n");
    if (request.subtype === "initialize") reply(id, {});
    else if (request.subtype === "mcp_status") reply(id, { mcpServers: [{ name: "docs-search", status: fs.existsSync(token) ? "connected" : "needs-auth" }] });
    else if (request.subtype === "mcp_authenticate") reply(id, { authUrl: "https://auth.example/authorize?state=s1", requiresUserAction: true, callbackExpected: true, redirectScheme: "localhost", callbackPort: 4321 });
    else if (request.subtype === "mcp_oauth_callback_url") {
      if (/code=good/.test(request.callbackUrl) && /state=s1/.test(request.callbackUrl)) { fs.writeFileSync(token, "t"); reply(id, {}); }
      else fail(id, "Callback URL not accepted: it belongs to a different sign-in attempt");
    } else if (request.subtype === "mcp_reconnect") reply(id, {});
    else if (request.subtype === "mcp_clear_auth") { fs.rmSync(token, { force: true }); reply(id, {}); }
    else fail(id, request.subtype + " is not supported");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

test("Resources signs a person in to a Claude MCP server from the page, with a pasted redirect, and signs them out", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-sign-in-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const mcpConfig = path.join(environment.home, "JointBob/.agent-resources/mcp/config.json");
    await mkdir(path.dirname(mcpConfig), { recursive: true });
    await writeFile(mcpConfig, JSON.stringify({ mcpServers: { "docs-search": { type: "http", url: "https://docs.example.com/mcp" } } }));
    const state = path.join(root, "claude-state");
    await mkdir(state, { recursive: true });
    const executable = path.join(root, "claude");
    await writeFile(executable, fakeClaude(state));
    await chmod(executable, 0o755);

    server = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    const headers = { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" };
    const current = await (await fetch(`${node.url}/api/settings`, { headers: { Cookie: session.cookie } })).json() as Record<string, Record<string, unknown>>;
    const saved = await fetch(`${node.url}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ ...current, claude: { ...current.claude, executable } }) });
    assert.ok(saved.ok, "the node accepts the fake Claude executable");

    browser = await launchChrome({ headless: process.env.HEADED !== "1" });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    // The sign-in tab never reaches a real provider.
    await context.route("https://auth.example/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Provider sign-in</title>Sign in" }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-resources").click();
    await page.getByTestId("resources-tab-mcp").click();

    const row = page.getByTestId("resources-mcp-row").filter({ hasText: "docs-search" });
    await row.waitFor();
    assert.equal(await row.getByTestId("resources-mcp-auth-status").count(), 0, "nothing is checked until the person asks");
    await page.getByTestId("resources-mcp-auth-check").click();
    await row.getByTestId("resources-mcp-auth-status").getByText("needs sign-in", { exact: true }).waitFor();

    const popup = context.waitForEvent("page");
    await row.getByTestId("resources-mcp-sign-in").click();
    const signInTab = await popup;
    await signInTab.waitForURL("https://auth.example/authorize?state=s1");
    // The person comes back to Joint Bob's tab; a background tab runs no animation frames, which Playwright's checks wait on.
    await page.bringToFront();
    const pending = page.getByTestId("resources-mcp-sign-in-pending");
    await pending.getByText(/Signing in to docs-search/).waitFor();
    assert.equal(await page.getByTestId("resources-mcp-callback-url").getAttribute("placeholder"), "http://localhost:4321/callback?code=…");
    assert.equal(await row.getByTestId("resources-mcp-sign-in").isDisabled(), true, "one sign-in at a time");

    await page.getByTestId("resources-mcp-callback-url").fill("http://localhost:4321/callback?code=wrong&state=other");
    await page.getByTestId("resources-mcp-sign-in-done").click();
    await page.getByText(/different sign-in attempt/).first().waitFor();
    await pending.waitFor();

    await page.getByTestId("resources-mcp-callback-url").fill("http://localhost:4321/callback?code=good&state=s1");
    await page.getByTestId("resources-mcp-sign-in-done").click();
    await pending.waitFor({ state: "detached" });
    await row.getByTestId("resources-mcp-auth-status").getByText("connected", { exact: true }).waitFor();

    await row.getByTestId("resources-mcp-sign-out").click();
    await page.getByTestId("confirm-accept-button").click();
    await row.getByTestId("resources-mcp-auth-status").getByText("needs sign-in", { exact: true }).waitFor();

    const requests = (await readFile(path.join(state, "requests.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { subtype: string; serverName?: string; cwd: string });
    const subtypes = requests.map((entry) => entry.subtype);
    for (const subtype of ["mcp_status", "mcp_authenticate", "mcp_oauth_callback_url", "mcp_clear_auth"]) assert.ok(subtypes.includes(subtype), `${subtype} reached Claude`);
    assert.ok(requests.filter((entry) => entry.subtype === "mcp_authenticate").every((entry) => entry.serverName === "docs-search"));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close().catch(() => undefined);
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
