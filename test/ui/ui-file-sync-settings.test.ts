// Browser suite for Settings → File sync. It drives a real Chrome against a seeded node and
// answers every /api/file-sync/* request from fixtures, so it checks the screen against the
// engine's answers without running the engine: the tab is the admin's only, lists page instead
// of scrolling, each project says what its automatic move waits for, the admin compares every
// project or chosen ones, the first index says where it is, a move waits for its checks and asks
// twice, a finished move leaves no stale notice or figures, a refusal shows the checks the server
// names, a quiet engine is not asked again, and the differing files page.
//
// Run with `npm run test:file -- test/ui/ui-file-sync-settings.test.ts`. Like the rest of
// test/ui it needs a Chrome binary, and it fails rather than skipping when there is none.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";
import { addMember } from "../node-script.js";

const PEER = "node-peer-b";
const DAY = 86_400_000;
const DIFFERING = Array.from({ length: 30 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);

interface PeerPhase { peer: string; name: string; phase: string; error: string | null }
interface AutoSwitch { state: string; reason: string; cleanSince: string | null; cleanHours: number; decidedBy: string | null }
interface Project { projectId: string; name: string; owner: boolean; engine: "syncthing" | "builtin"; phase: string; phaseMessage: string | null; phaseError: string | null; cleanSince: string | null; differences: number; shares: string[]; waiting: boolean; peers: PeerPhase[]; autoSwitch: AutoSwitch | null }
interface Seen { method: string; path: string; query: string; at: number; body?: unknown }

const HOUR = 3_600_000;
// The owner's peers read the hold without the owner's own action (fix); the owner reads HELD_REASON.
const HELD = "Moved back to Syncthing by hand on node-a, so it stays there";
const HELD_HERE = "Moved back to Syncthing by hand; click Allow automatic move to let it move again";
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const projects: Project[] = Array.from({ length: 14 }, (_, index) => {
  const id = `p${String(index + 1).padStart(2, "0")}`;
  return { projectId: id, name: `Project ${id.slice(1)}`, owner: index < 3, engine: "syncthing", phase: "syncthing", phaseMessage: null, phaseError: null, cleanSince: ago(3 * DAY), differences: 0, shares: ["project"], waiting: false, peers: [], autoSwitch: null };
});
projects[0].differences = DIFFERING.length;
projects[0].cleanSince = null;
// auto-transition: what each project's automatic move waits for, as the server words it (migration.ts).
const auto = (state: string, reason: string, extra: Partial<AutoSwitch> = {}): AutoSwitch => ({ state, reason, cleanSince: null, cleanHours: 24, decidedBy: null, ...extra });
projects[0].autoSwitch = auto("blocked", "30 files differ with node-peer-b");
projects[1].autoSwitch = auto("blocked", "Waiting for Syncthing to finish copying");
projects[2].autoSwitch = auto("blocked", "Waiting for Matans-Sela-MacBook-Pro to update Joint Bob");
projects[3].autoSwitch = auto("held", HELD, { decidedBy: "node-a" });
projects[4].autoSwitch = auto("matching", "", { cleanSince: ago(6 * HOUR + 60_000), decidedBy: "node-a" });
// fix: one this machine owns and someone moved back by hand.
projects[7].owner = true;
projects[7].autoSwitch = auto("held", HELD_HERE);
/** What the PUT /api/file-sync/config stub keeps: the choice, the list kept under "All", and a project its owner asked for. */
let shadowProjects: "all" | string[] = "all";
let lastChosenProjects: string[] | null = null;
const requestedProjects = ["p09"];
let indexing: { projectId: string; name: string; position: number; total: number } | null = null;

// The server's ten checks for a move to built-in sync, in its order and words (migration.ts).
const passing = [
  { key: "owner", ok: true, message: "This machine owns the project" },
  { key: "shared", ok: true, message: "Shared with node-peer-b" },
  { key: "engine", ok: true, message: "File sync runs on this machine" },
  { key: "peers", ok: true, message: "Every machine runs built-in file sync" },
  { key: "rules", ok: true, message: "Every machine skips the same files" },
  { key: "differences", ok: true, message: "Every machine has the same files" },
  { key: "caughtUp", ok: true, message: "Every machine has seen the latest changes" },
  { key: "folders", ok: true, message: "Only Joint Bob's own Syncthing folders cover this project on every machine" },
  { key: "syncthing", ok: true, message: "Syncthing has nothing left to copy" },
  { key: "activity", ok: true, message: "No task or merge is running in this project" },
];
const checksFor: Record<string, Array<{ key: string; ok: boolean; message: string }>> = {
  p01: passing.map((check) => check.key === "differences" ? { key: "differences", ok: false, message: "30 files differ on node-peer-b" } : check),
  p02: passing,
  p03: passing,
};

/** The second project's folder size, as the engine reports it now. */
let shareBytes = 4_200_000;

function shareStatus(share: string, projectId: string, kind: string, differences: number, cleanSince: string | null) {
  return {
    share, projectId, kind, state: "idle", phase: "syncthing", maxSeq: 10, indexId: "index", digest: "digest", rulesHash: "rules",
    liveFiles: 120, liveBytes: projectId === "p02" ? shareBytes : 4_200_000, need: { files: 0, bytes: 0 }, blocked: 0, errors: 0, scanning: false, watch: "watching",
    peers: [{ peer: PEER, cursor: 10, peerMaxSeq: 10, peerIndexId: "peer", peerDigest: "digest", rulesMatch: true, caughtUp: true, differences, cleanSince, route: "direct" }],
  };
}

function statusAnswer() {
  return {
    enabled: true, worker: "running", config: { enabled: true, enabledBy: "default", shadowProjects, shadowProjectsBy: shadowProjects === "all" ? "default" : "settings", port: 22700, autoSwitch: { enabled: true, cleanHours: 24 }, requestedProjects, lastChosenProjects },
    origins: ["http://100.64.0.5:22700"], indexing,
    shares: [
      shareStatus("project:p01", "p01", "project", DIFFERING.length, null),
      shareStatus("tickets:p01", "p01", "tickets", 0, ago(2 * DAY)),
      shareStatus("project:p02", "p02", "project", 0, ago(3 * DAY)),
    ],
    peers: [{ nodeId: PEER, present: true, protocol: 2, switchCapable: true, enabled: true, origins: ["http://100.64.0.9:22700"], route: "direct", heardAt: ago(120_000) }],
  };
}

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const seen: Seen[] = [];
const pageErrors: string[] = [];

/** Every /api/file-sync/* request is answered here; nothing reaches the node's engine. */
async function answer(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const raw = request.postData();
  seen.push({ method: request.method(), path: url.pathname, query: url.search, at: Date.now(), ...(raw ? { body: JSON.parse(raw) } : {}) });
  const json = (status: number, payload: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
  const pageNumber = Number(url.searchParams.get("page") ?? 1), pageSize = Number(url.searchParams.get("pageSize") ?? 10);
  switch (`${request.method()} ${url.pathname}`) {
    case "GET /api/file-sync/status": return json(200, statusAnswer());
    case "PUT /api/file-sync/config": {
      const patch = JSON.parse(raw!) as { shadowProjects?: "all" | string[] };
      if (patch.shadowProjects === "all" && Array.isArray(shadowProjects)) lastChosenProjects = shadowProjects;
      if (patch.shadowProjects !== undefined) shadowProjects = patch.shadowProjects;
      return json(200, statusAnswer());
    }
    case "POST /api/file-sync/engine/allow-auto": {
      const project = projects.find((candidate) => candidate.projectId === (JSON.parse(raw!) as { projectId: string }).projectId)!;
      project.autoSwitch = auto("matching", "", { cleanSince: ago(HOUR) });
      return json(200, { project });
    }
    case "GET /api/file-sync/projects": return json(200, { projects });
    case "GET /api/file-sync/engine/checks": return json(200, { engine: url.searchParams.get("engine"), checks: checksFor[url.searchParams.get("projectId")!] ?? passing, cleanSince: ago(3 * DAY) });
    case "POST /api/file-sync/engine": {
      const { projectId, engine } = JSON.parse(raw!) as { projectId: string; engine: "builtin" | "syncthing" };
      if (projectId === "p03") return json(409, { error: "Some machines are not ready to move", checks: [passing[0], { key: "peers-live", ok: false, message: "node-peer-b did not answer just now" }] });
      const project = projects.find((candidate) => candidate.projectId === projectId)!;
      Object.assign(project, { engine, phase: "releasing", phaseMessage: `Waiting for Syncthing to release ${project.name}`, autoSwitch: null });
      return json(200, { project });
    }
    case "GET /api/file-sync/differences": {
      const items = url.searchParams.get("share") === "project:p01" ? DIFFERING.map((file) => ({ path: file, kind: "content", local: { size: 100, mtimeMs: 1, sha256: "a", deleted: false }, remote: { size: 120, mtimeMs: 2, sha256: "b", deleted: false }, since: ago(DAY) })) : [];
      return json(200, { total: items.length, items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize) });
    }
    case "GET /api/file-sync/errors": return json(200, { total: 0, items: [] });
    case "POST /api/file-sync/repair": return json(200, { ok: true });
    default: return json(404, { error: `Not stubbed: ${request.method()} ${url.pathname}` });
  }
}

const statusRequests = () => seen.filter((entry) => entry.method === "GET" && entry.path === "/api/file-sync/status");
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function signInAsAdmin(target: Page): Promise<void> {
  await target.goto(node.url, { waitUntil: "domcontentloaded" });
  await target.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await target.getByTestId("login-username-input").fill(environment.username);
  await target.getByTestId("login-password-input").fill(environment.password);
  await target.getByTestId("login-submit-button").click();
  await target.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });
}

/** Back to the project list's first page. */
async function projectListStart(): Promise<void> {
  if (await page.getByTestId("file-sync-project-detail").isVisible()) await page.getByTestId("file-sync-detail-back").click();
  const previous = page.getByTestId("file-sync-projects-page-previous");
  while (await previous.isVisible() && await previous.isEnabled()) { await previous.click(); await settle(); }
}

/** Pages to the project's row, wherever the fitted page size put it. */
async function showRow(projectId: string) {
  await projectListStart();
  const row = page.locator(`[data-testid="file-sync-project-row"][data-project-id="${projectId}"]`);
  await page.getByTestId("file-sync-project-row").first().waitFor();
  for (let clicks = 0; !(await row.isVisible()); clicks += 1) {
    assert.ok(clicks < projects.length, `${projectId} is on some page`);
    await page.getByTestId("file-sync-projects-page-next").click();
    await settle();
  }
  return row;
}

/** Pages to the project's row and opens its move. */
async function openMove(projectId: string): Promise<void> {
  const row = await showRow(projectId);
  await row.getByTestId("file-sync-project-move").click();
  await page.getByTestId("file-sync-project-detail").waitFor({ state: "visible" });
  await page.getByTestId("file-sync-checks").locator("li").first().waitFor();
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-file-sync-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  // A short window, so the project list has room for a few rows only.
  context = await browser.newContext({ viewport: { width: 1440, height: 640 }, reducedMotion: "reduce", serviceWorkers: "block" });
  await context.route("**/api/file-sync/**", answer);
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
}, { timeout: 120_000 });

after(async () => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, "final.png") }).catch(() => undefined);
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("signing in reaches the app", { timeout: 90_000 }, async () => {
  await signInAsAdmin(page);
});

test("the File sync tab sits next to Node and Resources and shows the engine and its machines", async () => {
  await page.getByTestId("settings-open-button").click();
  const tabs = await page.locator("[data-settings-tab]").evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.settingsTab));
  assert.deepEqual(tabs.slice(tabs.indexOf("node"), tabs.indexOf("node") + 3), ["node", "resources", "file-sync"], `File sync follows Node and Resources: ${tabs.join(", ")}`);
  await page.getByTestId("settings-tab-file-sync").click();
  await page.getByTestId("settings-panel-file-sync").waitFor({ state: "visible" });
  await page.getByTestId("file-sync-worker").filter({ hasText: "Running" }).waitFor();
  assert.equal(await page.getByTestId("file-sync-enabled-toggle").isChecked(), true);
  assert.match(await page.getByTestId("file-sync-addresses").innerText(), /directly at 100\.64\.0\.5:22700/);
  const peer = page.getByTestId("file-sync-peer-row");
  await peer.waitFor();
  assert.equal(await peer.getByTestId("file-sync-peer-reachable").innerText(), "Reachable");
  assert.match(await peer.getByTestId("file-sync-peer-facts").innerText(), /^Direct connection · Last heard 2 minutes ago$/);
  await page.getByTestId("file-sync-project-row").first().waitFor();
  assert.equal(await page.locator('[data-project-id="p01"]').getByTestId("file-sync-project-state").innerText(), "Synced by Syncthing");
  assert.equal(await page.locator('[data-project-id="p04"]').getByTestId("file-sync-project-move").count(), 0, "only the owner can move a project");
});

test("the project list pages instead of scrolling at a short height", async () => {
  const list = page.getByTestId("file-sync-project-list");
  await settle();
  const pager = page.getByTestId("file-sync-project-pager");
  await pager.waitFor({ state: "visible" });
  const label = page.getByTestId("file-sync-projects-page-label");
  const names = new Set<string>();
  const starts: number[] = [];
  for (let clicks = 0; ; clicks += 1) {
    assert.ok(clicks <= projects.length, "paging terminates");
    const box = await list.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight, rows: element.children.length }));
    assert.ok(box.scroll <= box.client + 1, `the list never overflows its box: ${JSON.stringify(box)}`);
    assert.ok(box.rows < projects.length, `a short window shows a page, not every project: ${box.rows}`);
    for (const name of await list.getByTestId("file-sync-project-row").locator(".relay-row-name").allInnerTexts()) names.add(name);
    starts.push(Number((await label.innerText()).split("–")[0]));
    const next = page.getByTestId("file-sync-projects-page-next");
    if (await next.isDisabled()) break;
    await next.click();
    await settle();
  }
  assert.deepEqual([...names].sort(), projects.map((project) => project.name), "every project is reachable with Next");
  for (let index = 1; index < starts.length; index += 1) assert.ok(starts[index] > starts[index - 1], `Next advances: ${starts.join(", ")}`);
  assert.match(await label.innerText(), /–14 of 14$/);
});

// auto-transition: nobody picks the moment; each project says what its move waits for, owners' and others' alike.
test("every project on Syncthing says what its automatic move waits for, naming the machine", async () => {
  const waiting = async (projectId: string) => (await showRow(projectId)).getByTestId("file-sync-project-waiting").innerText();
  assert.equal(await waiting("p01"), "30 files differ with node-peer-b");
  assert.equal(await waiting("p02"), "Waiting for Syncthing to finish copying");
  assert.equal(await waiting("p03"), "Waiting for Matans-Sela-MacBook-Pro to update Joint Bob");
  // Another machine owns these: its word, with the owner named on hover; the matching time is worded now.
  assert.equal(await waiting("p04"), HELD);
  assert.equal(await (await showRow("p04")).getByTestId("file-sync-project-waiting").getAttribute("title"), "node-a owns this project and moves it");
  assert.equal(await waiting("p05"), "Files have matched on every machine for 6 h; it moves to built-in sync after 24 h");
  assert.doesNotMatch(await (await showRow("p05")).locator(".relay-row-meta").first().innerText(), /Same files on every machine/, "the reason says it already");
  assert.equal(await (await showRow("p05")).getByTestId("file-sync-project-move").count(), 0, "the move stays the owner's");
  assert.equal(await (await showRow("p06")).getByTestId("file-sync-project-waiting").count(), 0, "nothing said, nothing shown");
  // The details say it too.
  await (await showRow("p03")).getByTestId("file-sync-project-details").click();
  await page.getByTestId("file-sync-project-detail").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("file-sync-detail-facts").getByTestId("file-sync-project-waiting").innerText(), "Waiting for Matans-Sela-MacBook-Pro to update Joint Bob");
  await page.getByTestId("file-sync-detail-back").click();
  await projectListStart();
});

// fix: a hold by hand can be lifted without moving the project now (the Move button needs every check to pass).
test("a project moved back by hand on this machine can be allowed to move by itself again", async () => {
  assert.equal(await (await showRow("p08")).getByTestId("file-sync-project-waiting").innerText(), HELD_HERE);
  await (await showRow("p08")).getByTestId("file-sync-project-details").click();
  await page.getByTestId("file-sync-project-detail").waitFor({ state: "visible" });
  await page.getByTestId("file-sync-allow-auto").click();
  await page.getByTestId("file-sync-detail-status").filter({ hasText: "Project 08 moves to built-in sync by itself once every machine is ready" }).waitFor();
  assert.deepEqual(seen.filter((entry) => entry.path === "/api/file-sync/engine/allow-auto").map((entry) => [entry.method, entry.body]), [["POST", { projectId: "p08" }]]);
  assert.equal(await page.getByTestId("file-sync-allow-auto").count(), 0, "nothing held any more");
  assert.equal(seen.filter((entry) => entry.method === "POST" && entry.path === "/api/file-sync/engine").length, 0, "nothing moved");
  // Another machine's hold has no such button here.
  await page.getByTestId("file-sync-detail-back").click();
  await (await showRow("p04")).getByTestId("file-sync-project-details").click();
  await page.getByTestId("file-sync-project-detail").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("file-sync-allow-auto").count(), 0);
  await page.getByTestId("file-sync-detail-back").click();
  await projectListStart();
});

test("Compare these projects: every shared one by default, or the ones ticked", async () => {
  const all = page.getByTestId("file-sync-compare-all"), chosen = page.getByTestId("file-sync-compare-chosen");
  assert.equal(await all.isChecked(), true);
  assert.equal(await page.getByTestId("file-sync-project-compare").count(), 0, "no ticks while every project is compared");
  const puts = () => seen.filter((entry) => entry.method === "PUT" && entry.path === "/api/file-sync/config").map((entry) => entry.body);
  // Choosing starts from every listed project, so nothing stops being compared by itself.
  await chosen.check();
  await page.getByTestId("file-sync-project-compare").first().waitFor();
  assert.deepEqual(puts().at(-1), { shadowProjects: projects.map((project) => project.projectId).sort() });
  assert.equal(await chosen.isChecked(), true);
  const box = (await showRow("p02")).getByTestId("file-sync-project-compare");
  assert.equal(await box.isChecked(), true);
  await box.uncheck();
  await page.getByTestId("file-sync-engine-status").filter({ hasText: "Project 02 is no longer compared on this machine, so it stays on Syncthing." }).waitFor();
  const unticked = projects.map((project) => project.projectId).filter((id) => id !== "p02").sort();
  assert.deepEqual(puts().at(-1), { shadowProjects: unticked });
  assert.equal(await (await showRow("p02")).getByTestId("file-sync-project-compare").isChecked(), false);
  assert.match(await (await showRow("p02")).locator("label:has([data-testid=file-sync-project-compare])").getAttribute("title") ?? "", /stays on Syncthing/);
  // fix: one its owner asked this machine to compare is ticked, and says why.
  shadowProjects = unticked.filter((id) => id !== "p09");
  await page.getByTestId("file-sync-refresh-button").click();
  await settle();
  const asked = (await showRow("p09")).getByTestId("file-sync-project-compare");
  assert.equal(await asked.isChecked(), true);
  assert.match(await (await showRow("p09")).locator("label:has([data-testid=file-sync-project-compare])").getAttribute("title") ?? "", /asked this machine to compare it/);
  shadowProjects = unticked;
  // fix: "All" over a chosen list asks first; cancelled, the chosen list stays.
  const before = puts().length;
  await all.check();
  await page.getByTestId("confirm-dialog").waitFor({ state: "visible" });
  await page.getByTestId("confirm-cancel-button").click();
  await settle();
  assert.equal(puts().length, before, "nothing saved");
  assert.equal(await chosen.isChecked(), true);
  // Accepted: every project; the chosen list is kept and comes back with Chosen….
  await all.check();
  await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("file-sync-engine-status").filter({ hasText: "Every project shared with another machine is compared" }).waitFor();
  assert.deepEqual(puts().at(-1), { shadowProjects: "all" });
  await settle();
  assert.equal(await page.getByTestId("file-sync-project-compare").count(), 0);
  await chosen.check();
  await page.getByTestId("file-sync-project-compare").first().waitFor();
  assert.deepEqual(puts().at(-1), { shadowProjects: unticked }, "the list chosen before comes back");
  assert.equal(await (await showRow("p02")).getByTestId("file-sync-project-compare").isChecked(), false);
  // Back to every project for the tests after this one.
  await all.check();
  await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("file-sync-engine-status").filter({ hasText: "Every project shared with another machine is compared" }).waitFor();
  await settle();
  await projectListStart();
});

test("the first index of the projects says which one it is on, and moves on by itself", { timeout: 30_000 }, async () => {
  const line = page.getByTestId("file-sync-indexing");
  assert.equal(await line.isVisible(), false);
  indexing = { projectId: "p05", name: "Project 05", position: 3, total: 19 };
  try {
    await page.getByTestId("file-sync-refresh-button").click();
    await line.filter({ hasText: "Reading Project 05's files for the first time (3 of 19)" }).waitFor();
    // While it indexes the page looks again by itself (at most every 5 s), and shows the next project.
    indexing = { projectId: "p06", name: "Project 06", position: 4, total: 19 };
    await line.filter({ hasText: "Reading Project 06's files for the first time (4 of 19)" }).waitFor({ timeout: 8_000 });
  } finally {
    indexing = null;
  }
  await line.waitFor({ state: "hidden", timeout: 8_000 });
});

test("a quiet engine is not asked again while the tab stays open", { timeout: 30_000 }, async () => {
  const before = statusRequests().length;
  await pause(6_500);
  assert.equal(statusRequests().length, before, "no project moves or copies, so nothing is refreshed on a timer");
});

test("a failing check keeps the move button disabled and says why", async () => {
  await openMove("p01");
  const failing = page.locator('[data-testid="file-sync-check-row"][data-key="differences"]');
  assert.equal(await failing.getAttribute("data-ok"), "false");
  assert.equal(await failing.getByTestId("file-sync-check-message").innerText(), "30 files differ on node-peer-b");
  // fix (P4+P5): the ones that passed fold into one line, so the details fit with the server's whole list.
  assert.equal(await page.locator('[data-testid="file-sync-check-row"][data-ok="true"]').count(), 0);
  const passed = page.getByTestId("file-sync-checks-passed");
  assert.equal(await passed.getByTestId("file-sync-checks-passed-text").innerText(), "9 other checks passed");
  assert.match(await passed.getAttribute("title") ?? "", /^This machine owns the project\nShared with node-peer-b\n[\s\S]*No task or merge is running in this project$/);
  const move = page.getByTestId("file-sync-move-button");
  assert.equal(await move.innerText(), "Move to built-in sync");
  assert.equal(await move.isDisabled(), true);
  assert.equal(await page.getByTestId("file-sync-move-reason").innerText(), "Every check must pass first.");
  assert.match(await page.getByTestId("file-sync-clean-since").innerText(), /matched on every machine for 3 days\. Joint Bob moves the project by itself once they have matched for 24 h; you can move it sooner\./);
  assert.equal(seen.filter((entry) => entry.method === "POST" && entry.path === "/api/file-sync/engine").length, 0, "nothing was moved");
  const asked = new URLSearchParams(seen.filter((entry) => entry.path === "/api/file-sync/engine/checks").at(-1)!.query);
  assert.deepEqual([asked.get("projectId"), asked.get("engine")], ["p01", "builtin"], "the checks are asked for the move the button would make");
});

// fix (P4+P5): the move button, its reason and the matching time stay on screen with the server's ten checks.
test("a project's details fit a laptop screen with the server's whole list of checks", async () => {
  const fits = async (label: string) => {
    await settle();
    const pane = page.getByTestId("file-sync-project-detail");
    const box = await pane.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight, bottom: element.getBoundingClientRect().bottom }));
    assert.ok(box.scroll <= box.client + 1, `${label}: the details do not scroll: ${JSON.stringify(box)}`);
    const button = await page.getByTestId("file-sync-move-button").boundingBox();
    assert.ok(button && button.y + button.height <= box.bottom + 1, `${label}: the move button is in view: ${JSON.stringify({ button, box })}`);
    assert.equal(await page.getByTestId("file-sync-clean-since").isVisible(), true, `${label}: the matching time is shown`);
  };
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await openMove("p01");
    await fits(`${viewport.width}x${viewport.height}, one check failing`);
    await openMove("p02");
    await fits(`${viewport.width}x${viewport.height}, every check passing`);
    assert.equal(await page.getByTestId("file-sync-checks-passed-text").innerText(), "All 10 checks passed");
  }
  await page.setViewportSize({ width: 1440, height: 640 });
  await projectListStart();
});

test("moving asks twice and posts the project and the engine", async () => {
  await openMove("p02");
  const move = page.getByTestId("file-sync-move-button");
  assert.equal(await move.isEnabled(), true, "every check passes");
  assert.equal(await page.getByTestId("file-sync-move-reason").isVisible(), false);
  await move.click();
  assert.equal(await move.innerText(), "Click again to move");
  await pause(300);
  assert.equal(seen.filter((entry) => entry.method === "POST" && entry.path === "/api/file-sync/engine").length, 0, "the first click only asks");
  const posted = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/file-sync/engine");
  await move.click();
  assert.deepEqual((await posted).postDataJSON(), { projectId: "p02", engine: "builtin" });
  await page.getByTestId("file-sync-detail-status").filter({ hasText: "Project 02 is moving to built-in sync" }).waitFor();
  assert.equal(await page.getByTestId("file-sync-detail-status").getAttribute("data-state"), "ok");
  await page.getByTestId("file-sync-detail-state").filter({ hasText: "Waiting for Syncthing to let go of the folders" }).waitFor();
  await page.getByTestId("file-sync-detail-facts").getByText("Waiting for Syncthing to release Project 02").waitFor();
});

test("a moving project is refreshed at most every 5 seconds, and only until it has moved", { timeout: 60_000 }, async () => {
  const moved = seen.find((entry) => entry.method === "POST" && entry.path === "/api/file-sync/engine")!.at;
  const deadline = Date.now() + 20_000;
  while (statusRequests().filter((entry) => entry.at > moved).length < 3 && Date.now() < deadline) await pause(250);
  const times = statusRequests().filter((entry) => entry.at > moved).map((entry) => entry.at);
  assert.ok(times.length >= 3, `the moving project was refreshed: ${times.length} status requests`);
  for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] >= 4_900, `at most one status request per 5 s: ${times.map((at) => at - moved).join(", ")}`);

  Object.assign(projects[1], { phase: "builtin", phaseMessage: null, autoSwitch: null });
  // fix (P4+P5): the folders' final figures come after the move: they are not left as the moving page showed them.
  shareBytes = 9_300_000;
  await page.getByTestId("file-sync-detail-state").filter({ hasText: "Synced by Joint Bob" }).waitFor({ timeout: 10_000 });
  const finishedAt = statusRequests().length;
  // The green "moving" notice goes once the move is over.
  await page.waitForFunction(() => document.querySelector('[data-testid="file-sync-detail-status"]')?.textContent === "");
  await pause(1_500);
  assert.equal(statusRequests().length, finishedAt + 1, "one more load once the move finished, for the folders' last figures");
  const settled = statusRequests().length;
  await pause(6_500);
  assert.equal(statusRequests().length, settled, "once nothing moves, nothing is refreshed");
  const back = page.getByTestId("file-sync-move-button");
  assert.equal(await back.innerText(), "Move back to Syncthing");
  assert.equal(await back.isDisabled(), true, "the checks loaded for the move to built-in sync say nothing about moving back");
  // "Check again" brings the folders' figures up to date as well.
  shareBytes = 9_400_000;
  const before = statusRequests().length;
  await page.getByTestId("file-sync-detail-check").click();
  await page.getByTestId("file-sync-checks").locator("li").first().waitFor();
  const asked = new URLSearchParams(seen.filter((entry) => entry.path === "/api/file-sync/engine/checks").at(-1)!.query);
  assert.deepEqual([asked.get("projectId"), asked.get("engine")], ["p02", "syncthing"]);
  assert.ok(statusRequests().length > before, "the status was loaded again with the checks");
  await page.getByTestId("file-sync-detail-facts").getByText("120 files, 9.40 MB").waitFor();
  assert.equal(await back.isEnabled(), true, "moving back is allowed once its own checks pass");
});

// fix (P4+P5): a move that waits for a person changes nothing by itself, so nothing is refreshed for it.
test("a move held by a person is not refreshed, and the owner sees a machine whose own move has not finished", { timeout: 40_000 }, async () => {
  const autoBefore = [projects[2].autoSwitch, projects[3].autoSwitch];
  Object.assign(projects[2], { engine: "builtin", phase: "builtin", autoSwitch: null, peers: [{ peer: PEER, name: "node-peer-b", phase: "releasing", error: "Syncthing folder “Photos” (/home/me/alpha/photos) is not Joint Bob's; remove it in Syncthing first" }] });
  Object.assign(projects[3], { engine: "builtin", phase: "releasing", autoSwitch: null, phaseError: "Syncthing folder “Documents” (/home/me/docs) is not Joint Bob's; remove it in Syncthing first" });
  try {
    await page.getByTestId("file-sync-refresh-button").click();
    const owned = await showRow("p03");
    await owned.getByTestId("file-sync-project-state").filter({ hasText: "Still moving on node-peer-b" }).waitFor();
    assert.match(await owned.locator(".relay-error").innerText(), /^node-peer-b: Syncthing folder “Photos” .* remove it in Syncthing first$/);
    const held = await showRow("p04");
    assert.match(await held.locator(".relay-error").innerText(), /“Documents”/);
    const before = statusRequests().length;
    await pause(6_500);
    assert.equal(statusRequests().length, before, "nothing moves until someone removes the folders");
  } finally {
    Object.assign(projects[2], { engine: "syncthing", phase: "syncthing", peers: [], autoSwitch: autoBefore[0] });
    Object.assign(projects[3], { engine: "syncthing", phase: "syncthing", phaseError: null, autoSwitch: autoBefore[1] });
    await page.getByTestId("file-sync-refresh-button").click();
    await settle();
  }
});

test("a refused move shows the checks the server names", async () => {
  await openMove("p03");
  const move = page.getByTestId("file-sync-move-button");
  await move.click();
  await move.click();
  const refused = page.locator('[data-testid="file-sync-check-row"][data-key="peers-live"]');
  await refused.waitFor();
  assert.equal(await refused.getAttribute("data-ok"), "false");
  assert.equal(await refused.getByTestId("file-sync-check-message").innerText(), "node-peer-b did not answer just now");
  assert.equal(await page.getByTestId("file-sync-check-row").count(), 1, "the server's checks replace the ones loaded before");
  assert.equal(await page.getByTestId("file-sync-checks-passed-text").innerText(), "1 other check passed");
  assert.equal(await page.getByTestId("file-sync-detail-status").innerText(), "Some machines are not ready to move");
  assert.equal(await page.getByTestId("file-sync-detail-status").getAttribute("data-state"), "error");
  assert.equal(await page.getByTestId("file-sync-move-button").isDisabled(), true, "the move waits for the failing check");
  await page.getByTestId("file-sync-detail-back").click();
});

test("the differing files page, and Repair names the folder and the machine", async () => {
  await page.getByTestId("file-sync-tab-differences").click();
  await page.getByTestId("file-sync-differences-section").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("file-sync-differences-count").innerText(), "30");
  const row = page.locator(`[data-testid="file-sync-diff-row"][data-project-id="p01"][data-peer="${PEER}"]`);
  assert.equal(await row.getByTestId("file-sync-diff-count").innerText(), "30 differences");
  assert.match(await row.innerText(), /Not matching yet/);
  assert.match(await page.locator('[data-testid="file-sync-diff-row"][data-project-id="p02"]').innerText(), /Same files[\s\S]*Matching for 3 days/);
  await row.getByTestId("file-sync-diff-open").click();
  await page.getByTestId("file-sync-diff-detail").waitFor({ state: "visible" });
  const items = page.getByTestId("file-sync-diff-items");
  await items.getByTestId("file-sync-diff-item").first().waitFor();
  await settle();
  const pager = page.getByTestId("file-sync-diff-items-pager");
  assert.equal(await pager.isVisible(), true, "thirty files do not fit: the list pages");
  const paths = new Set<string>();
  for (let clicks = 0; ; clicks += 1) {
    assert.ok(clicks <= DIFFERING.length, "paging terminates");
    const box = await items.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }));
    assert.ok(box.scroll <= box.client + 1, `the list never overflows its box: ${JSON.stringify(box)}`);
    for (const text of await items.getByTestId("file-sync-diff-path").allInnerTexts()) paths.add(text);
    const next = page.getByTestId("file-sync-diff-items-page-next");
    if (await next.isDisabled()) break;
    await next.click();
    await settle();
  }
  assert.deepEqual([...paths].sort(), DIFFERING, "every differing file is reachable with Next");
  assert.ok(seen.filter((entry) => entry.path === "/api/file-sync/differences").length > 1, "each page is asked from the engine");
  const repaired = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/file-sync/repair");
  await page.getByTestId("file-sync-diff-repair").click();
  assert.deepEqual((await repaired).postDataJSON(), { share: "project:p01", peer: PEER });
  await page.getByTestId("file-sync-diff-status").filter({ hasText: "list of files was reloaded" }).waitFor();
  assert.deepEqual(pageErrors, []);
});

test("a member sees no File sync tab and never asks for it", { timeout: 150_000 }, async () => {
  const member = addMember(environment, node, "noam", "noam@example.test");
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  try {
    const asked: string[] = [];
    await memberContext.route("**/api/file-sync/**", (route) => { asked.push(new URL(route.request().url()).pathname); return route.fulfill({ status: 403, contentType: "application/json", body: "{}" }); });
    const memberPage = await memberContext.newPage();
    memberPage.setDefaultTimeout(30_000);
    await memberPage.goto(node.url, { waitUntil: "domcontentloaded" });
    await memberPage.locator("#loginDialog[open]").waitFor();
    await memberPage.getByTestId("login-username-input").fill("noam@example.test");
    await memberPage.getByTestId("login-password-input").fill(member.oneTimePassword);
    await memberPage.getByTestId("login-submit-button").click();
    await memberPage.getByTestId("login-new-password-input").waitFor({ state: "visible" });
    await memberPage.getByTestId("login-password-input").fill(member.oneTimePassword);
    await memberPage.getByTestId("login-new-password-input").fill("member-chosen-password-1");
    await memberPage.getByTestId("login-submit-button").click();
    await memberPage.locator("#loginDialog[open]").waitFor({ state: "hidden" });
    await memberPage.getByTestId("settings-open-button").click();
    await memberPage.getByTestId("settings-tab-account").waitFor({ state: "visible" });
    assert.equal(await memberPage.getByTestId("settings-tab-file-sync").isVisible(), false, "no File sync tab for a member");
    assert.equal(await memberPage.locator('.settings-tabs-select option[value="file-sync"]').isDisabled(), true);
    assert.equal(await memberPage.getByTestId("settings-panel-file-sync").isVisible(), false);
    assert.deepEqual(asked, [], "a member's client never asks for file sync");
  } finally {
    await memberContext.close();
  }
});
