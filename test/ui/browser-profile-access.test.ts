import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Browser } from "playwright-core";
import { chromeExecutable, launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "../dev-nodes.js";
import type { BrowserProfile, BrowserSessionView } from "../../src/browser-types.js";

const browserEnv = process.env.CHROME_PATH ? { JOINT_BOB_BROWSER_EXECUTABLE: process.env.CHROME_PATH } : {};

async function issueAgentToken(node: SeededNode, environment: DevEnvironment, projectId: string, conversationId: string): Promise<Agent> {
  const code = `import { browserAgentEnvironment } from './src/browser-agent.ts';
const env = browserAgentEnvironment(${JSON.stringify(projectId)}, 'pi', ${JSON.stringify(conversationId)});
console.log(JSON.stringify({ token: env.JOINT_BOB_BROWSER_TOKEN }));`;
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(), env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, timeout: 15000,
  });
  const { token } = JSON.parse(result.stdout) as { token: string };
  return { url: `${node.url}/api/browser/agent`, token };
}

type Agent = { url: string; token: string };
async function agentCall(agent: Agent, body: unknown) {
  const response = await fetch(agent.url, {
    method: "POST", headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

test("profile scope grants, cross-node toggle, and human takeover are enforced end to end in a real browser", { timeout: 240000 }, async t => {
  const executablePath = await chromeExecutable();
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-profile-access-"));
  const servers: ChildProcess[] = [];
  let viewerBrowser: Browser | undefined;
  const fixture = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<title>Loopback fixture</title><h1>Synthetic account fixture</h1>");
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    servers.push(await startDevNode(environment, node, browserEnv));
    const auth = await signIn(environment, node);
    const project = node.projects[0];
    const conversationA = randomUUID(), conversationB = randomUUID();
    const agentA = await issueAgentToken(node, environment, project.id, conversationA);
    const agentB = await issueAgentToken(node, environment, project.id, conversationB);

    // A profile the agent creates is granted to exactly its creating conversation.
    const started = await agentCall(agentA, { operation: "start", nodeId: node.nodeId, profileName: "Bank login", url: fixtureOrigin });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const session = (started.body as { session: BrowserSessionView }).session;
    assert.equal(session.state, "running");
    const profilesA = await api<{ profiles: BrowserProfile[] }>(node, auth, "GET", `/browser/profiles?${new URLSearchParams({ projectId: project.id, engine: "pi", conversationId: conversationA })}`);
    assert.equal(profilesA.body.profiles.length, 1);
    assert.deepEqual(profilesA.body.profiles[0].grants!.map(({ scope, conversationId }) => ({ scope, conversationId })), [{ scope: "conversation", conversationId: conversationA }], "new profiles attach to their creating conversation");

    // Another conversation of the same project cannot see or start it.
    assert.equal(((await agentCall(agentB, { operation: "profiles" })).body as { profiles: unknown[] }).profiles.length, 0);
    const refused = await agentCall(agentB, { operation: "start", profileId: session.profileId });
    assert.equal(refused.status, 403);
    assert.match(String((refused.body as { error: string }).error), /not granted to this conversation/i);

    // One active conversation: after the human grants the project, conversation B is
    // still refused while conversation A's session holds the profile.
    await api(node, auth, "PUT", `/browser/profiles/${session.profileId}/access?${new URLSearchParams({ projectId: project.id })}`, { grant: { scope: "project", projectId: project.id } });
    const busy = await agentCall(agentB, { operation: "start", nodeId: node.nodeId, profileId: session.profileId });
    assert.equal(busy.status, 409, JSON.stringify(busy.body));
    assert.match(String((busy.body as { error: string }).error), /active in another conversation/i);
    assert.equal((await agentCall(agentA, { operation: "command", profileId: session.profileId, command: { action: "close" } })).status, 200);
    const reopened = await agentCall(agentB, { operation: "start", nodeId: node.nodeId, profileId: session.profileId });
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    const sessionB = (reopened.body as { session: BrowserSessionView }).session;
    assert.equal(sessionB.profileId, session.profileId);

    // The viewer manages access: grant rows, removal, and the cross-node toggle.
    // The profiles section needs a conversation browser machine preference so the
    // listing has an owner node to load from; a fresh node has none configured.
    await api(node, auth, "PUT", `/browser/preferences?${new URLSearchParams({ projectId: project.id, engine: "pi", conversationId: conversationB })}`, { nodeId: node.nodeId });
    viewerBrowser = await launchChrome({ headless: true });
    const context = await viewerBrowser.newContext({ viewport: { width: 1450, height: 1000 }, serviceWorkers: "block" });
    context.setDefaultTimeout(20000);
    await context.addCookies(auth.cookie.split("; ").map(value => ({ name: value.slice(0, value.indexOf("=")), value: value.slice(value.indexOf("=") + 1), url: node.url })));
    const viewer = await context.newPage();
    const pageErrors: string[] = [];
    viewer.on("pageerror", (error) => pageErrors.push(`pageerror: ${error}`));
    // "Failed to load resource" echoes HTTP statuses the test asserts on its own
    // (e.g. the intended resume-refusal 409); only script errors count as defects.
    viewer.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) pageErrors.push(`console: ${message.text()}`); });
    await viewer.goto(`${node.url}/browser.html?${new URLSearchParams({ projectId: project.id, engine: "pi", conversationId: conversationB, appNodeId: node.nodeId })}`);
    await viewer.getByTestId("browser-profiles-toggle").click();
    const row = viewer.locator("[data-testid='browser-profiles-list'] li").filter({ hasText: "Bank login" });
    await row.getByTestId("browser-profile-scope").filter({ hasText: /Project/ }).waitFor();
    await row.getByTestId("browser-profile-access-toggle").focus();
    await viewer.keyboard.press("Tab");
    assert.equal(await row.getByTestId("browser-delete-profile").evaluate(element => element === document.activeElement), true, "Tab from Access reaches Delete, matching visual action order");
    await row.getByTestId("browser-profile-access-toggle").click();
    await row.getByTestId("browser-profile-cross-node").waitFor();
    assert.equal(await row.getByTestId("browser-profile-cross-node").isChecked(), false, "new profiles are node-only until cross-node access is explicitly allowed");
    await row.getByTestId("browser-profile-cross-node").click();
    await row.getByTestId("browser-profile-access-status").filter({ hasText: /Cross-node access enabled/i }).waitFor();
    const access = await api<{ profile: BrowserProfile }>(node, auth, "PUT", `/browser/profiles/${session.profileId}/access?${new URLSearchParams({ projectId: project.id, conversationId: conversationB })}`, {});
    assert.equal(access.body.profile.crossNodeAccess, true, "the cross-node toggle writes through the UI");

    // The grant picker targets real projects and conversations by name: another
    // project, then another conversation of that other project, each removable.
    const otherProject = node.projects[1];
    const otherSessions = await api<{ sessions: Array<{ id: string; title: string; conversationId?: string }> }>(node, auth, "GET", `/projects/${encodeURIComponent(otherProject.id)}/sessions`);
    const otherConversation = otherSessions.body.sessions.find((candidate) => candidate.title === "Canvas picker readability");
    assert.ok(otherConversation, "the seeded Joint Bob conversations must be listable");
    const otherConversationId = otherConversation.conversationId ?? otherConversation.id;
    await row.getByTestId("browser-profile-grant-scope").selectOption("project");
    await row.getByTestId("browser-profile-grant-project").selectOption(otherProject.id);
    await row.getByTestId("browser-profile-grant-add").click();
    await row.getByTestId("browser-profile-access-status").filter({ hasText: `Access granted: Project · ${otherProject.name}` }).waitFor();
    const otherProjectGrant = row.locator(`[data-testid="browser-profile-grant"][data-scope="project:${otherProject.id}"]`).filter({ hasText: otherProject.name });
    await otherProjectGrant.waitFor();
    await row.locator(`[data-testid="browser-profile-grant-remove"][data-scope="project:${otherProject.id}"]`).click();
    await otherProjectGrant.waitFor({ state: "detached" });
    await row.getByTestId("browser-profile-grant-scope").selectOption("conversation");
    await row.getByTestId("browser-profile-grant-conversation-project").selectOption(otherProject.id);
    await row.getByTestId("browser-profile-grant-conversation").selectOption({ label: "Canvas picker readability" });
    await row.getByTestId("browser-profile-grant-add").click();
    await row.getByTestId("browser-profile-access-status").filter({ hasText: "Access granted: Conversation · Canvas picker readability" }).waitFor();
    const otherConversationGrant = row.locator(`[data-testid="browser-profile-grant"][data-scope="conversation:${otherProject.id}:${otherConversationId}"]`).filter({ hasText: "Canvas picker readability" });
    await otherConversationGrant.waitFor();
    assert.equal(await otherConversationGrant.filter({ hasText: "This conversation" }).count(), 0, "another conversation's grant must not be labelled This conversation");
    await row.locator(`[data-testid="browser-profile-grant-remove"][data-scope="conversation:${otherProject.id}:${otherConversationId}"]`).click();
    await otherConversationGrant.waitFor({ state: "detached" });

    // Revoking the project grant pauses this conversation's agent immediately…
    await row.locator('[data-testid="browser-profile-grant-remove"][data-scope^="project:"]').click();
    await row.getByTestId("browser-profile-scope").filter({ hasText: /Conversation/ }).waitFor();
    // Phone width: the access panel stays inside the viewport and its selectors work.
    await viewer.setViewportSize({ width: 390, height: 844 });
    const overflow = await viewer.evaluate(() => {
      const list = document.querySelector("[data-testid='browser-profiles-list']");
      const panel = document.querySelector("[data-testid='browser-profile-access']");
      return {
        list: list ? list.scrollWidth - list.clientWidth : 0,
        panel: panel ? panel.scrollWidth - panel.clientWidth : 0,
        right: panel ? Math.round(panel.getBoundingClientRect().right - window.innerWidth) : 0,
      };
    });
    assert.ok(overflow.list <= 0 && overflow.panel <= 0 && overflow.right <= 1, `access panel must not overflow at 390px: ${JSON.stringify(overflow)}`);
    await row.getByTestId("browser-profile-grant-scope").selectOption("project");
    await row.getByTestId("browser-profile-grant-project").waitFor();
    await viewer.setViewportSize({ width: 1450, height: 1000 });
    const revoked = await agentCall(agentB, { operation: "command", profileId: session.profileId, command: { action: "evaluate", expression: "1+1" } });
    assert.equal(revoked.status, 403);
    assert.match(String((revoked.body as { error: string }).error), /revoked|not granted/i);
    // …but the human administrator keeps manual control regardless of grants:
    // takeover and page input keep working, while returning control to the revoked
    // conversation's agent is refused so its commands cannot silently fail.
    await viewer.getByTestId("browser-take-control").click();
    await viewer.getByTestId("browser-control-status").filter({ hasText: "Human control" }).waitFor();
    await viewer.getByTestId("browser-url").fill(`${fixtureOrigin}/human`);
    await viewer.getByTestId("browser-go").click();
    await viewer.locator('[data-testid="browser-tabs"] button[title*="/human"]').waitFor();
    await viewer.getByTestId("browser-resume-agent").click();
    await viewer.getByTestId("browser-error").filter({ hasText: /revoked/i }).waitFor();
    await viewer.getByTestId("browser-end").click();
    await viewer.getByTestId("browser-confirm-accept").click();
    await viewer.getByTestId("browser-session-status").filter({ hasText: "No browser selected" }).waitFor();
    await viewer.getByTestId("browser-show-archived").check();
    await viewer.getByTestId("browser-session-select").selectOption(sessionB.id);
    await viewer.getByTestId("browser-session-status").filter({ hasText: /closed/ }).waitFor();
    const restored = await agentCall(agentB, { operation: "start", profileId: session.profileId });
    assert.equal(restored.status, 403, "the revoked conversation cannot restart the profile");

    // The dormant entity survives with its remaining conversation grant and can be reused.
    const profilesAgain = await api<{ profiles: BrowserProfile[] }>(node, auth, "GET", `/browser/profiles?${new URLSearchParams({ projectId: project.id, engine: "pi", conversationId: conversationA })}`);
    assert.deepEqual(profilesAgain.body.profiles.map(profile => profile.id), [session.profileId]);
    const restart = await agentCall(agentA, { operation: "start", nodeId: node.nodeId, profileId: session.profileId, url: fixtureOrigin });
    assert.equal(restart.status, 200, JSON.stringify(restart.body));
    await agentCall(agentA, { operation: "command", profileId: session.profileId, command: { action: "close" } });
    assert.deepEqual(pageErrors, [], "the viewer page must not log errors");
    t.diagnostic("Verified conversation-grant attachment, project widening, one-active-conversation, revoke, human takeover, and entity persistence");
  } finally {
    await viewerBrowser?.close();
    let forced = false;
    await Promise.all(servers.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 10000);
      try { await stopDevNode(child); } finally { clearTimeout(timer); }
    }));
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    assert.equal(forced, false, "the node must exit on SIGTERM without requiring SIGKILL");
  }
});
