// Binds a machine's Noise static key to its Ed25519 node identity (RELAY-PLAN.md §4.3).
//
// The static X25519 key lives only in memory: every channel proves it with a fresh
// signature from the node key, so a restart simply makes a new one.
import type { DatabaseSync } from "node:sqlite";
import { clusterPublicKeyFingerprint, getOrCreateClusterIdentity, pinnedClusterPublicKey, signClusterMessage, verifyClusterMessage } from "../cluster-identity.js";
import { generateNoiseKeyPair, type NoiseKeyPair } from "./noise.js";
import type { ChannelKind } from "./protocol.js";

const STATIC_DOMAIN = "relay-noise-static";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RemoteRelayIdentity { nodeId: string; publicKey: string }

export interface LocalRelayIdentity {
  nodeId: string;
  publicKey: string;
  staticKeyPair: NoiseKeyPair;
  /** The Noise handshake payload: node ID, public key and the signature over the static key. */
  payload: Buffer;
}

interface IdentityPayload extends RemoteRelayIdentity { signature: string }

let staticKeyPair: NoiseKeyPair | undefined;

export function localRelayIdentity(db: DatabaseSync, nodeId: string): LocalRelayIdentity {
  staticKeyPair ??= generateNoiseKeyPair();
  const identity = getOrCreateClusterIdentity(db, nodeId);
  const signature = signClusterMessage(db, nodeId, STATIC_DOMAIN, staticKeyPair.publicKey.toString("base64url"));
  const payload = Buffer.from(JSON.stringify({ v: 1, nodeId, publicKey: identity.publicKey, signature }), "utf8");
  return { nodeId, publicKey: identity.publicKey, staticKeyPair, payload };
}

export function parseIdentityPayload(payload: Buffer): IdentityPayload {
  let parsed: unknown;
  try { parsed = JSON.parse(payload.toString("utf8")); } catch { throw new Error("Peer identity is malformed"); }
  const value = parsed as Partial<IdentityPayload> & { v?: unknown };
  if (value?.v !== 1 || typeof value.nodeId !== "string" || !UUID.test(value.nodeId) || typeof value.publicKey !== "string" || value.publicKey.length > 4096 || typeof value.signature !== "string") {
    throw new Error("Peer identity is malformed");
  }
  return { nodeId: value.nodeId, publicKey: value.publicKey, signature: value.signature };
}

export function verifyIdentityPayload(identity: IdentityPayload, remoteStaticKey: Buffer): boolean {
  return verifyClusterMessage(identity.publicKey, STATIC_DOMAIN, remoteStaticKey.toString("base64url"), identity.signature);
}

/** Mixed into the Noise handshake, so both sides must agree on who opens a channel to whom. */
export function channelPrologue(kind: ChannelKind, initiatorNodeId: string, responderNodeId: string): Buffer {
  return Buffer.from(`joint-bob-relay-v1\n${kind}\n${initiatorNodeId}\n${responderNodeId}`, "utf8");
}

export function sameKey(a: string, b: string): boolean {
  try { return clusterPublicKeyFingerprint(a) === clusterPublicKeyFingerprint(b); } catch { return false; }
}

/** The opener must reach exactly the node it asked for, proven by the key it already pinned. */
export function expectPinnedPeer(db: DatabaseSync, nodeId: string): (remote: RemoteRelayIdentity) => void {
  return (remote) => {
    if (remote.nodeId !== nodeId) throw new Error("Relay connected a different machine");
    const pinned = pinnedClusterPublicKey(db, nodeId);
    if (!pinned) throw new Error("This machine has no pinned key for that peer");
    if (!sameKey(pinned, remote.publicKey)) throw new Error("Peer key does not match the pinned key");
  };
}

/** The receiver accepts the machine the relay admitted, and if it already pinned a key for
    that node, only that key. What the machine may then do is decided by the usual checks. */
export function expectAnnouncedPeer(db: DatabaseSync, from: string, fromKey: string): (remote: RemoteRelayIdentity) => void {
  return (remote) => {
    if (remote.nodeId !== from || !sameKey(remote.publicKey, fromKey)) throw new Error("Peer identity does not match the relay's announcement");
    const pinned = pinnedClusterPublicKey(db, from);
    if (pinned && !sameKey(pinned, remote.publicKey)) throw new Error("Peer key does not match the pinned key");
  };
}
