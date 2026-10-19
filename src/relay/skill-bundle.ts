// Delivery of the skills a relay enforces. The relay's signed policy names each skill and its
// digest; a following machine downloads the files here, over the relay's own HTTPS address,
// and checks them against that digest before installing.
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { agentResourcePaths } from "../agent-resources.js";
import { signClusterMessage, verifyClusterMessage } from "../cluster-identity.js";
import { buildSkillBundle, skillBundleDigest, validateSkillName } from "../skill-sharing.js";
import { publishedRelayPolicy } from "./resource-policy.js";
import { relayMachine, type RelayMembership } from "./store.js";

export const SKILL_BUNDLE_PATH = "/api/relay/v1/skill-bundle";
const MAX_REQUEST_BYTES = 1024;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_SKEW_MS = 5 * 60 * 1000;

const payload = (relayNodeId: string, name: string, timestamp: string): string => `${relayNodeId}\n${name}\n${timestamp}`;

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
}

async function readSmallBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > MAX_REQUEST_BYTES) throw new Error("Request too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Relay side: an admitted machine may download a skill this relay currently enforces, and nothing else. */
export async function serveSkillBundle(db: DatabaseSync, relayNodeId: string, request: IncomingMessage, response: ServerResponse, onStale: () => void = () => {}): Promise<void> {
  try {
    if (request.method !== "POST") { reply(response, 405, { error: "POST only" }); return; }
    const nodeId = String(request.headers["x-relay-machine"] ?? ""), timestamp = String(request.headers["x-relay-timestamp"] ?? ""), signature = String(request.headers["x-relay-signature"] ?? "");
    let name: string;
    try { name = String((JSON.parse(await readSmallBody(request)) as { name?: unknown }).name ?? ""); validateSkillName(name); }
    catch { reply(response, 400, { error: "Invalid request" }); return; }
    const machine = relayMachine(db, nodeId);
    const age = Math.abs(Date.now() - Number(timestamp));
    if (!machine || machine.status !== "admitted" || !Number.isFinite(age) || age > MAX_SKEW_MS
      || !verifyClusterMessage(machine.publicKey, "relay-skill-bundle", payload(relayNodeId, name, timestamp), signature)) { reply(response, 403, { error: "Forbidden" }); return; }
    const policy = publishedRelayPolicy(db, relayNodeId).body;
    const digest = policy.settings.skills.enforce ? policy.skillDigests?.[name] : undefined;
    if (!digest) { reply(response, 404, { error: "This relay does not enforce that skill" }); return; }
    const built = await buildSkillBundle(path.join(agentResourcePaths().sharedSkills, name), name);
    if (built.digest !== digest) { onStale(); reply(response, 409, { error: "The skill changed after the policy was published; a new policy follows shortly" }); return; }
    reply(response, 200, { name, digest, bundle: built.bundle });
  } catch (error) {
    console.warn(`Relay skill bundle request failed: ${(error as Error).message}`);
    if (!response.headersSent) reply(response, 500, { error: "Skill bundle unavailable" });
  }
}

/** Machine side: downloads one enforced skill from a relay and verifies it against the signed digest. */
export async function fetchRelaySkillBundle(db: DatabaseSync, localNodeId: string, relay: RelayMembership, name: string, expectedDigest: string): Promise<unknown> {
  if (!relay.relayNodeId) throw new Error("Relay identity is not known yet");
  const timestamp = String(Date.now());
  const response = await fetch(new URL(SKILL_BUNDLE_PATH, relay.origin), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000), body: JSON.stringify({ name }),
    headers: {
      "Content-Type": "application/json", "X-Relay-Machine": localNodeId, "X-Relay-Timestamp": timestamp,
      "X-Relay-Signature": signClusterMessage(db, localNodeId, "relay-skill-bundle", payload(relay.relayNodeId, name, timestamp)),
    },
  });
  if (!response.ok) {
    const detail = await response.json().then((body: { error?: string }) => body.error, () => undefined);
    throw new Error(`Relay refused skill ${name} (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (Number(response.headers.get("Content-Length") ?? "0") > MAX_RESPONSE_BYTES) throw new Error(`Skill ${name} from the relay is too large`);
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error(`Skill ${name} from the relay is too large`);
  const body = JSON.parse(text) as { name?: unknown; digest?: unknown; bundle?: unknown };
  if (body.name !== name || body.digest !== expectedDigest || skillBundleDigest(body.bundle) !== expectedDigest) throw new Error(`Skill ${name} from the relay does not match its signed digest`);
  return body.bundle;
}
