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
  await page.waitForFunction(`window.ntfyRequests.some((request) => request.path.endsWith("/share"))`);
  const requests = await page.evaluate("window.ntfyRequests");
  assert.deepEqual(requests.filter((request: { method: string }) => request.method !== "GET"), [
    { path: "/api/ntfy/services/00000000-0000-4000-8000-000000000002/default", method: "PUT" },
    { path: "/api/ntfy/services/00000000-0000-4000-8000-000000000002/share", method: "POST" },
  ]);
});
