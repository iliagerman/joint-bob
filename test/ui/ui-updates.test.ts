import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

const exec = promisify(execFile);
async function browser(...args: string[]) {
  if (!process.env.JOINT_BOB_BROWSER_CLI) throw new Error("Designated browser executor is required");
  const { stdout } = await exec(process.execPath, [process.env.JOINT_BOB_BROWSER_CLI, ...args], { timeout: 30_000 });
  return JSON.parse(stdout).result;
}

async function waitFor(expression: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if (await browser("evaluate", expression)) return;
    } catch (error) {
      // A real reload can replace the document during the assertion itself.
      if (!(error instanceof Error) || !error.message.includes("Execution context was destroyed")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`Browser condition did not become true: ${expression}`);
}

// Stub only update responses: real page, DOM, settings module, timers and reload.
// Browser commands always go through this conversation's designated executor.
test("updates UI enables peer updates, refreshes peer versions, and reloads after local restart", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "updates-browser-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  try {
    await browser("start");
    await browser("navigate", node.url);
    const controls = await browser("evaluate", `(async () => {
      const updates = await import("/app/updates.js");
      const nativeFetch = window.fetch;
      window.updateFixture = { currentVersion:"1.2.0", supported:true, updateAvailable:false, release:"old", latest:{release:{version:"1.2.0"}}, activeJob:null, recentJobs:[], fleet:null, autoUpdate:false };
      window.updateInventory = {local:{id:"local",name:"Local"},remote:[{peerId:"peer",name:"Peer",reachable:true,url:"https://peer",inventory:{version:"1.1.0",updates:{supported:true}}}]};
      window.fetch = (url, options) => url === "/api/update/status" ? Promise.resolve(Response.json(window.updateFixture)) : url === "/api/cluster/inventory" ? Promise.resolve(Response.json(window.updateInventory)) : nativeFetch(url, options);
      await updates.loadUpdatesPanel(window.updateInventory);
      return {allEnabled:!document.querySelector("#updatesInstallAllButton").disabled, localDisabled:document.querySelector("#updatesInstallButton").disabled};
    })()`);
    assert.deepEqual(controls, { allEnabled: true, localDisabled: true });
    await browser("evaluate", `(async () => {
      window.updateFixture.fleet = { state:"running", target:"1.2.0", entries:[] };
      await (await import("/app/updates.js")).loadUpdatesPanel(window.updateInventory);
      window.updateInventory.remote[0].inventory.version = "1.2.0";
      window.updateFixture.fleet.state = "succeeded";
      return true;
    })()`);
    await waitFor('document.querySelectorAll(".updates-node-version")[1].textContent === "1.2.0"');
    assert.equal(await browser("evaluate", 'document.querySelector("#updatesInstallAllButton").disabled'), true);
    await browser("evaluate", `(async () => {
      window.updateFixture.activeJob = {id:"job",state:"installing",targetVersion:"1.3.0"};
      const dialog = document.querySelector("#settingsDialog");
      dialog.showModal();
      await (await import("/app/updates.js")).loadUpdatesPanel(window.updateInventory);
      dialog.close();
      window.updateFixture.activeJob = null;
      window.updateFixture.currentVersion = "1.3.0";
      return true;
    })()`);
    await waitFor('typeof window.updateFixture === "undefined"');
    assert.equal(await browser("evaluate", 'location.pathname'), "/", "reload stays on the current page");
  } finally {
    try { await browser("close"); }
    finally {
      await stopDevNode(server);
      await rm(root, { recursive: true, force: true });
    }
  }
});
