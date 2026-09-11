import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

async function panel() {
  const source = await readFile("public/app/updates.js", "utf8");
  const element = () => ({ disabled: false, textContent: "", checked: false, open: true, dataset: { tab: "updates" }, children: [] as any[], handlers: {} as Record<string, Function>,
    addEventListener(name: string, handler: Function) { this.handlers[name] = handler; },
    append(...children: any[]) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
  });
  const elements = Object.fromEntries(["settingsDialog", "settingsForm", "updatesVersionLine", "updatesStateLine", "updatesNodeList", "updatesInstallButton", "updatesInstallAllButton", "updatesAutoInput", "updatesCheckButton"].map((name) => [name, element()]));
  const fixture = {
    status: { currentVersion: "1.2.0", release: "old", supported: true, updateAvailable: false, activeJob: null as any, fleet: null as any, recentJobs: [] as any[], autoUpdate: false, latest: { release: { version: "1.2.0" }, checkedAt: null } },
    inventory: { local: { id: "local", name: "Local" }, remote: [{ peerId: "peer", name: "Peer", reachable: true, url: "https://peer", inventory: { version: "1.1.0", updates: { supported: true } } }] },
    elements, timers: new Map<number, Function>(), reloads: 0, offline: false, inventoryReads: 0,
  };
  const context = {
    elements, document: { createElement: element },
    location: { reload: () => { fixture.reloads++; } },
    api: async (url: string) => {
      if (fixture.offline) throw new Error("Node restarting");
      if (url === "/api/cluster/inventory") { fixture.inventoryReads++; return structuredClone(fixture.inventory); }
      return structuredClone(fixture.status);
    },
    confirmAction: async () => false, toast: () => {},
    setInterval: (callback: Function) => { fixture.timers.set(1, callback); return 1; },
    clearInterval: (id: number) => fixture.timers.delete(id),
  };
  const load = runInNewContext(`${source.replace(/^import .*;\n/gm, "").replace("export async function", "async function")}\nloadUpdatesPanel;`, context);
  return { ...fixture, fixture, load: () => load(structuredClone(fixture.inventory)), tick: async () => {
    for (const callback of fixture.timers.values()) callback();
    await new Promise((resolve) => setImmediate(resolve));
  } };
}

test("fleet button allows outdated peers while this node is current", async () => {
  const p = await panel();
  await p.load();
  assert.equal(p.elements.updatesInstallButton.disabled, true);
  assert.equal(p.elements.updatesInstallAllButton.disabled, false, "outdated peer must enable fleet update");
});

test("fleet button stays disabled for current peers, unsupported nodes, and busy updates", async () => {
  const p = await panel();
  p.fixture.inventory.remote[0].inventory.version = "1.2.0";
  await p.load();
  assert.equal(p.elements.updatesInstallAllButton.disabled, true);
  p.fixture.inventory.remote[0].inventory.version = "1.1.0";
  p.fixture.status.supported = false;
  await p.load();
  assert.equal(p.elements.updatesInstallAllButton.disabled, true);
  p.fixture.status.supported = true;
  p.fixture.status.fleet = { state: "running", target: "1.2.0", entries: [] };
  await p.load();
  assert.equal(p.elements.updatesInstallAllButton.disabled, true);
});

test("successful local update reloads after restart even with Settings closed", async () => {
  const p = await panel();
  p.fixture.status.activeJob = { id: "job", targetVersion: "1.3.0", state: "installing" };
  await p.load();
  p.elements.settingsDialog.open = false;
  p.elements.settingsDialog.handlers.close?.();
  p.fixture.offline = true;
  await p.tick();
  assert.equal(p.fixture.reloads, 0, "must wait for the server to return");
  p.fixture.offline = false;
  p.fixture.status.currentVersion = "1.3.0";
  p.fixture.status.activeJob = null;
  await p.tick();
  assert.equal(p.fixture.reloads, 1, "new server version must refresh the page");
  assert.equal(p.timers.size, 0);
});

test("peer-only rollout refreshes inventory and stops polling without a page reload", async () => {
  const p = await panel();
  p.fixture.status.fleet = { state: "running", target: "1.2.0", entries: [] };
  await p.load();
  p.fixture.status.fleet.state = "succeeded";
  p.fixture.inventory.remote[0].inventory.version = "1.2.0";
  await p.tick();
  assert.ok(p.fixture.inventoryReads > 0, "completion must fetch fresh peer versions");
  assert.equal(p.elements.updatesNodeList.children[1].children[2].textContent, "1.2.0");
  assert.equal(p.fixture.reloads, 0);
  assert.equal(p.timers.size, 0);
});

test("failed updates stop polling without reloading and show the error", async () => {
  const p = await panel();
  p.fixture.status.activeJob = { id: "job", targetVersion: "1.3.0", state: "installing" };
  await p.load();
  p.fixture.status.activeJob = null;
  p.fixture.status.recentJobs = [{ id: "job", targetVersion: "1.3.0", state: "failed", error: "checksum mismatch" }];
  await p.tick();
  assert.equal(p.fixture.reloads, 0);
  assert.equal(p.timers.size, 0);
  assert.match(p.elements.updatesStateLine.textContent, /checksum mismatch/);
});
