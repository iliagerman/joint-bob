// Records the promo video's source clips from the real app.
//
// Builds a fresh throwaway environment, starts its three nodes, drives real pages with real
// clicks and typing, and writes clips plus their event times to promo-video/public/captures.
// The agent output comes from capture/scenarios.mjs; every screen is the app itself.
//
//   node --import tsx promo-video/capture/record.ts --take NAME   (from the repository root)
//
// The teaser's takes (handoff, webhook, costs) are in this file; the use-case films' takes are in takes.ts.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import { api, pairTwins, seed, signIn, startNode, stopNode } from "./env.js";
import { glideClick, openBrowser, openStage, record, tap, type Recording } from "./browser.js";
import { takes } from "./takes.js";
import { chromeExecutable } from "../../test/ui/launch-chrome.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, "../public/captures");
const takeIndex = process.argv.indexOf("--take");
const only = takeIndex === -1 ? undefined : process.argv[takeIndex + 1];
// Each take wants a fresh environment: a take leaves panels collapsed and conversations behind
// for the same account. `npm run capture` runs the takes one after the other.
const known = ["handoff", "webhook", "costs", ...Object.keys(takes)];
if (!only || !known.includes(only)) throw new Error(`Pass --take with one of: ${known.join(", ")}`);

const desktop = { width: 1280, height: 800 };
const phone = { width: 402, height: 874 };
const prompt = "Payment retries double-charge customers when the provider times out. Find the cause and fix it.";
const followUp = "Ship the fix and open a PR.";
const teammateAsk = "Nice! Can we add a metric for retried payments?";
const forkAsk = "What if we cap retries at three?";
const webhookContext = "A production error alert. Find the cause, fix it and open a pull request.";
// What a monitoring service would send when the error rate jumps.
const alert = { alert: "Error rate spike", service: "checkout-api", environment: "production", errors_last_5m: 214, message: "TypeError: Cannot read properties of undefined (reading 'currency')", where: "formatPrice (src/cart/format.ts:41)", first_seen: "03:00:14" };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const now = (): number => Date.now() / 1000;

interface ClipMeta { file: string; width: number; height: number; seconds: number; events: Record<string, number> }
const metaFile = path.join(output, "meta.json");
const meta: Record<string, ClipMeta> = await readFile(metaFile, "utf8").then(JSON.parse, () => ({}));

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-3000); });
    child.on("close", (status) => status === 0 ? resolve() : reject(new Error(`${command} exited ${status}: ${stderr}`)));
  });
}

/**
 * Stops a recording, encodes it at a constant 30 frames a second and files its event times,
 * measured from the first frame. Chrome now and then hands over one frame at another size;
 * every frame is brought to the page's own size so that frame cannot set the clip's.
 */
async function finish(name: string, recording: Recording, events: Record<string, number>): Promise<void> {
  const result = await recording.stop();
  const file = `${name}.mp4`;
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", result.file, "-vf", `scale=${result.width}:${result.height}:flags=lanczos,fps=30,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-movflags", "+faststart", path.join(output, file)]);
  meta[name] = { file, width: result.width, height: result.height, seconds: Number(result.seconds.toFixed(2)), events: Object.fromEntries(Object.entries(events).map(([event, time]) => [event, Number((time - result.firstFrameAt).toFixed(3))])) };
  await writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`${name}: ${result.frames} frames, ${result.seconds.toFixed(1)} s`, meta[name].events);
}

async function openProject(page: Page, name: string): Promise<void> {
  await page.waitForFunction((wanted) => [...document.querySelectorAll("#projectList .list-row")].some((row) => row.textContent!.includes(wanted)), name);
  await page.locator("#projectList .list-row", { hasText: name }).locator(".project-card").click();
  await page.locator("#sessionList .list-row").first().waitFor();
}

/** On a phone the project list re-renders once the first sync status arrives, and a tap during that is lost. */
async function openProjectOnPhone(page: Page, name: string): Promise<void> {
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length >= 1);
  for (let attempt = 0; attempt < 4 && !(await page.locator("#sessionList .list-row").first().isVisible()); attempt++) {
    await sleep(900);
    await tap(page, `#projectList .list-row:has-text("${name}") .project-card`).catch(() => {});
    await page.locator("#sessionList .list-row").first().waitFor({ timeout: 4_000 }).catch(() => {});
  }
  await page.locator("#sessionList .list-row").first().waitFor();
}

await mkdir(output, { recursive: true });
const root = await mkdtemp("/tmp/jb-promo-");
const environment = await seed(root, only === "cluster" ? ["--with", "retry"] : []);
const [laptopNode, serverNode, teammateNode] = environment.nodes;
// The app's own browser, which one film shows, runs the same Chrome the capture does.
const browserExecutable = await chromeExecutable();
const nodeLog: string[] = [];
const nodes = await Promise.all(environment.nodes.map((node) => startNode(node, (line) => { nodeLog.push(line); if (nodeLog.length > 400) nodeLog.shift(); }, { JOINT_BOB_BROWSER_EXECUTABLE: browserExecutable })));
let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
try {
  // Without Syncthing a twin shows as "Twin · error" on the cluster map, the one place the
  // team take looks at; that take is about the laptop and the teammate, so it runs unpaired.
  if (only !== "cluster") await pairTwins(environment);
  browser = await openBrowser(environment);

  if (takes[only]) await takes[only]({ environment, browser, root, finish, openProject, openProjectOnPhone });

  if (only === "handoff") {
    // A team: the owner's two machines and a teammate's, in one cluster, sharing one project.
    const [owner, server, teammate] = await Promise.all(environment.nodes.map((node) => signIn(environment, node)));
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(laptopNode, owner, "POST", "/clusters", { name: "Northwind team" });
    const clusterId = created.body.snapshot.body.clusterId;
    for (const [node, session] of [[serverNode, server], [teammateNode, teammate]] as const) {
      const invitation = await api<{ link: string }>(laptopNode, owner, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
      const joined = await api(node, session, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
      if (joined.status !== 201) throw new Error(`${node.name} could not join the cluster: ${JSON.stringify(joined.body)}`);
    }
    const shared = laptopNode.projects.find((project) => project.name === "checkout-api")!;
    const sharing = await api(laptopNode, owner, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [shared.id], workspaceIds: [], confirmOwnedData: true });
    if (sharing.status !== 200) throw new Error(`Sharing failed: ${JSON.stringify(sharing.body)}`);
    // Let the teammate's machine receive the project before anything happens in it: a member
    // only hears about what changes after it has caught up.
    for (let attempt = 0; attempt < 80; attempt++) {
      const listed = await api<{ projects: Array<{ id: string }> }>(teammateNode, teammate, "GET", "/projects?syncStatus=false");
      if (listed.body.projects?.some((project) => project.id === shared.id)) break;
      await sleep(500);
    }
    await sleep(6000);

    // One conversation, four screens: started on the laptop, running on the home server,
    // continued from a phone, then joined and forked by a teammate.
    const laptop = await openStage(browser, environment, laptopNode, desktop);
    const home = await openStage(browser, environment, serverNode, desktop);
    const mobile = await openStage(browser, environment, serverNode, phone, { scale: 3, mobile: true });

    await openProject(laptop.page, "checkout-api");
    await laptop.page.locator("#collapseProjectsButton").click();
    await openProject(home.page, "checkout-api");
    await home.page.locator("#collapseProjectsButton").click();
    await openProjectOnPhone(mobile.page, "checkout-api");

    await laptop.page.getByTestId("session-create-claude-button").click();
    await laptop.page.locator("#newSessionNameInput").fill("Payment retry double-charge");
    await laptop.page.getByTestId("new-session-next-button").click();
    await laptop.page.getByTestId("new-session-next-button").click();
    await laptop.page.locator("#newSessionNodeSelect").selectOption({ label: "Home server" });
    await laptop.page.getByTestId("new-session-name-start-button").click();
    await laptop.page.locator("#messageInput:not([disabled])").waitFor();
    await sleep(800);

    const events: Record<string, number> = {};
    const recordings = await Promise.all([record(laptop.page, root, "laptop"), record(home.page, root, "server"), record(mobile.page, root, "phone")]);
    await sleep(500);
    await glideClick(laptop.page, "#messageInput", { ms: 350 });
    await laptop.page.locator("#messageInput").pressSequentially(prompt, { delay: 16 });
    await sleep(250);
    await glideClick(laptop.page, "#sendButton", { ms: 300 });
    events.send = now();

    const row = '#sessionList .list-row:has-text("Payment retry double-charge")';
    await Promise.all([
      (async () => {
        await home.page.locator(row).waitFor();
        await sleep(Math.max(0, (events.send + 1.4 - now()) * 1000));
        await glideClick(home.page, `${row} .session-card`, { ms: 380 });
        events.serverOpen = now();
      })(),
      (async () => {
        await mobile.page.locator(row).waitFor();
        await sleep(Math.max(0, (events.send + 7.6 - now()) * 1000));
        await tap(mobile.page, `${row} .session-card`);
        events.phoneOpen = now();
        // The first turn ends with its plan; then the same conversation takes the next request.
        await mobile.page.locator("#messages .message.assistant", { hasText: "open a pull request" }).waitFor();
        events.firstTurnDone = now();
        await sleep(900);
        await tap(mobile.page, "#messageInput");
        await mobile.page.locator("#messageInput").pressSequentially(followUp, { delay: 30 });
        await sleep(250);
        await tap(mobile.page, "#sendButton");
        events.phoneSend = now();
        // Sending leaves the view on the sent message; the app's own button follows the reply.
        await mobile.page.locator("#jumpToBottomButton").waitFor({ timeout: 2_500 }).then(() => sleep(350)).then(() => tap(mobile.page, "#jumpToBottomButton")).catch(() => {});
        events.phoneFollow = now();
        await mobile.page.locator("#messages .message.assistant", { hasText: "48 of 48 tests pass" }).waitFor({ timeout: 40_000 });
        events.shipped = now();
        await sleep(1800);
      })(),
    ]);
    await finish("laptop", recordings[0], events);
    await finish("phone", recordings[2], events);

    // The teammate, on her own machine: the project reached her through the cluster. She opens
    // the same conversation, asks for one more thing, then forks it to try an idea of her own.
    // What each machine calls the conversation at this point.
    for (const [node, session] of [[laptopNode, owner], [serverNode, server], [teammateNode, teammate]] as const) {
      const listed = await api<{ sessions?: Array<{ title: string; id: string; executionNodeId?: string }> }>(node, session, "GET", `/projects/${shared.id}/sessions`);
      console.log(`${node.name} lists: ${(listed.body.sessions ?? []).slice(0, 3).map((item) => `${item.title} (${item.id.slice(0, 8)})`).join(" | ")}`);
    }
    const maya = await openStage(browser, environment, teammateNode, desktop);
    await openProject(maya.page, "checkout-api");
    // The conversation's name reaches the other member a little after its record does.
    const asked = now();
    for (let attempt = 0; attempt < 3 && !(await maya.page.locator(row).first().isVisible()); attempt++) {
      await maya.page.locator(row).first().waitFor({ timeout: 10_000 }).catch(() => maya.page.reload().then(() => openProject(maya.page, "checkout-api")));
    }
    console.log(`teammate saw the conversation after ${(now() - asked).toFixed(1)} s`);
    await maya.page.locator(`${row} .session-card`).click();
    await maya.page.locator("#messages .message.assistant", { hasText: "48 of 48 tests pass" }).waitFor();
    await maya.page.locator("#collapseChatsButton").click();
    await home.page.locator("#jumpToBottomButton").click({ timeout: 1_500 }).catch(() => {});
    await sleep(1000);
    const teammateRecording = await record(maya.page, root, "teammate");
    await sleep(700);
    await glideClick(maya.page, "#messageInput", { ms: 380 });
    await maya.page.locator("#messageInput").pressSequentially(teammateAsk, { delay: 22 });
    await sleep(250);
    await glideClick(maya.page, "#sendButton", { ms: 300 });
    events.teammateSend = now();
    await maya.page.locator("#messages .message.assistant", { hasText: "Pushed to the same branch" }).waitFor({ timeout: 40_000 });
    events.teammateAnswered = now();
    await sleep(1300);
    await glideClick(maya.page, "#chatSessionMenuButton", { ms: 420 });
    await sleep(450);
    await glideClick(maya.page, '[data-testid="session-fork-button"]', { ms: 320 });
    events.forkClick = now();
    await maya.page.locator("#sessionTitle").filter({ hasText: "[F]" }).waitFor();
    await maya.page.locator("#messageInput:not([disabled])").waitFor();
    events.forked = now();
    await sleep(900);
    await glideClick(maya.page, "#messageInput", { ms: 320 });
    await maya.page.locator("#messageInput").pressSequentially(forkAsk, { delay: 24 });
    await sleep(250);
    await glideClick(maya.page, "#sendButton", { ms: 300 });
    events.forkSend = now();
    await maya.page.locator("#messages .message.assistant", { hasText: "Capped at three attempts" }).waitFor({ timeout: 40_000 });
    events.forkAnswered = now();
    await sleep(1800);
    await finish("teammate", teammateRecording, events);
    await finish("server", recordings[1], events);
    await Promise.all([laptop.context.close(), home.context.close(), mobile.context.close(), maya.context.close()]);
  }

  if (only === "webhook") {
    // An alert becomes work with nobody at a keyboard: a webhook on the home server, made in
    // Settings, then called the way a monitoring service would call it.
    const { page, context } = await openStage(browser, environment, serverNode, desktop);
    await openProject(page, "checkout-api");
    await sleep(600);

    const events: Record<string, number> = {};
    const recording = await record(page, root, "webhook");
    await sleep(400);
    await glideClick(page, '[data-testid="settings-open-button"]', { ms: 420 });
    await page.locator("#settingsDialog[open]").waitFor();
    await sleep(350);
    await glideClick(page, "#settingsTab-webhooks", { ms: 360 });
    events.tab = now();
    await sleep(450);
    await glideClick(page, '[data-testid="webhooks-new-button"]', { ms: 360 });
    await page.getByTestId("webhooks-form").waitFor();
    events.form = now();
    await glideClick(page, '[data-testid="webhooks-name-input"]', { ms: 300 });
    await page.getByTestId("webhooks-name-input").pressSequentially("Production errors", { delay: 26 });
    await page.locator("#webhooksProject").selectOption({ label: "checkout-api" });
    await glideClick(page, '[data-testid="webhooks-context-input"]', { ms: 300 });
    await page.getByTestId("webhooks-context-input").pressSequentially(webhookContext, { delay: 13 });
    events.typed = now();
    await sleep(700);
    // The address is shown once; the capture needs it to make the call the alert would make.
    const answered = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/webhooks" && response.request().method() === "POST");
    await glideClick(page, '[data-testid="webhooks-save-button"]', { ms: 380 });
    const { secret, webhook } = await (await answered).json() as { secret: string; webhook: { id: string; name: string; context: string; target: { projectId: string } } };
    events.created = now();
    // The form has no agent picker for a project webhook: the node's first agent takes the call.
    // Here only the stand-in for Claude can run, so the webhook is pointed at it through the API.
    const admin = await signIn(environment, serverNode);
    const pointed = await api(serverNode, admin, "PUT", `/webhooks/${webhook.id}`, { name: webhook.name, target: { kind: "project", projectId: webhook.target.projectId, engine: "claude" }, context: webhook.context, enabled: true });
    if (pointed.status !== 200) throw new Error(`Could not set the webhook's agent: ${JSON.stringify(pointed.body)}`);
    await page.getByTestId("webhooks-reveal").waitFor();
    await sleep(1400);
    await glideClick(page, '[data-testid="webhooks-reveal-done-button"]', { ms: 360 });
    await sleep(400);
    await glideClick(page, '#settingsDialog button:text-is("Close")', { ms: 380 });
    await page.locator("#settingsDialog[open]").waitFor({ state: "detached" }).catch(() => {});
    events.closed = now();
    await sleep(1200);

    const call = (): Promise<Response> => fetch(`${serverNode.url}/hooks/${secret}`, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "northwind-monitoring/1.0" }, body: JSON.stringify(alert, null, 2) });
    const first = await call();
    if (!first.ok) throw new Error(`The webhook refused the call: ${first.status} ${await first.text()}`);
    events.alert = now();
    const row = '#sessionList .list-row:has-text("Production errors")';
    await page.locator(row).first().waitFor();
    events.appeared = now();
    await sleep(900);
    await glideClick(page, `${row} .session-card`, { ms: 380 });
    events.open = now();
    await page.locator("#messages .message.assistant", { hasText: "Opened PR #213" }).waitFor({ timeout: 60_000 });
    events.reported = now();
    await sleep(2200);
    await finish("webhook", recording, events);

    // The morning after: a second alert nobody watched, found in the review inbox on a phone.
    await call();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll("#sessionList .list-row")].filter((candidate) => candidate.textContent!.includes("Production errors"));
      return rows.length >= 2 && rows.every((candidate) => !/running/i.test(candidate.querySelector(".chat-badge b")?.textContent ?? ""));
    }, undefined, { timeout: 60_000 });
    const mobile = await openStage(browser, environment, serverNode, phone, { scale: 3, mobile: true });
    // The phone opens where this account last was, the first alert's conversation. Start from the project list.
    await mobile.page.locator("#navProjectsButton").waitFor();
    await sleep(1500);
    await tap(mobile.page, "#navProjectsButton");
    await mobile.page.waitForFunction(() => /[1-9]/.test(document.querySelector("#navReviewsButton")?.textContent ?? ""), undefined, { timeout: 30_000 });
    await sleep(1200);
    const morningEvents: Record<string, number> = {};
    const morning = await record(mobile.page, root, "morning");
    await sleep(900);
    await tap(mobile.page, "#navReviewsButton");
    morningEvents.inbox = now();
    const option = '[data-testid="pending-review-option"]:has-text("Production errors")';
    await mobile.page.locator(option).first().waitFor();
    await sleep(900);
    await tap(mobile.page, option);
    morningEvents.open = now();
    await mobile.page.locator("#messages .message.assistant", { hasText: "Opened PR #213" }).waitFor();
    morningEvents.report = now();
    await sleep(2200);
    await finish("morning", morning, morningEvents);
    await Promise.all([mobile.context.close(), context.close()]);
  }

  if (only === "costs") {
    // The Costs dashboard over the seeded months of work: where the money went, what changed
    // against last month and why, and which skills fail more than the rest.
    const { page, context } = await openStage(browser, environment, laptopNode, desktop);
    await openProject(page, "checkout-api");
    // The ledger fills in the background after the first listing.
    await page.getByTestId("usage-open").first().click();
    await page.waitForFunction(() => /\$\d/.test(document.querySelector("#usageSummary")?.textContent ?? ""), undefined, { timeout: 90_000 });
    await sleep(4000);
    await page.locator('#usageDialog button:text-is("Close")').first().click();
    await sleep(800);

    const events: Record<string, number> = {};
    const recording = await record(page, root, "costs");
    await sleep(400);
    await glideClick(page, '[data-testid="usage-open"]', { ms: 420 });
    await page.waitForFunction(() => /\$\d/.test(document.querySelector("#usageSummary")?.textContent ?? "") && document.querySelectorAll("#usageBreakdowns tbody tr").length >= 5, undefined, { timeout: 60_000 });
    events.overview = now();
    await sleep(2000);
    await glideClick(page, '[data-testid="usage-tab-compare"]', { ms: 420 });
    await page.waitForFunction(() => /Cost is (up|down)/.test(document.querySelector("#usageChanges")?.textContent ?? ""), undefined, { timeout: 60_000 });
    events.compare = now();
    await sleep(900);
    // Down to "What changed", the way a hand on a trackpad would.
    await page.mouse.move(640, 520);
    for (let step = 0; step < 14; step++) { await page.mouse.wheel(0, 60); await sleep(28); }
    events.changes = now();
    await sleep(2600);
    await glideClick(page, '[data-testid="usage-tab-insights"]', { ms: 420 });
    await page.waitForFunction(() => (document.querySelector("#usageFindings")?.textContent ?? "").trim().length > 20, undefined, { timeout: 60_000 });
    events.insights = now();
    console.log(`findings: ${(await page.locator("#usageFindings").innerText()).replace(/\n+/g, " | ")}`);
    await sleep(2600);
    await finish("costs", recording, events);
    await context.close();
  }
} catch (error) {
  // What each stand-in run was asked, and what every open page looked like.
  for (const home of new Set(environment.nodes.map((node) => node.home))) console.error(await readFile(path.join(home, "promo-agent.log"), "utf8").catch(() => "(no agent runs)"));
  if (process.argv.includes("--node-log")) console.error(nodeLog.filter((line) => /error|fail|refus|warn/i.test(line)).slice(-40).join("\n"));
  let shot = 0;
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) await page.screenshot({ path: path.join(output, "..", "..", "out", `failed-${only}-${shot++}.png`) }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await Promise.all(nodes.map(stopNode));
  if (!process.argv.includes("--keep")) await rm(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
}
