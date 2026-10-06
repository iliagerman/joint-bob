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

interface RecordedRequest { path: string; method: string; body: unknown }


test("ntfy settings manage topics, messages, users and the admin token inline", { timeout: 120_000 }, async (t) => {
  const { page, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  const serviceId = "00000000-0000-4000-8000-000000000001";
  await page.evaluate(async () => {
    const nativeFetch = window.fetch;
    const server = {
      requests: [] as Array<{ path: string; method: string; body: unknown }>,
      topics: {
        alerts: [{ username: "*", permission: "read-only" }, { username: "alice", permission: "read-write" }],
        "home-*": [{ username: "alice", permission: "read-write" }],
      } as Record<string, Array<{ username: string; permission: string }>>,
      users: [
        { username: "root", role: "admin", tier: null, grants: [] },
        { username: "*", role: "anonymous", tier: null, grants: [{ topic: "joint-bob*", permission: "read-write" }] },
        { username: "alice", role: "user", tier: "free", grants: [{ topic: "home-*", permission: "read-only" }, { topic: "alerts", permission: "read-write" }] },
        { username: "bob", role: "user", tier: null, grants: [] },
      ] as Array<{ username: string; role: string; tier: string | null; grants: Array<{ topic: string; permission: string }> }>,
      // Oldest first, as the server returns them.
      messages: Array.from({ length: 8 }, (_, index) => ({
        id: `m${index + 1}`, time: 1_700_000_000 + index * 60, expires: 1_700_043_200, topic: "alerts",
        title: index === 7 ? "Disk full" : null, message: `message ${index + 1}`, priority: index === 7 ? 4 : null,
        tags: index === 7 ? ["warning"] : [], click: null, attachment: null,
      })),
    };
    (window as unknown as { ntfyServer: typeof server }).ntfyServer = server;
    const base = "/api/ntfy/services/00000000-0000-4000-8000-000000000001";
    window.fetch = (url, options = {}) => {
      const full = String(url);
      const path = full.split("?")[0];
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(String(options.body)) : undefined;
      if (path === "/api/ntfy/services") {
        return Promise.resolve(Response.json({ services: [{ id: "00000000-0000-4000-8000-000000000001", name: "Home", url: "https://ntfy.home", hasToken: true, isDefault: true }] }));
      }
      if (!path.startsWith(base)) return nativeFetch(url, options);
      server.requests.push({ path: full, method, body });
      const rest = path.slice(base.length);
      if (rest === "" && method === "PUT") return Promise.resolve(Response.json({ service: { id: "00000000-0000-4000-8000-000000000001", name: "Home", url: "https://ntfy.home", hasToken: true, isDefault: true } }));
      if (rest === "/topics" && method === "GET") {
        return Promise.resolve(Response.json({ topics: Object.keys(server.topics).sort().map((topic) => ({ topic, grants: server.topics[topic] })) }));
      }
      if (rest === "/topics" && method === "PUT") {
        const grants = (server.topics[body.topic] ??= []);
        const existing = grants.find((grant) => grant.username === body.username);
        if (existing) existing.permission = body.permission; else grants.push({ username: body.username, permission: body.permission });
        return Promise.resolve(Response.json({ topic: { topic: body.topic, grants } }));
      }
      if (rest === "/topics" && method === "DELETE") {
        const grants = server.topics[body.topic] ?? [];
        const removed = body.username ? grants.filter((grant) => grant.username === body.username) : grants;
        server.topics[body.topic] = body.username ? grants.filter((grant) => grant.username !== body.username) : [];
        if (!server.topics[body.topic].length) delete server.topics[body.topic];
        return Promise.resolve(Response.json({ topic: body.topic, removed: removed.map((grant) => grant.username) }));
      }
      if (rest === "/messages") {
        const topic = new URL(full, location.href).searchParams.get("topic");
        return Promise.resolve(Response.json({ topic, messages: topic === "alerts" ? server.messages : [] }));
      }
      if (rest === "/users" && method === "GET") return Promise.resolve(Response.json({ users: server.users }));
      if (rest === "/users" && method === "POST") {
        server.users.push({ username: body.username, role: "user", tier: body.tier ?? null, grants: [] });
        return Promise.resolve(Response.json({ username: body.username }));
      }
      if (rest.startsWith("/users/") && method === "DELETE") {
        const username = decodeURIComponent(rest.slice("/users/".length));
        server.users = server.users.filter((user) => user.username !== username);
        return Promise.resolve(Response.json({ username }));
      }
      return Promise.resolve(Response.json({ error: `unstubbed ${method} ${rest}` }, { status: 500 }));
    };
    await (await import("/app/ntfy.js")).loadNtfyServicesPanel();
  });

  const sub = (testid: string) => page.getByTestId(testid);
  const click = (testid: string, scope = page.locator("body")) => scope.getByTestId(testid).first().evaluate((node: HTMLElement) => node.click());
  const setValue = (testid: string, value: string, scope = page.locator("body")) => scope.getByTestId(testid).first().evaluate((node: HTMLInputElement | HTMLSelectElement, next: string) => {
    node.value = next;
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  }, value);
  const until = async (check: () => Promise<boolean>, message: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await check()) return;
      await page.waitForTimeout(50);
    }
    assert.fail(message);
  };
  const mutations = async () => (await page.evaluate(() => (window as unknown as { ntfyServer: { requests: RecordedRequest[] } }).ntfyServer.requests) as RecordedRequest[])
    .filter((request) => request.method !== "GET");
  const lastMutation = async () => (await mutations()).at(-1);
  const texts = async (testid: string) => (await sub(testid).allTextContents()).map((text) => text.trim());
  const base = `/api/ntfy/services/${serviceId}`;

  // Open the manager from the service row.
  assert.equal(await sub("ntfy-manage-panel").evaluate((node: HTMLElement) => node.hidden), true);
  await click("ntfy-service-manage-button");
  await until(async () => (await sub("ntfy-manage-topic-row").count()) === 2, "topics render");
  assert.match((await sub("ntfy-manage-heading").textContent()) ?? "", /Home/);
  assert.deepEqual(await texts("ntfy-manage-topic-name"), ["alerts", "home-*"]);
  const alerts = sub("ntfy-manage-topic-row").nth(0);
  assert.deepEqual(await alerts.getByTestId("ntfy-manage-grant-user").allTextContents(), ["everyone", "alice"]);
  assert.equal(await sub("ntfy-manage-topics-page-label").textContent(), "Page 1 of 1");
  // Wildcard patterns cannot be read; concrete topics can.
  assert.equal(await sub("ntfy-manage-topic-messages-button").nth(1).isDisabled(), true);
  assert.equal(await sub("ntfy-manage-topic-messages-button").nth(0).isDisabled(), false);

  // Add a grant; "everyone" maps to the anonymous user.
  await setValue("ntfy-manage-add-topic-input", "alerts");
  await setValue("ntfy-manage-add-user-input", "everyone");
  await setValue("ntfy-manage-add-permission-select", "write-only");
  await click("ntfy-manage-add-grant-button");
  await until(async () => (await mutations()).length === 1, "grant PUT sent");
  assert.deepEqual(await lastMutation(), { path: `${base}/topics`, method: "PUT", body: { topic: "alerts", username: "*", permission: "write-only" } });
  await until(async () => (await alerts.getByTestId("ntfy-manage-grant-permission-select").first().inputValue()) === "write-only", "grant list reloads with the new permission");

  // Change a permission on change.
  await setValue("ntfy-manage-grant-permission-select", "deny-all", alerts);
  await until(async () => (await mutations()).length === 2, "permission PUT sent");
  assert.deepEqual(await lastMutation(), { path: `${base}/topics`, method: "PUT", body: { topic: "alerts", username: "*", permission: "deny-all" } });

  // Remove one grant.
  await click("ntfy-manage-grant-remove-button", alerts.getByTestId("ntfy-manage-grant-row").nth(1));
  await until(async () => (await mutations()).length === 3, "grant DELETE sent");
  assert.deepEqual(await lastMutation(), { path: `${base}/topics`, method: "DELETE", body: { topic: "alerts", username: "alice" } });
  await until(async () => (await alerts.getByTestId("ntfy-manage-grant-row").count()) === 1, "removed grant disappears");

  // Read messages, newest first, paginated.
  await click("ntfy-manage-topic-messages-button", sub("ntfy-manage-topic-row").nth(0));
  await until(async () => (await sub("ntfy-manage-message-row").count()) === 4, "first message page renders");
  assert.match((await sub("ntfy-manage-messages-heading").textContent()) ?? "", /alerts/);
  const firstPage = await texts("ntfy-manage-message-body");
  assert.deepEqual(firstPage, ["message 8", "message 7", "message 6", "message 5"]);
  assert.equal(await sub("ntfy-manage-message-title").first().textContent(), "Disk full");
  assert.match((await sub("ntfy-manage-message-meta").first().textContent()) ?? "", /priority 4 · warning/);
  assert.equal(await sub("ntfy-manage-messages-page-label").textContent(), "Page 1 of 2");
  assert.equal(await sub("ntfy-manage-messages-prev-button").isDisabled(), true);
  await click("ntfy-manage-messages-next-button");
  await until(async () => (await sub("ntfy-manage-message-row").count()) === 4, "second message page renders");
  assert.deepEqual(await texts("ntfy-manage-message-body"), ["message 4", "message 3", "message 2", "message 1"]);
  assert.equal(await sub("ntfy-manage-messages-page-label").textContent(), "Page 2 of 2");
  assert.equal(await sub("ntfy-manage-messages-next-button").isDisabled(), true);
  const messageRequests = async () => (await page.evaluate(() => (window as unknown as { ntfyServer: { requests: RecordedRequest[] } }).ntfyServer.requests) as RecordedRequest[])
    .filter((request) => request.path.includes("/messages"));
  assert.equal((await messageRequests()).at(-1)?.path, `${base}/messages?topic=alerts&since=all&limit=200`);
  // Any concrete topic can be read; an empty cache says so.
  await setValue("ntfy-manage-read-topic-input", "quiet-topic");
  await click("ntfy-manage-read-topic-button");
  await until(async () => (await sub("ntfy-manage-messages-empty").count()) === 1, "empty state renders");
  assert.match((await sub("ntfy-manage-messages-empty").textContent()) ?? "", /12 hours/);
  assert.equal((await messageRequests()).at(-1)?.path, `${base}/messages?topic=quiet-topic&since=all&limit=200`);
  // Invalid names never reach the server.
  const before = (await messageRequests()).length;
  await setValue("ntfy-manage-read-topic-input", "home-*");
  await click("ntfy-manage-read-topic-button");
  await page.waitForTimeout(150);
  assert.equal((await messageRequests()).length, before);

  // Replace the admin token.
  await click("ntfy-manage-tab-token");
  await setValue("ntfy-manage-token-input", "tk_admin");
  await click("ntfy-manage-token-save-button");
  await until(async () => (await mutations()).length === 4, "token PUT sent");
  assert.deepEqual(await lastMutation(), { path: base, method: "PUT", body: { token: "tk_admin" } });
  await until(async () => (await sub("ntfy-manage-token-input").inputValue()) === "", "token input is cleared");
  assert.equal(await sub("ntfy-manage-heading").count(), 1, "the manager stays open after the service list refreshes");

  // Users: protected accounts cannot be deleted.
  await click("ntfy-manage-tab-users");
  await until(async () => (await sub("ntfy-manage-user-row").count()) === 4, "users render");
  assert.deepEqual(await texts("ntfy-manage-user-name"), ["root", "everyone", "alice", "bob"]);
  assert.deepEqual(await texts("ntfy-manage-user-meta"), ["admin · 0 grants", "anonymous · 1 grant", "user · tier free · 2 grants", "user · 0 grants"]);
  assert.equal(await sub("ntfy-manage-user-delete-button").count(), 2);
  await setValue("ntfy-manage-user-name-input", "carol");
  await setValue("ntfy-manage-user-password-input", "s3cret");
  await setValue("ntfy-manage-user-tier-input", "pro");
  await click("ntfy-manage-user-create-button");
  await until(async () => (await mutations()).length === 5, "user POST sent");
  assert.deepEqual(await lastMutation(), { path: `${base}/users`, method: "POST", body: { username: "carol", password: "s3cret", tier: "pro" } });
  await until(async () => (await sub("ntfy-manage-user-row").count()) === 5, "new user listed");
  assert.equal(await sub("ntfy-manage-user-password-input").inputValue(), "");
  assert.equal(await sub("ntfy-manage-user-password-input").getAttribute("type"), "password");
  await click("ntfy-manage-user-delete-button", sub("ntfy-manage-user-row").filter({ hasText: "bob" }));
  await click("confirm-accept-button");
  await until(async () => (await mutations()).length === 6, "user DELETE sent");
  assert.deepEqual(await lastMutation(), { path: `${base}/users/bob`, method: "DELETE", body: undefined });
  await until(async () => (await sub("ntfy-manage-user-row").count()) === 4, "deleted user disappears");

  // Delete a whole topic after confirming.
  await click("ntfy-manage-tab-topics");
  await until(async () => (await sub("ntfy-manage-topic-row").count()) === 2, "topics render again");
  await click("ntfy-manage-topic-delete-button", sub("ntfy-manage-topic-row").nth(1));
  await click("confirm-accept-button");
  await until(async () => (await mutations()).length === 7, "topic DELETE sent");
  assert.deepEqual(await lastMutation(), { path: `${base}/topics`, method: "DELETE", body: { topic: "home-*" } });
  await until(async () => (await sub("ntfy-manage-topic-row").count()) === 1, "deleted topic disappears");

  // Close hides the section.
  await click("ntfy-manage-close-button");
  assert.equal(await sub("ntfy-manage-panel").evaluate((node: HTMLElement) => node.hidden), true);
});
