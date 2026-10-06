import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("ntfy settings share services and choose a default", { timeout: 90_000 }, async (t) => {
  const { page, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.evaluate(`(async () => {
    const nativeFetch = window.fetch;
    window.ntfyRequests = [];
    window.fetch = (url, options = {}) => {
      const path = String(url);
      window.ntfyRequests.push({path, method:options.method || "GET"});
      if (path.endsWith("/share")) window.ntfyShareBody = JSON.parse(options.body);
      if (path === "/api/clusters") return Promise.resolve(Response.json({clusters:[{id:"cluster-id",name:"Team",members:[{name:"node A"},{name:"node B"}]}]}));
      if (path === "/api/ntfy/services") return Promise.resolve(Response.json({services:[
        {id:"00000000-0000-4000-8000-000000000001",name:"Home",url:"https://ntfy.home",hasToken:true,isDefault:true},
        {id:"00000000-0000-4000-8000-000000000002",name:"Backup",url:"https://ntfy.backup",hasToken:false,isDefault:false}
      ]}));
      if (path.endsWith("/default")) return Promise.resolve(Response.json({ok:true}));
      if (path.endsWith("/share")) return Promise.resolve(Response.json({results:[{peerId:"peer",ok:true}]}));
      return nativeFetch(url, options);
    };
    await (await import("/app/ntfy.js")).loadNtfyServicesPanel();
  })()`);

  const rows = page.getByTestId("ntfy-service-list").locator("li");
  assert.equal(await rows.count(), 2);
  assert.match(await rows.first().innerText(), /Default/);
  await rows.nth(1).getByTestId("ntfy-service-default-button").evaluate((button: HTMLButtonElement) => button.click());
  await page.waitForFunction(`window.ntfyRequests.some((request) => request.path.endsWith("/default"))`);
  await rows.nth(1).getByTestId("ntfy-service-share-button").evaluate((button: HTMLButtonElement) => button.click());
  await page.getByText("Team · node A, node B").waitFor();
  await page.locator('.ntfy-share-dialog input[name="twins"]').uncheck();
  await page.locator('.ntfy-share-dialog input[name="cluster"]').check();
  await page.getByTestId("ntfy-share-confirm").evaluate((button: HTMLButtonElement) => button.click());
  await page.waitForFunction(`window.ntfyRequests.some((request) => request.path.endsWith("/share"))`);
  const requests = await page.evaluate("window.ntfyRequests");
  assert.deepEqual(requests.filter((request: { method: string }) => request.method !== "GET"), [
    { path: "/api/ntfy/services/00000000-0000-4000-8000-000000000002/default", method: "PUT" },
    { path: "/api/ntfy/services/00000000-0000-4000-8000-000000000002/share", method: "POST" },
  ]);
  assert.deepEqual(await page.evaluate("window.ntfyShareBody"), { includeTwins: false, clusterIds: ["cluster-id"] });
});

test("ntfy share dialog keeps its labels inside the card", { timeout: 90_000 }, async (t) => {
  const { page, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.evaluate(`(async () => {
    const nativeFetch = window.fetch;
    window.fetch = (url, options = {}) => {
      const path = String(url);
      if (path === "/api/clusters") return Promise.resolve(Response.json({clusters:[{id:"cluster-id",name:"Team",members:[{name:"node A"},{name:"node B"}]}]}));
      if (path === "/api/ntfy/services") return Promise.resolve(Response.json({services:[
        {id:"00000000-0000-4000-8000-000000000001",name:"Home",url:"https://ntfy.home",hasToken:true,isDefault:true}
      ]}));
      return nativeFetch(url, options);
    };
    await (await import("/app/ntfy.js")).loadNtfyServicesPanel();
  })()`);

  await page.getByTestId("ntfy-service-share-button").first().evaluate((button: HTMLButtonElement) => button.click());
  await page.getByText("Team · node A, node B").waitFor();

  // The global input rule sizes fields to width:100%. A checkbox that inherits it claims the
  // whole flex row and pushes the label text outside the dialog, which is unreadable.
  const layout = await page.evaluate(`(() => {
    const card = document.querySelector(".ntfy-share-dialog .dialog-card").getBoundingClientRect();
    const rows = Array.from(document.querySelectorAll(".ntfy-share-dialog label"));
    return rows.map((label) => {
      const node = Array.from(label.childNodes).find((child) => child.nodeType === 3 && child.textContent.trim());
      const range = document.createRange();
      range.selectNodeContents(node);
      const text = range.getBoundingClientRect();
      const box = label.querySelector("input").getBoundingClientRect();
      return {
        label: node.textContent.trim(),
        checkboxWidth: Math.round(box.width),
        withinCard: text.right <= card.right + 1 && text.left >= card.left - 1,
        legibleWidth: text.width > 80,
      };
    });
  })()`) as Array<{ label: string; checkboxWidth: number; withinCard: boolean; legibleWidth: boolean }>;

  assert.ok(layout.length >= 2, "the dialog offers twins and at least one cluster");
  for (const row of layout) {
    assert.ok(row.checkboxWidth <= 24, `"${row.label}" checkbox must not claim the row (was ${row.checkboxWidth}px)`);
    assert.ok(row.withinCard, `"${row.label}" must render inside the dialog card`);
    assert.ok(row.legibleWidth, `"${row.label}" must have room to read, not a one-word column`);
  }
  const clusters = page.locator(".ntfy-share-clusters");
  assert.equal(
    await clusters.evaluate((list: HTMLElement) => list.scrollWidth > list.clientWidth + 1),
    false,
    "the cluster list must not scroll sideways",
  );
});
