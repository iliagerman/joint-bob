import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const guardPath = fileURLToPath(new URL("./decision-network-guard.mjs", import.meta.url));

function attemptNetwork(source: string, configuredEndpoint: string) {
  const guardOption = `--import=${guardPath}`;
  const nodeOptions = [process.env.NODE_OPTIONS, guardOption].filter((value, index, all) => value && all.indexOf(value) === index).join(" ");
  const env = { ...process.env, NODE_OPTIONS: nodeOptions, JOINT_BOB_TYPESAFE_ENDPOINT: configuredEndpoint, TYPESAFE_AI_API_KEY: "synthetic-test-key" };
  return spawnSync(process.execPath, ["--eval", source], { cwd: process.cwd(), env, encoding: "utf8" });
}

test("test runner and child guards remove the Typesafe key", () => {
  assert.equal(process.env.TYPESAFE_AI_API_KEY, undefined);
  const result = attemptNetwork("if (process.env.TYPESAFE_AI_API_KEY !== undefined) process.exit(88); fetch('https://api.typesafe.ai/v1/systemone').catch(() => {})", "http://127.0.0.1:9/v1/systemone");
  assert.equal(result.status, 86, result.stderr || "child retained the key or did not block the request");
});

test("test children fail before sending requests to Typesafe and remote System One endpoints", () => {
  for (const [source, endpoint] of [
    ["fetch('https://api.typesafe.ai/v1/systemone').catch(() => {})", "http://127.0.0.1:9/v1/systemone"],
    ["import('node:https').then(({request}) => { try { request('https://laya.example/v1/systemone').end(); } catch {} })", "http://127.0.0.1:9/v1/systemone"],
    ["fetch(process.env.JOINT_BOB_TYPESAFE_ENDPOINT).catch(() => {})", "https://decision.example/custom-classifier"],
  ]) {
    const result = attemptNetwork(source, endpoint);
    assert.equal(result.status, 86, result.stderr || "decision-service request was not blocked");
    assert.match(result.stderr, /Blocked an outbound decision-service request/);
  }
});

test("the guard permits loopback classifier fixtures", async () => {
  const server = createServer((_request, response) => { response.writeHead(204).end(); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/systemone`);
    assert.equal(response.status, 204);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
