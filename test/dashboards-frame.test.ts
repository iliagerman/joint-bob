import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { composeFrame, FRAME_CONTENT_SECURITY_POLICY } from "../src/dashboards/frame.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("the frame document embeds the kit, the page and the payload, escaped", () => {
  const html = composeFrame({ html: "<script>JointBobKit.mount(JointBobKit.text({ body: 'hi' }))</script>", payload: { generatedAt: "2026-10-24T09:00:00Z", title: "</script><img src=x onerror=alert(1)>" }, theme: "dark" });
  assert.match(html, /<html lang="en" data-theme="dark">/);
  assert.match(html, /window\.JointBobKit = Object\.freeze/, "the kit is inlined");
  assert.match(html, /--kit-series-1/, "the kit's styles are inlined");
  assert.match(html, /JointBobKit\.mount/);
  const embedded = /<script type="application\/json" id="payload">([^]*?)<\/script>/.exec(html)![1];
  assert.ok(!embedded.includes("</script>"), "the payload cannot close its script element");
  assert.equal(JSON.parse(embedded).title, "</script><img src=x onerror=alert(1)>");
  assert.match(composeFrame({ html: "", payload: undefined, theme: "light" }), /id="payload">\{\}<\/script>/, "no data yet is an empty object");
});

test("the frame policy forbids every network request", () => {
  assert.match(FRAME_CONTENT_SECURITY_POLICY, /default-src 'none'/);
  assert.match(FRAME_CONTENT_SECURITY_POLICY, /script-src 'unsafe-inline'/);
  assert.doesNotMatch(FRAME_CONTENT_SECURITY_POLICY, /connect-src/);
  assert.doesNotMatch(FRAME_CONTENT_SECURITY_POLICY, /https?:|\*/);
  assert.match(FRAME_CONTENT_SECURITY_POLICY, /form-action 'none'/);
  assert.match(FRAME_CONTENT_SECURITY_POLICY, /(^|; )sandbox allow-scripts(;|$)/, "opened on its own, the page still gets no app origin");
});

test("only the dashboard frame route may be framed by the app", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dashboard-frame-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const id = "00000000-0000-4000-8000-000000000000";
    const headers = async (endpoint: string) => (await fetch(`${node.url}/api${endpoint}`, { headers: { cookie: auth.cookie } })).headers;
    assert.equal((await headers(`/dashboards/${id}/frame`)).get("x-frame-options"), "SAMEORIGIN");
    assert.equal((await headers(`/dashboards/${id}`)).get("x-frame-options"), "DENY");
    assert.equal((await headers(`/dashboards/${id}/frame/extra`)).get("x-frame-options"), "DENY");
    const missing = await api(node, auth, "GET", `/dashboards/${id}/frame`);
    assert.equal(missing.status, 404);
  } finally {
    if (server) await stopDevNode(server);
  }
});
