import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveDataDirectory } from "../src/data-directory.js";
import { applyBrowserConfiguration, readBrowserConfiguration, applyBrowserPreference, readBrowserPreference } from "../src/browser-configuration.js";

test("upgrade preserves original global executor row and conversation inheritance does not overwrite it", () => {
  const dir=resolveDataDirectory();mkdirSync(dir,{recursive:true});
  const db=new DatabaseSync(path.join(dir,"node.db"));
  const executorNodeId=randomUUID(),originNodeId=randomUUID(),updatedAt="2026-01-01T00:00:00.000Z";
  db.exec("CREATE TABLE browser_cluster_configuration (singleton INTEGER PRIMARY KEY CHECK(singleton=1), executor_node_id TEXT, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL)");
  db.prepare("INSERT INTO browser_cluster_configuration VALUES (1,?,?,?)").run(executorNodeId,updatedAt,originNodeId);
  db.close();
  assert.deepEqual(readBrowserConfiguration(),{executorNodeId,updatedAt,originNodeId});
  const identity={projectId:randomUUID(),engine:"pi" as const,conversationId:randomUUID()};
  applyBrowserPreference({...identity,nodeId:null,updatedAt,originNodeId});
  assert.equal(readBrowserPreference(identity)?.nodeId,null);
  assert.equal(readBrowserConfiguration().executorNodeId,executorNodeId);
  applyBrowserConfiguration({executorNodeId:null,originNodeId,updatedAt:"2025-01-01T00:00:00.000Z"});
  assert.equal(readBrowserConfiguration().executorNodeId,executorNodeId,"Older peer must not reset the selected machine");
});

test("conversation preference LWW uses node tie-breaks, inheritance tombstones, and exact scope", () => {
  const identity={projectId:randomUUID(),engine:"pi" as const,conversationId:randomUUID()};
  const earlier={...identity,nodeId:randomUUID(),originNodeId:"00000000-0000-0000-0000-000000000001",updatedAt:"2026-01-01T00:00:00.000Z"};
  const later={...earlier,nodeId:null,originNodeId:"00000000-0000-0000-0000-000000000002"};
  applyBrowserPreference(later);applyBrowserPreference(earlier);
  assert.deepEqual(readBrowserPreference(identity),later);
  assert.deepEqual(readBrowserPreference({...identity,engine:"claude"}),later,"Harness segments share the logical conversation preference");
  assert.equal(readBrowserPreference({...identity,projectId:randomUUID()}),null);
  assert.equal(readBrowserPreference({...identity,conversationId:randomUUID()}),null);
});
