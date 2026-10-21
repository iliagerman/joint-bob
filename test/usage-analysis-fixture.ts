import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { ensureUsageSchema } from "../src/usage-ledger.js";
import { ensureClusterSharingPolicySchema } from "../src/cluster-sharing-policy.js";
import type { SeededNode } from "./dev-nodes.js";

export const reportClusterId = "6f1f6a8e-2b0e-4c55-9f53-0d1b6e2a7c11";

/** More than the analysis cap, with recent and old costs on the same conversations. */
export function seedUsageAnalysis(node: SeededNode): void {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try {
    ensureUsageSchema(db);
    const inventory = db.prepare("INSERT INTO usage_inventory(project_id,conversation_id,session_id,engine,title,usage_status) VALUES(?,?,?,?,?,?)");
    const timings = db.prepare("INSERT INTO usage_difficulty(turn_id,project_id,conversation_id,session_id,engine,occurred_at,payload,origin_node_id) VALUES(?,?,?,?,?,?,?,?)");
    const events = db.prepare("INSERT INTO model_usage_events(id,project_id,conversation_id,session_id,engine,occurred_at,payload,origin_node_id) VALUES(?,?,?,?,?,?,?,?)");
    for (let index = 0; index < 105; index++) {
      const id = `analysis-${String(index).padStart(3, "0")}`;
      inventory.run(node.projects[0].id, id, id, "pi", `Deploy service ${index}`, "reported");
      for (const [suffix, occurredAt, cost] of [
        ["old", "2024-12-01T12:00:00.000Z", 10],
        ["recent", new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString(), 1],
      ] as const) {
        const payload = { id: `${id}-${suffix}`, projectId: node.projects[0].id, conversationId: id, sessionId: id, engine: "pi", provider: "test", modelId: "fixture", occurredAt, requestId: null,
          input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, reasoning: 0, apiCostUsd: cost, pricing: null, usageStatus: "reported",
          difficultyLevel: null, difficultyConfidence: null, difficultyStatus: "unknown", turnId: null, toolCalls: 1, toolErrors: 1,
          skillReads: [{ id: "fixture-skill", name: "fixture-skill", version: suffix }] };
        events.run(payload.id, payload.projectId, id, id, "pi", occurredAt, JSON.stringify(payload), node.nodeId);
        const turn = { turnId: payload.id, projectId: payload.projectId, conversationId: id, sessionId: id, engine: "pi", occurredAt,
          status: "unknown", level: null, confidence: null, startedAt: occurredAt,
          endedAt: new Date(Date.parse(occurredAt) + (suffix === "recent" ? 1000 : 10000)).toISOString() };
        timings.run(turn.turnId, turn.projectId, id, id, "pi", occurredAt, JSON.stringify(turn), node.nodeId);
      }
    }
    ensureClusterSharingPolicySchema(db);
    db.prepare("INSERT INTO sharing_clusters(id,name,original_node_id,manager_node_id,manager_epoch,next_join_sequence,closed) VALUES(?,?,?,?,1,2,0)").run(reportClusterId, "Analysis cluster", node.nodeId, node.nodeId);
    db.prepare("INSERT INTO sharing_memberships(cluster_id,node_id,join_sequence) VALUES(?,?,1)").run(reportClusterId, node.nodeId);
    db.prepare("INSERT OR IGNORE INTO sharing_resource_owners(kind,resource_id,owner_node_id) VALUES('project',?,?)").run(node.projects[0].id, node.nodeId);
    db.prepare("INSERT INTO sharing_resource_shares(kind,resource_id,cluster_id,project_id) VALUES('project',?,?,'')").run(node.projects[0].id, reportClusterId);
  } finally { db.close(); }
}
