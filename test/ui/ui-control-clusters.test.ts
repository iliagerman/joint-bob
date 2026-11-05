import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

const SELA = "11111111-1111-4111-8111-111111111111";
const FAMILY = "22222222-2222-4222-8222-222222222222";
const MATAN = "00000000-0000-4000-8000-00000000000c";
const IDO = "00000000-0000-4000-8000-00000000000d";
const NOA = "00000000-0000-4000-8000-00000000000e";

interface Agent { projectId: string; projectName: string; conversationId: string; sessionId: string; path: string; title: string; agentLabel: string; agentModel: string | null; state: string; updatedAt: string | null; summary: string | null; nodeId: string; clusterIds: string[] }

function agent(overrides: Partial<Agent> & { conversationId: string; nodeId: string }): Agent {
  return {
    projectId: "dak", projectName: "DAK Live", sessionId: overrides.conversationId, path: `/x/${overrides.conversationId}`, title: overrides.conversationId, agentLabel: "Claude", agentModel: "opus",
    state: "running", updatedAt: new Date().toISOString(), summary: null, clusterIds: [SELA], ...overrides,
  };
}

async function signedIn(t: Parameters<typeof nativeUiFixture>[0]) {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  // Boot resets the view to the project list as its last step; open the control center only after that.
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
  return { page, node };
}

test("Clusters shows other people's agents by machine, pages to the height, follows the project filter and offers nothing that acts on them", { timeout: 120_000 }, async (t) => {
  const { page } = await signedIn(t);
  const crowd = Array.from({ length: 40 }, (_, index) => agent({ conversationId: `matan-${index}`, nodeId: MATAN, title: `Matan task ${index}`, summary: index === 0 ? "Writing the payout job" : null, updatedAt: new Date(Date.now() - index * 60_000).toISOString() }));
  const view = {
    clusters: [{ id: SELA, name: "Sela team", relay: false, machines: 3, running: 42 }, { id: FAMILY, name: "Family", relay: false, machines: 1, running: 1 }],
    machines: [
      { nodeId: MATAN, name: "Matan's Mac", away: false, clusterIds: [SELA], agents: crowd },
      { nodeId: IDO, name: "Ido's Laptop", away: false, clusterIds: [SELA, FAMILY], agents: [agent({ conversationId: "ido-1", nodeId: IDO, projectId: "kms", projectName: "KMS trunk", title: "Design studio: table", clusterIds: [SELA, FAMILY], state: "background", agentModel: null })] },
      { nodeId: NOA, name: "Noa's Mac", away: true, clusterIds: [SELA], agents: [] },
    ],
    projects: [{ id: "dak", name: "DAK Live" }, { id: "kms", name: "KMS trunk" }],
  };
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      if (path === '/api/control-center/clusters') return new Response(JSON.stringify(${JSON.stringify(view)}), { status: 200, headers: { 'content-type': 'application/json' } });
      return originalFetch(...args);
    };
  })()`);

  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-clusters").waitFor();
  const tabs = await page.getByTestId("control-center-tabs").locator("button").allTextContents();
  assert.match(tabs[0], /^Live agents/);
  assert.match(tabs[1], /^Clusters/, "the Clusters tab comes right after the live board");
  await page.getByTestId("control-tab-clusters").click();
  await page.getByTestId("cluster-card").first().waitFor();

  // The note says what is and is not shown, and the hint counts machines.
  assert.match(await page.getByTestId("clusters-note").innerText(), /Only projects people share with you[\s\S]*read-only/);
  assert.match(await page.getByTestId("clusters-hint").innerText(), /3 machines of other people · only what each shares with you/);
  assert.match(await page.getByTestId("control-tab-clusters").innerText(), /41/, "the tab counts every running agent");
  assert.match(await page.getByTestId("clusters-idle").innerText(), /Noa's Mac \(not answering\)/);

  // The list pages to the height it has instead of scrolling.
  const fits = () => page.getByTestId("clusters-list").evaluate((list) => list.scrollHeight <= list.clientHeight + 1);
  assert.equal(await fits(), true, "no scrolling");
  const first = await page.getByTestId("cluster-card").count();
  assert.ok(first > 1 && first < 41, `a page holds some of the cards, not all (${first})`);
  assert.match(await page.getByTestId("clusters-page-label").innerText(), new RegExp(`^1–${first} of 41$`));
  assert.equal(await page.getByTestId("clusters-page-previous").isDisabled(), true);
  const lane = page.getByTestId("cluster-lane").first();
  assert.match(await lane.innerText(), /Matan's Mac · 40 running · Sela team/);
  const firstTitles = await page.getByTestId("cluster-card").locator(".control-title").allTextContents();
  assert.equal(firstTitles[0], "Matan task 0");
  assert.match(await page.getByTestId("cluster-card").first().innerText(), /Writing the payout job/, "the summary is the live line");
  assert.match(await page.getByTestId("cluster-card").nth(1).innerText(), /Working…/, "without a summary a running agent says it works");

  await page.getByTestId("clusters-page-next").click();
  assert.equal(await fits(), true, "the next page does not scroll either");
  const secondTitles = await page.getByTestId("cluster-card").locator(".control-title").allTextContents();
  assert.equal(secondTitles[0], `Matan task ${first}`, "the next page continues where the last one stopped");
  assert.match(await page.getByTestId("cluster-lane").first().innerText(), /Matan's Mac/, "a lane that continues repeats its heading");
  assert.equal(await page.getByTestId("clusters-page-previous").isDisabled(), false);
  await page.getByTestId("clusters-page-previous").click();
  assert.equal((await page.getByTestId("cluster-card").locator(".control-title").first().innerText()), "Matan task 0");

  // Other people's agents carry nothing that acts on them: no buttons on a card, none of the board's card actions.
  assert.equal(await page.getByTestId("clusters-list").locator("button").count(), 0);
  assert.equal(await page.locator('#controlView-clusters [data-testid^="control-card-action-"]').count(), 0);
  assert.match(await page.getByTestId("cluster-card-open").first().innerText(), /Read-only/);

  // A cluster narrows the list; the project filter is the board's.
  await page.getByTestId(`clusters-chip-${FAMILY}`).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="cluster-card"]').length === 1);
  assert.match(await page.getByTestId("cluster-card").innerText(), /Design studio: table[\s\S]*background work/);
  assert.match(await page.getByTestId("cluster-card-machine").innerText(), /Ido's Laptop/);
  assert.equal(await page.getByTestId("clusters-page-label").count(), 0, "one page needs no pager");
  await page.getByTestId("clusters-chip-all").click();
  await page.getByTestId("clusters-filter-kms").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="cluster-card"]').length === 1);
  assert.deepEqual(await page.evaluate(async () => (await import("/app/state.js")).state.controlCenter.filter), ["kms"], "the project filter is the board's");
  await page.getByTestId("clusters-filter-dak").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="cluster-card"]').length > 1);
  await page.getByTestId("clusters-filter-all").click();
  assert.deepEqual(await page.evaluate(async () => (await import("/app/state.js")).state.controlCenter.filter), []);

  // The live board catches up with a filter chosen here.
  await page.getByTestId("clusters-filter-kms").click();
  await page.getByTestId("control-tab-live").click();
  await page.getByTestId("control-center-filters").waitFor();
  await page.getByTestId("control-center-filters").getByText("All", { exact: true }).click();
});

test("Clusters explains an empty state, and a person in no cluster is told how to join one", { timeout: 120_000 }, async (t) => {
  const { page } = await signedIn(t);
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.__view = { clusters: [], machines: [], projects: [] };
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      if (path === '/api/control-center/clusters') return new Response(JSON.stringify(window.__view), { status: 200, headers: { 'content-type': 'application/json' } });
      return originalFetch(...args);
    };
  })()`);
  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-clusters").click();
  await page.getByTestId("clusters-list").getByText(/You are not in a cluster/).waitFor();
  assert.equal(await page.getByTestId("clusters-chips").locator("button").count(), 0);

  await page.evaluate(`window.__view = { clusters: [{ id: '${SELA}', name: 'Sela team', relay: false, machines: 1, running: 0 }], machines: [{ nodeId: '${MATAN}', name: "Matan's Mac", away: false, clusterIds: ['${SELA}'], agents: [] }], projects: [] }`);
  await page.getByTestId("clusters-refresh").click();
  await page.getByTestId("clusters-list").getByText(/Nobody in your clusters is running anything they share with you/).waitFor();
  assert.match(await page.getByTestId("clusters-idle").innerText(), /Matan's Mac/);
});

test("clicking a card reads that conversation with nothing that writes to it, and never takes over or marks it reviewed", { timeout: 120_000 }, async (t) => {
  const { page, node } = await signedIn(t);
  // Two real conversations from the seeded projects, presented as other people's agents: one on a machine that answers (this node), one on a machine that does not.
  const found = await page.evaluate(`(async () => {
    const { projects } = await (await fetch('/api/projects')).json();
    const found = [];
    for (const project of projects) {
      const { sessions } = await (await fetch('/api/projects/' + project.id + '/sessions')).json();
      for (const session of sessions) found.push({ projectId: project.id, projectName: project.name, conversationId: session.conversationId ?? session.id, sessionId: session.id, path: session.path, title: session.title });
    }
    if (found.length < 2) throw new Error('need two seeded conversations');
    return found.slice(0, 2);
  })()`) as Array<{ projectId: string; projectName: string; conversationId: string; sessionId: string; path: string; title: string }>;
  const [real, away] = found;
  const view = {
    clusters: [{ id: SELA, name: "Sela team", relay: false, machines: 2, running: 2 }],
    machines: [
      { nodeId: node.nodeId, name: "Matan's Mac", away: false, clusterIds: [SELA], agents: [agent({ ...real, nodeId: node.nodeId, state: "running", agentModel: null })] },
      { nodeId: NOA, name: "Noa's Mac", away: false, clusterIds: [SELA], agents: [agent({ ...away, nodeId: NOA })] },
    ],
    projects: [{ id: real.projectId, name: real.projectName }],
  };
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.__requests = [];
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      window.__requests.push((args[1]?.method ?? 'GET') + ' ' + url.pathname);
      if (url.pathname === '/api/control-center/clusters') return new Response(JSON.stringify(${JSON.stringify(view)}), { status: 200, headers: { 'content-type': 'application/json' } });
      return originalFetch(...args);
    };
  })()`);
  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-clusters").click();
  await page.getByTestId("cluster-card").first().waitFor();

  // A machine that does not answer cannot be opened, and nothing is taken over to make it open.
  await page.locator(`[data-key="${away.projectId}:${away.conversationId}"]`).click();
  await page.waitForFunction(() => document.body.textContent?.includes("Noa's Mac is not answering"));
  assert.equal(await page.locator("body.view-chat").count(), 0, "nothing was opened");
  assert.equal(await page.locator("body.cluster-dive").count(), 0);

  // The machine that answers: the conversation opens in the normal view, read-only.
  await page.locator(`[data-key="${real.projectId}:${real.conversationId}"]`).click();
  await page.getByTestId("cluster-dive-banner").waitFor({ state: "visible" });
  assert.equal(await page.locator("body.view-chat").count(), 1, "the conversation is open");
  assert.equal(await page.locator("body.cluster-dive").count(), 1);
  assert.match(await page.getByTestId("cluster-dive-banner").innerText(), /Read-only: .* on Matan's Mac that is shared with you/);
  await page.waitForFunction(async () => { const { state } = await import("/app/state.js"); return state.socket?.readyState === WebSocket.OPEN; });
  for (const id of ["composer", "commandStrip", "abortButton", "chatMoreMenu", "autoRespondPill"]) {
    assert.equal(await page.locator(`#${id}`).evaluate((element) => getComputedStyle(element).display), "none", `#${id} is hidden while another person's agent is open`);
  }
  assert.equal(await page.locator(".chat-session-controls").evaluate((element) => getComputedStyle(element).display), "none", "the Runs on and agent pickers are hidden too");
  assert.equal(await page.getByTestId("control-lease-banner").isHidden(), true, "reading is not taking control");
  const requests = await page.evaluate("window.__requests") as string[];
  assert.deepEqual(requests.filter((request) => !request.startsWith("GET ") && /take-ownership|sessions\/reviewed|\/lease|\/recents/.test(request)), [], "no takeover, review mark, lease or recent entry");

  // Back to the tab; opening one of the person's own conversations from the list lifts the guard.
  await page.getByTestId("cluster-dive-back").click();
  await page.getByTestId("cluster-card").first().waitFor();
  assert.equal(await page.locator("body.view-control").count(), 1);
});
