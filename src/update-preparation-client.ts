import { z } from "zod";
import { getClusterMachineToken, getClusterNode } from "./cluster.js";
import { getOrCreateClusterIdentity } from "./cluster-identity.js";
import { signClusterRequest } from "./cluster-protocol.js";
import { clusterV2Database } from "./cluster-v2-store.js";

const preparationResponseSchema = z.object({
  ready: z.literal(true),
  recoveryCount: z.number().int().nonnegative(),
}).strict();

async function recoveryCount(response: Response): Promise<number> {
  if (!response.ok) throw new Error(`Service update preparation failed (${response.status})`);
  return preparationResponseSchema.parse(await response.json()).recoveryCount;
}

async function prepareLegacyUpdate(port: number): Promise<number> {
  const token = await getClusterMachineToken();
  const response = await fetch(`http://127.0.0.1:${port}/api/update/prepare`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
    redirect: "error",
    signal: AbortSignal.timeout(90_000),
  });
  return recoveryCount(response);
}

export async function prepareLocalUpdate(port: number): Promise<number> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Service port is invalid");
  const target = "/api/cluster/v2/update/prepare";
  const body = Buffer.from("{}");
  const node = await getClusterNode();
  const database = await clusterV2Database();
  getOrCreateClusterIdentity(database, node.id);
  const authorization = signClusterRequest(database, node.id, node.id, "POST", target, body);
  const response = await fetch(`http://127.0.0.1:${port}${target}`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(90_000),
  });
  if (response.status === 401 || response.status === 404) return prepareLegacyUpdate(port);
  return recoveryCount(response);
}
