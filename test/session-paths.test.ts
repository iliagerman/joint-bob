import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { sessionCwds } from "../src/session-paths.js";

test("sessionCwds returns both project paths", () => {
  const paths = sessionCwds({
    path: "/srv/projects/internal-assistant",
    macPath: "/Users/example/Projects/internal-assistant",
  });

  assert.deepEqual(paths, [
    "/srv/projects/internal-assistant",
    "/Users/example/Projects/internal-assistant",
  ]);
});

test("sessionCwds is direction-neutral", () => {
  const forward = sessionCwds({ path: "/server/project", macPath: "/mac/project" });
  const reverse = sessionCwds({ path: "/mac/project", macPath: "/server/project" });

  assert.deepEqual(new Set(reverse), new Set(forward));
});

test("sessionCwds normalizes and deduplicates paths", () => {
  const paths = sessionCwds({ path: "/server/work/../project", macPath: "/server/project" });

  assert.deepEqual(paths, ["/server/project"]);
});

test("sessionCwds includes paths learned from any number of nodes", () => {
  assert.deepEqual(
    sessionCwds({
      path: "/node-b/project",
      locations: [
        { nodeId: "node-a", path: "/node-a/project" },
        { nodeId: "node-c", path: "/node-c/project" },
      ],
    }),
    ["/node-b/project", "/node-a/project", "/node-c/project"],
  );
});

test("sessionCwds includes ticket worktrees", () => {
  assert.deepEqual(
    sessionCwds({ path: "/server/project", additionalPaths: ["/server/worktrees/ticket-one"] }),
    ["/server/project", "/server/worktrees/ticket-one"],
  );
});

test("sessionCwds supports projects without a paired path", () => {
  assert.deepEqual(sessionCwds({ path: "/server/project" }), ["/server/project"]);
});

test("one stale cross-node session alias does not hide valid sessions", async () => {
  const source = await readFile("src/pi-service.ts", "utf8");

  assert.match(source, /Could not list Pi sessions for/);
  assert.match(source, /return \[\];/);
});
