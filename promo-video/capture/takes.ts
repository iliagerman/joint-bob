// The takes behind the use-case films, one function each. Like the takes in record.ts, each
// drives real pages of throwaway nodes and files clips with their event times.
//
//   move      a long task planned on the laptop, moved to the home server, followed from a phone
//   cluster   a team made in Settings: create, invite, join, share one project
//   schedule  a scheduled task that reviews support calls and opens a pull request
//   browser   an agent using the app's browser on a staging shop, and a person taking control
//   secrets   a credential added once, reaching the owner's other machine and a teammate, used by an agent
import { randomUUID } from "node:crypto";
import type { Browser, Page } from "playwright-core";
import { api, signIn, type PromoEnvironment, type PromoNode, type Session } from "./env.js";
import { glideClick, openStage, record, tap, type Recording } from "./browser.js";
import { shopPort } from "./scenarios.mjs";
import { startShop } from "./shop.js";

export interface Kit {
  environment: PromoEnvironment;
  browser: Browser;
  root: string;
  finish(name: string, recording: Recording, events: Record<string, number>): Promise<void>;
  openProject(page: Page, name: string): Promise<void>;
  openProjectOnPhone(page: Page, name: string): Promise<void>;
}

const desktop = { width: 1280, height: 800 };
const phone = { width: 402, height: 874 };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const now = (): number => Date.now() / 1000;
const answer = (page: Page, text: string) => page.locator("#messages .message.assistant", { hasText: text });
const closeSettings = '#settingsDialog button:text-is("Close")';

/** Starts a Claude conversation through the wizard; `node` picks the machine it runs on. */
async function newConversation(page: Page, name: string, node?: string): Promise<void> {
  await page.getByTestId("session-create-claude-button").click();
  await page.locator("#newSessionNameInput").fill(name);
  await page.getByTestId("new-session-next-button").click();
  await page.getByTestId("new-session-next-button").click();
  if (node) await page.locator("#newSessionNodeSelect").selectOption({ label: node });
  await page.getByTestId("new-session-name-start-button").click();
  await page.locator("#messageInput:not([disabled])").waitFor();
}

/** Types a message the way a person does, and sends it. */
async function ask(page: Page, text: string, delay = 16): Promise<void> {
  await glideClick(page, "#messageInput", { ms: 350 });
  await page.locator("#messageInput").pressSequentially(text, { delay });
  await sleep(250);
  await glideClick(page, "#sendButton", { ms: 300 });
}

/** Types into a field after gliding to it. */
async function type(page: Page, selector: string, text: string, delay = 24): Promise<void> {
  await glideClick(page, selector, { ms: 320 });
  await page.locator(selector).first().pressSequentially(text, { delay });
}

/** One cluster holding the given machines, with one of the laptop's projects shared, made through the API. */
async function formTeam(environment: PromoEnvironment, members: PromoNode[], projectName: string): Promise<{ clusterId: string; owner: Session; projectId: string }> {
  const laptopNode = environment.nodes[0];
  const owner = await signIn(environment, laptopNode);
  const created = await api<{ snapshot: { body: { clusterId: string } } }>(laptopNode, owner, "POST", "/clusters", { name: "Northwind team" });
  const clusterId = created.body.snapshot.body.clusterId;
  for (const node of members) {
    const invitation = await api<{ link: string }>(laptopNode, owner, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    const joined = await api(node, await signIn(environment, node), "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
    if (joined.status !== 201) throw new Error(`${node.name} could not join the cluster: ${JSON.stringify(joined.body)}`);
  }
  const projectId = laptopNode.projects.find((project) => project.name === projectName)!.id;
  const sharing = await api(laptopNode, owner, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [projectId], workspaceIds: [], confirmOwnedData: true });
  if (sharing.status !== 200) throw new Error(`Sharing failed: ${JSON.stringify(sharing.body)}`);
  return { clusterId, owner, projectId };
}

async function move({ environment, browser, root, finish, openProject, openProjectOnPhone }: Kit): Promise<void> {
  const [laptopNode, serverNode] = environment.nodes;
  const laptop = await openStage(browser, environment, laptopNode, desktop);
  const home = await openStage(browser, environment, serverNode, desktop);
  const mobile = await openStage(browser, environment, serverNode, phone, { scale: 3, mobile: true });
  for (const stage of [laptop, home]) {
    await openProject(stage.page, "billing-worker");
    await stage.page.locator("#collapseProjectsButton").click();
  }
  await openProjectOnPhone(mobile.page, "billing-worker");

  // The task starts on the laptop like any other: a conversation there, and a plan.
  await newConversation(laptop.page, "Migrate tests to Vitest");
  await laptop.page.locator("#messageInput").fill("Migrate the test suite from Jest to Vitest. Plan it first.");
  await laptop.page.locator("#sendButton").click();
  await answer(laptop.page, "Say go when").waitFor({ timeout: 40_000 });
  await sleep(2500);

  const events: Record<string, number> = {};
  const recordings = await Promise.all([record(laptop.page, root, "moveLaptop"), record(home.page, root, "moveServer"), record(mobile.page, root, "movePhone")]);
  await sleep(700);
  // "Runs on" is a native menu, which a headless page does not draw; the pointer goes to it and the choice is made.
  await laptop.page.locator(`#chatNodeSelect option[value="${serverNode.nodeId}"]:not([disabled])`).waitFor({ state: "attached" });
  await glideClick(laptop.page, "#chatNodeSelect", { ms: 460, click: false });
  await sleep(350);
  await laptop.page.locator("#chatNodeSelect").selectOption(serverNode.nodeId);
  events.pick = now();
  await laptop.page.getByTestId("conversation-lock-notice").waitFor();
  events.locked = now();
  await sleep(1100);
  await glideClick(laptop.page, '[data-testid="conversation-lock-take-button"]', { ms: 420 });
  events.take = now();
  await laptop.page.locator("#messageInput:not([disabled])").waitFor({ timeout: 30_000 });
  events.taken = now();
  await sleep(1000);
  await ask(laptop.page, "Go ahead. I'm heading out.", 22);
  events.go = now();

  const row = '#sessionList .list-row:has-text("Migrate tests to Vitest")';
  await Promise.all([
    (async () => {
      await home.page.locator(row).waitFor();
      await sleep(Math.max(0, (events.go + 1.5 - now()) * 1000));
      await glideClick(home.page, `${row} .session-card`, { ms: 380 });
      events.serverOpen = now();
    })(),
    (async () => {
      await mobile.page.locator(row).waitFor();
      await sleep(Math.max(0, (events.go + 6.5 - now()) * 1000));
      await tap(mobile.page, `${row} .session-card`);
      events.phoneOpen = now();
      await answer(mobile.page, "Opened PR #231").waitFor({ timeout: 60_000 });
      events.done = now();
      await sleep(1400);
      await tap(mobile.page, "#messageInput");
      await mobile.page.locator("#messageInput").pressSequentially("Merge it once CI is green.", { delay: 30 });
      await sleep(250);
      await tap(mobile.page, "#sendButton");
      events.phoneSend = now();
      // Sending leaves the view on the sent message; the app's own button follows the reply.
      await mobile.page.locator("#jumpToBottomButton").waitFor({ timeout: 2_500 }).then(() => sleep(350)).then(() => tap(mobile.page, "#jumpToBottomButton")).catch(() => {});
      await answer(mobile.page, "is merged").waitFor({ timeout: 40_000 });
      events.merged = now();
      await sleep(1800);
    })(),
  ]);
  await finish("moveLaptop", recordings[0], events);
  await finish("moveServer", recordings[1], events);
  await finish("movePhone", recordings[2], events);
  await Promise.all([laptop.context.close(), home.context.close(), mobile.context.close()]);
}

async function cluster({ environment, browser, root, finish, openProject }: Kit): Promise<void> {
  const [laptopNode, , teammateNode] = environment.nodes;
  const alex = await openStage(browser, environment, laptopNode, desktop);
  const maya = await openStage(browser, environment, teammateNode, desktop);
  await openProject(alex.page, "checkout-api");
  // The teammate starts with nothing: her projects arrive through the team.
  await maya.page.locator("#projectList").waitFor();
  await sleep(1500);
  const shared = laptopNode.projects.find((project) => project.name === "checkout-api")!;

  const events: Record<string, number> = {};
  const recordings = await Promise.all([record(alex.page, root, "clusterOwner"), record(maya.page, root, "clusterMate")]);
  await sleep(500);
  // The owner: Settings, Cluster, a new cluster with a name.
  await glideClick(alex.page, '[data-testid="settings-open-button"]', { ms: 420 });
  await alex.page.locator("#settingsDialog[open]").waitFor();
  await sleep(300);
  await glideClick(alex.page, "#settingsTab-cluster", { ms: 360 });
  events.tab = now();
  await sleep(500);
  await glideClick(alex.page, '[data-testid="cluster-new-button"]', { ms: 360 });
  await type(alex.page, '[data-testid="cluster-create-name-input"]', "Northwind team", 34);
  await sleep(250);
  await glideClick(alex.page, '[data-testid="cluster-create-button"]', { ms: 320 });
  await alex.page.getByTestId("cluster-details").waitFor();
  events.created = now();
  await sleep(900);
  // A one-time link for the teammate.
  await glideClick(alex.page, '[data-testid="cluster-tab-invite"]', { ms: 380 });
  await sleep(350);
  await glideClick(alex.page, '[data-testid="cluster-invite-generate-button"]', { ms: 360 });
  await alex.page.waitForFunction(() => ((document.querySelector("#clusterInviteLink") as HTMLInputElement | null)?.value ?? "").length > 10);
  events.invited = now();
  const link = await alex.page.locator("#clusterInviteLink").inputValue();
  await sleep(1200);

  // The teammate, on her machine: Settings, Cluster, Join, the link.
  await glideClick(maya.page, '[data-testid="settings-open-button"]', { ms: 420 });
  await maya.page.locator("#settingsDialog[open]").waitFor();
  await sleep(300);
  await glideClick(maya.page, "#settingsTab-cluster", { ms: 360 });
  await sleep(450);
  await glideClick(maya.page, '[data-testid="cluster-join-reveal"]', { ms: 360 });
  await glideClick(maya.page, '[data-testid="cluster-join-link-input"]', { ms: 320 });
  // A link is pasted, not typed.
  await maya.page.getByTestId("cluster-join-link-input").fill(link);
  events.pasted = now();
  await sleep(500);
  await glideClick(maya.page, '[data-testid="cluster-join-button"]', { ms: 320 });
  await maya.page.getByTestId("cluster-details").waitFor({ timeout: 30_000 });
  events.joined = now();
  await sleep(1200);

  // The owner chooses what the team gets: one project.
  await glideClick(alex.page, '[data-testid="cluster-tab-sharing"]', { ms: 380 });
  await sleep(400);
  await glideClick(alex.page, `[data-testid="sharing-project-${shared.id}"]`, { ms: 360 });
  events.chosen = now();
  await sleep(450);
  await glideClick(alex.page, '[data-testid="sharing-save"]', { ms: 340 });
  await sleep(450);
  await glideClick(alex.page, '[data-testid="confirm-accept-button"]', { ms: 340 });
  events.shared = now();
  await sleep(900);

  // And it is on her machine: the project, with the team's name on it, and its conversations.
  await glideClick(maya.page, closeSettings, { ms: 380 });
  const projectRow = '#projectList .list-row:has-text("checkout-api")';
  await maya.page.locator(projectRow).waitFor({ timeout: 60_000 });
  events.received = now();
  await sleep(1300);
  await glideClick(maya.page, `${projectRow} .project-card`, { ms: 380 });
  await maya.page.locator("#sessionList .list-row").first().waitFor({ timeout: 30_000 });
  events.listed = now();
  await sleep(1800);
  await finish("clusterOwner", recordings[0], events);
  await finish("clusterMate", recordings[1], events);
  await Promise.all([alex.context.close(), maya.context.close()]);
}

async function schedule({ environment, browser, root, finish, openProject }: Kit): Promise<void> {
  const serverNode = environment.nodes[1];
  const { page, context } = await openStage(browser, environment, serverNode, desktop);
  await openProject(page, "support-line");
  // Scheduled runs stay out of the conversation list unless asked for.
  await page.locator("#showScheduledConversations").check();
  await sleep(800);

  const events: Record<string, number> = {};
  const recording = await record(page, root, "schedule");
  await sleep(400);
  await glideClick(page, '#projectList .list-row:has-text("support-line") [data-testid="project-menu-button"]', { ms: 420 });
  await sleep(350);
  await glideClick(page, '[data-testid="project-cron-button"]', { ms: 320 });
  await page.waitForFunction(() => (document.querySelector("#cronDialog") as HTMLDialogElement).open && ((document.querySelector("#cronForm") as HTMLFormElement).elements.namedItem("ownerNodeId") as HTMLSelectElement).options.length > 0);
  events.dialog = now();
  await sleep(500);
  await glideClick(page, '[data-testid="cron-new"]', { ms: 360 });
  await page.getByTestId("cron-name").waitFor();
  events.form = now();
  await type(page, '[data-testid="cron-name"]', "Call quality review", 26);
  await type(page, '[data-testid="cron-prompt"]', "Review the last hour of support calls. Score each one. If a script or prompt is causing bad calls, fix it and open a pull request.", 11);
  events.typed = now();
  await sleep(600);
  // It runs on this machine, the one that is always on. Only the stand-in for Claude can run here.
  await page.getByTestId("cron-owner").selectOption(serverNode.nodeId);
  await page.getByTestId("cron-engine").selectOption("claude");
  await sleep(500);
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/cron" && response.request().method() === "POST");
  await glideClick(page, '[data-testid="cron-save"]', { ms: 380 });
  const { task } = await (await created).json() as { task: { id: string; ownerNodeId: string; projectId: string } };
  await page.getByTestId("cron-task").waitFor();
  events.saved = now();
  await sleep(2400);
  await glideClick(page, '[data-testid="cron-close"]', { ms: 380 });
  events.closed = now();
  await sleep(1200);

  // The top of the hour, without the wait: the run is started by the command behind "Run now".
  const admin = await signIn(environment, serverNode);
  const taskId = task.id;
  const projectId = task.projectId;
  const run = async (): Promise<void> => {
    const started = await api(serverNode, admin, "POST", "/cron", { nodeId: serverNode.nodeId, command: { action: "run", id: taskId, projectId } });
    if (started.status !== 200) throw new Error(`The scheduled run did not start: ${JSON.stringify(started.body)}`);
  };
  const finished = async (count: number): Promise<void> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const history = await api<{ runs: Array<{ status: string }> }>(serverNode, admin, "POST", "/cron", { nodeId: serverNode.nodeId, command: { action: "history", id: taskId, projectId } });
      if ((history.body.runs ?? []).filter((item) => item.status === "succeeded").length >= count) return;
      if ((history.body.runs ?? []).some((item) => item.status === "failed")) throw new Error(`A scheduled run failed: ${JSON.stringify(history.body.runs)}`);
      await sleep(500);
    }
    throw new Error("The scheduled run never finished");
  };
  await run();
  events.run = now();
  const row = '#sessionList .list-row:has-text("Call quality review")';
  await page.locator(row).first().waitFor({ timeout: 30_000 });
  events.appeared = now();
  await sleep(1000);
  await glideClick(page, `${row} .session-card`, { ms: 380 });
  events.open = now();
  await answer(page, "Fixed both and opened PR #88").waitFor({ timeout: 60_000 });
  events.reported = now();
  await sleep(2600);
  await finish("schedule", recording, events);

  // An hour later it has run again, and that report is waiting in the review inbox on a phone.
  await finished(1);
  await run();
  await finished(2);
  const mobile = await openStage(browser, environment, serverNode, phone, { scale: 3, mobile: true });
  await mobile.page.locator("#navProjectsButton").waitFor();
  await sleep(1500);
  await tap(mobile.page, "#navProjectsButton");
  await mobile.page.waitForFunction(() => /[1-9]/.test(document.querySelector("#navReviewsButton")?.textContent ?? ""), undefined, { timeout: 30_000 });
  await sleep(1200);
  const inboxEvents: Record<string, number> = {};
  const inbox = await record(mobile.page, root, "scheduleInbox");
  await sleep(900);
  await tap(mobile.page, "#navReviewsButton");
  inboxEvents.inbox = now();
  const option = '[data-testid="pending-review-option"]:has-text("Call quality review")';
  await mobile.page.locator(option).first().waitFor();
  await sleep(900);
  await tap(mobile.page, option);
  inboxEvents.open = now();
  await answer(mobile.page, "Fixed both and opened PR #88").waitFor();
  inboxEvents.report = now();
  await sleep(2400);
  await finish("scheduleInbox", inbox, inboxEvents);
  await Promise.all([mobile.context.close(), context.close()]);
}

async function agentBrowser({ environment, browser, root, finish, openProject }: Kit): Promise<void> {
  const laptopNode = environment.nodes[0];
  const shopServer = await startShop(shopPort);
  try {
    // The machine whose browser this node's conversations use: itself.
    const admin = await signIn(environment, laptopNode);
    const configured = await api(laptopNode, admin, "PUT", "/browser/config", { executorNodeId: laptopNode.nodeId });
    if (configured.status !== 200) throw new Error(`Could not choose the browser machine: ${JSON.stringify(configured.body)}`);
    const { page, context } = await openStage(browser, environment, laptopNode, desktop);
    await openProject(page, "web-storefront");
    await page.locator("#collapseProjectsButton").click();
    await newConversation(page, "Promo code breaks checkout");
    await page.locator("#collapseChatsButton").click();
    await sleep(900);

    const events: Record<string, number> = {};
    const recording = await record(page, root, "browser");
    await sleep(500);
    await ask(page, "The promo code box on staging breaks checkout. Reproduce it in the browser, then fix it.");
    events.send = now();
    // The agent opens a browser; the panel that shows it is opened once there is something in it.
    for (let attempt = 0; attempt < 80; attempt++) {
      const sessions = await api<{ sessions?: unknown[] }>(laptopNode, admin, "GET", "/browser/sessions");
      if ((sessions.body.sessions ?? []).length > 0) break;
      await sleep(250);
    }
    events.started = now();
    await sleep(500);
    await glideClick(page, "#openBrowserButton", { ms: 420 });
    events.panel = now();
    await page.locator('[data-testid="browser-screen"]:not([hidden])').waitFor({ timeout: 30_000 });
    events.live = now();
    // Each browser step follows about a second after the sentence that announces it.
    for (const [event, text] of [["adding", "Adding a product"], ["checkout", "Going to checkout"], ["applying", "Applying a promo code"]] as const) {
      await answer(page, text).waitFor({ timeout: 90_000 });
      events[event] = now();
    }
    await answer(page, "Reproduced").waitFor({ timeout: 90_000 });
    events.reproduced = now();
    await answer(page, "Trying the same steps again").waitFor({ timeout: 90_000 });
    events.retry = now();
    await answer(page, "The code applies now").waitFor({ timeout: 90_000 });
    events.applies = now();
    await answer(page, "Fixed, and checked in the browser").waitFor({ timeout: 90_000 });
    events.done = now();
    await sleep(2200);
    // Anyone watching can take the wheel, and hand it back.
    await glideClick(page, '[data-testid="browser-take-control"]', { ms: 460 });
    events.control = now();
    await page.locator('[data-testid="browser-control-status"]', { hasText: "Human control" }).waitFor({ timeout: 15_000 });
    await sleep(1800);
    await glideClick(page, '[data-testid="browser-resume-agent"]', { ms: 420 });
    events.resumed = now();
    await sleep(1600);
    await finish("browser", recording, events);
    await context.close();
  } finally {
    // The app's browser keeps its connection to the shop open; closing waits for it otherwise.
    shopServer.closeAllConnections();
    await new Promise((resolve) => shopServer.close(resolve));
  }
}

async function secrets({ environment, browser, root, finish, openProject }: Kit): Promise<void> {
  const [laptopNode, serverNode, teammateNode] = environment.nodes;
  // The team exists already: this film is about what happens to a credential in it.
  const { owner, projectId } = await formTeam(environment, [serverNode, teammateNode], "checkout-api");
  const alex = await openStage(browser, environment, laptopNode, desktop);
  const home = await openStage(browser, environment, serverNode, desktop);
  const maya = await openStage(browser, environment, teammateNode, desktop);
  await openProject(alex.page, "checkout-api");
  await openProject(home.page, "checkout-api");
  await maya.page.locator("#projectList").waitFor();
  await sleep(1500);
  const accounts = async (node: PromoNode): Promise<Array<{ id: string; label: string }>> => (await api<{ accounts: Array<{ id: string; label: string }> }>(node, await signIn(environment, node), "GET", "/secrets")).body.accounts ?? [];
  const arrives = async (node: PromoNode): Promise<void> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if ((await accounts(node)).some((account) => account.label === "northwind-bot")) return;
      await sleep(500);
    }
    throw new Error(`${node.name} never received the account`);
  };
  /** Opens Settings on its Secrets tab, where the account is listed. */
  const openSecrets = async (page: Page): Promise<void> => {
    await glideClick(page, '[data-testid="settings-open-button"]', { ms: 420 });
    await page.locator("#settingsDialog[open]").waitFor();
    await sleep(300);
    await glideClick(page, "#settingsTab-secrets", { ms: 360 });
    await sleep(400);
  };
  const listed = '[data-testid="secret-account-list"] .secret-account-row:has-text("northwind-bot")';

  const events: Record<string, number> = {};
  const recordings = await Promise.all([record(alex.page, root, "secretsOwner"), record(home.page, root, "secretsTwin"), record(maya.page, root, "secretsMate")]);
  await sleep(500);
  // Added once, on the laptop: a GitHub account whose token is typed into a masked field.
  await openSecrets(alex.page);
  events.tab = now();
  await glideClick(alex.page, '[data-testid="secret-account-add-button"]', { ms: 360 });
  await alex.page.getByTestId("secret-account-dialog").waitFor();
  events.form = now();
  // The provider list opens with its search focused.
  await alex.page.keyboard.type("GitHub", { delay: 40 });
  await sleep(350);
  await alex.page.keyboard.press("Enter");
  await alex.page.getByTestId("secret-github-token-input").waitFor();
  await type(alex.page, '[data-testid="secret-account-label-input"]', "northwind-bot", 30);
  // Not a token: a made-up string in the shape of one.
  await type(alex.page, '[data-testid="secret-github-token-input"]', "ghp_promoVideoNotARealToken0000000000", 14);
  events.typed = now();
  await sleep(350);
  await glideClick(alex.page, '[data-testid="secret-account-replicate-toggle"]', { ms: 340 });
  events.replicate = now();
  await sleep(600);
  await glideClick(alex.page, '[data-testid="secret-account-save-button"]', { ms: 360 });
  await alex.page.locator(listed).waitFor();
  events.saved = now();
  await sleep(1500);

  // The owner's other machine has it within seconds.
  await arrives(serverNode);
  await openSecrets(home.page);
  await home.page.locator(listed).waitFor({ timeout: 30_000 });
  events.twin = now();
  await sleep(1800);

  // Shared with the whole team from the same row.
  await glideClick(alex.page, `${listed} [data-testid="secret-account-share-button"]`, { ms: 400 });
  await alex.page.locator("dialog.secret-sharing-dialog[open]").waitFor();
  events.shareDialog = now();
  await sleep(500);
  await glideClick(alex.page, 'dialog.secret-sharing-dialog input[data-node-id=""]', { ms: 340 });
  await sleep(450);
  await glideClick(alex.page, 'dialog.secret-sharing-dialog button:text-is("Save sharing")', { ms: 340 });
  await sleep(450);
  await glideClick(alex.page, '[data-testid="confirm-accept-button"]', { ms: 340 });
  events.shared = now();
  await sleep(1200);
  await arrives(teammateNode);
  await openSecrets(maya.page);
  await maya.page.locator(listed).waitFor({ timeout: 30_000 });
  events.mate = now();
  await sleep(1800);

  // Attached to one project, where an agent then uses it.
  await glideClick(alex.page, closeSettings, { ms: 380 });
  await sleep(500);
  await glideClick(alex.page, `[data-project-id="${projectId}"] [data-testid="project-menu-button"]`, { ms: 400 });
  await sleep(350);
  await glideClick(alex.page, '[data-testid="project-secrets-button"]', { ms: 320 });
  await alex.page.getByTestId("secret-scope-dialog").waitFor();
  events.scope = now();
  await sleep(450);
  await glideClick(alex.page, '[data-testid="secret-scope-dialog"] .secret-scope-row:has-text("northwind-bot") [data-testid="secret-scope-account-checkbox"]', { ms: 340 });
  await sleep(450);
  await glideClick(alex.page, '[data-testid="secret-scope-save-button"]', { ms: 340 });
  events.attached = now();
  await sleep(1200);
  await alex.page.locator("#collapseProjectsButton").click();
  await newConversation(alex.page, "Pull request for the retry fix");
  await sleep(700);
  await ask(alex.page, "Open a pull request for the retry fix.", 20);
  events.send = now();
  await answer(alex.page, "Opened PR #214").waitFor({ timeout: 60_000 });
  events.used = now();
  await sleep(2400);
  void owner;
  await finish("secretsOwner", recordings[0], events);
  await finish("secretsTwin", recordings[1], events);
  await finish("secretsMate", recordings[2], events);
  await Promise.all([alex.context.close(), home.context.close(), maya.context.close()]);
}

export const takes: Record<string, (kit: Kit) => Promise<void>> = { move, cluster, schedule, browser: agentBrowser, secrets };
