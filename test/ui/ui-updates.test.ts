import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

// Stub only update responses: real page, DOM, settings module, timers and reload.
test("updates UI enables peer updates, refreshes peer versions, and reloads after local restart", { timeout: 90_000 }, async (t) => {
  const { page, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  const controls = await page.evaluate(`(async () => {
    const updates = await import("/app/updates.js");
    const nativeFetch = window.fetch;
    window.updateFixture = { currentVersion:"1.2.0", supported:true, updateAvailable:false, release:"old", latest:{release:{version:"1.2.0"}}, activeJob:null, recentJobs:[], fleet:null, autoUpdate:false };
    window.updateInventory = {local:{id:"local",name:"Local"},remote:[{peerId:"peer",name:"Peer",reachable:true,url:"https://peer",inventory:{version:"1.1.0",updates:{supported:true}}}]};
    window.fetch = (url, options) => url === "/api/update/status" ? Promise.resolve(Response.json(window.updateFixture)) : url === "/api/cluster/inventory" ? Promise.resolve(Response.json(window.updateInventory)) : nativeFetch(url, options);
    await updates.loadUpdatesPanel(window.updateInventory);
    return {allEnabled:!document.querySelector("#updatesInstallAllButton").disabled, localDisabled:document.querySelector("#updatesInstallButton").disabled};
  })()`);
  assert.deepEqual(controls, { allEnabled: true, localDisabled: true });
  await page.evaluate(`(async () => {
    window.updateFixture.fleet = { state:"running", target:"1.2.0", entries:[] };
    await (await import("/app/updates.js")).loadUpdatesPanel(window.updateInventory);
    window.updateInventory.remote[0].inventory.version = "1.2.0";
    window.updateFixture.fleet.state = "succeeded";
    return true;
  })()`);
  await page.waitForFunction(() => document.querySelectorAll(".updates-node-version")[1].textContent === "1.2.0");
  assert.equal(await page.locator("#updatesInstallAllButton").isDisabled(), true);
  await page.evaluate(`(async () => {
    window.updateFixture.activeJob = {id:"job",state:"installing",targetVersion:"1.3.0"};
    const dialog = document.querySelector("#settingsDialog");
    dialog.showModal();
    await (await import("/app/updates.js")).loadUpdatesPanel(window.updateInventory);
    dialog.close();
    window.updateFixture.activeJob = null;
    window.updateFixture.currentVersion = "1.3.0";
    return true;
  })()`);
  await page.waitForFunction(() => typeof window.updateFixture === "undefined");
  assert.equal(await page.evaluate('location.pathname'), "/", "reload stays on the current page");
});
