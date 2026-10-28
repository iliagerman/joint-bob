import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { presentReplicationPeers, signedPeerPost } from "../server/replication-v2.js";
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
