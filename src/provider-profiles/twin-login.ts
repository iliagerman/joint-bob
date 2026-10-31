import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { presentReplicationPeers, signedPeerPost } from "../server/replication-v2.js";
import { PoolAttemptFailure } from "./pool-execution.js";
import type { PoolProfileContext } from "./context.js";
import type { ProviderProfile } from "./store.js";

/** A twin receives a short-lived access token. The refresh token never leaves the node where
    the user signed in, so two machines never rotate the same login and sign each other out. */
export interface BorrowedCredential { type: "oauth"; access: string; refresh: ""; expires: number; [field: string]: unknown }

export const TWIN_PROFILE_TOKEN_PATH = "/api/cluster/v2/twins/provider-profiles/token";
export const MIN_TOKEN_VALIDITY_MS = 10 * 60_000;
const borrowed = new Map<string, BorrowedCredential>();
const tokenReply = z.object({
  credential: z.object({ type: z.literal("oauth"), access: z.string().min(1).max(16_384), refresh: z.literal(""), expires: z.number().int() }).passthrough().nullable(),
}).strict();
const checkReply = z.object({ signedIn: z.boolean() }).strict();

async function presentTwins() {
  const db = await clusterV2Database(), local = await getClusterNode();
  return presentReplicationPeers(db, local.id).filter((peer) => isTrustedTwin(db, local.id, peer.nodeId));
}

export async function borrowClusterCredential(profile: ProviderProfile, context: PoolProfileContext): Promise<BorrowedCredential> {
  if (!context.clusterId || !context.poolOwnerNodeId) throw new Error("Cluster pool credential route is incomplete");
  const local = await getClusterNode();
  const db = await clusterV2Database();
  try {
    const { signedPost } = await import("../server/cluster-v2.js");
    const { credential } = tokenReply.parse(await signedPost<{ credential: BorrowedCredential | null }>(db, local.id, context.poolOwnerNodeId, context.clusterId,
      "/api/cluster/v2/subscription-pools/token", { clusterId: context.clusterId, poolId: context.poolId, profileId: profile.id }));
    if (!credential) throw new PoolAttemptFailure("auth", false, `No active sign-in for ${profile.label}`);
    if (credential.expires <= Date.now() + MIN_TOKEN_VALIDITY_MS) throw new PoolAttemptFailure("auth", false, `The sign-in for ${profile.label} is about to expire`);
    return credential as BorrowedCredential;
  } catch (error) {
    if (error instanceof PoolAttemptFailure) throw error;
    const status = (error as { statusCode?: unknown }).statusCode;
    throw new PoolAttemptFailure(status === 503 ? "unavailable" : "auth", false, `Could not use ${profile.label} from the assigned cluster pool`, { cause: error });
  }
}

export async function borrowTwinCredential(profile: ProviderProfile): Promise<BorrowedCredential> {
  const held = borrowed.get(profile.id);
  if (held && held.expires > Date.now() + MIN_TOKEN_VALIDITY_MS) return held;
  const failures: string[] = [];
  for (const twin of await presentTwins()) {
    try {
      const { credential } = tokenReply.parse(await signedPeerPost(twin, TWIN_PROFILE_TOKEN_PATH, { profileId: profile.id }));
      if (!credential) continue;
      if (credential.expires <= Date.now() + MIN_TOKEN_VALIDITY_MS) throw new Error("its token is about to expire");
      borrowed.set(profile.id, credential as BorrowedCredential);
      return credential as BorrowedCredential;
    } catch (error) { failures.push(`${twin.name}: ${error instanceof Error ? error.message : "no answer"}`); }
  }
  const reasons = failures.length ? ` ${failures.join("; ")}.` : "";
  throw new Error(`Sign in to ${profile.label} again on this node, or on a twin that is online.${reasons} No other account was used.`);
}

/** Which online twin holds its own sign-in for the profile, and which twins could not say. */
export async function twinLoginHolder(profile: ProviderProfile): Promise<{ holder?: string; unchecked: string[] }> {
  const unchecked: string[] = [];
  for (const twin of await presentTwins()) {
    try {
      if (checkReply.parse(await signedPeerPost(twin, TWIN_PROFILE_TOKEN_PATH, { profileId: profile.id, check: true })).signedIn) return { holder: twin.name, unchecked };
    } catch { unchecked.push(twin.name); }
  }
  return { unchecked };
}
