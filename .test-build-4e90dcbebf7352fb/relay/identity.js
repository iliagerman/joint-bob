import { clusterPublicKeyFingerprint, getOrCreateClusterIdentity, pinnedClusterPublicKey, signClusterMessage, verifyClusterMessage } from "../cluster-identity.js";
import { generateNoiseKeyPair } from "./noise.js";
const STATIC_DOMAIN = "relay-noise-static";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let staticKeyPair;
function localRelayIdentity(db, nodeId) {
  staticKeyPair ??= generateNoiseKeyPair();
  const identity = getOrCreateClusterIdentity(db, nodeId);
  const signature = signClusterMessage(db, nodeId, STATIC_DOMAIN, staticKeyPair.publicKey.toString("base64url"));
  const payload = Buffer.from(JSON.stringify({ v: 1, nodeId, publicKey: identity.publicKey, signature }), "utf8");
  return { nodeId, publicKey: identity.publicKey, staticKeyPair, payload };
}
function parseIdentityPayload(payload) {
  let parsed;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("Peer identity is malformed");
  }
  const value = parsed;
  if (value?.v !== 1 || typeof value.nodeId !== "string" || !UUID.test(value.nodeId) || typeof value.publicKey !== "string" || value.publicKey.length > 4096 || typeof value.signature !== "string") {
    throw new Error("Peer identity is malformed");
  }
  return { nodeId: value.nodeId, publicKey: value.publicKey, signature: value.signature };
}
function verifyIdentityPayload(identity, remoteStaticKey) {
  return verifyClusterMessage(identity.publicKey, STATIC_DOMAIN, remoteStaticKey.toString("base64url"), identity.signature);
}
function channelPrologue(kind, initiatorNodeId, responderNodeId) {
  return Buffer.from(`joint-bob-relay-v1
${kind}
${initiatorNodeId}
${responderNodeId}`, "utf8");
}
function sameKey(a, b) {
  try {
    return clusterPublicKeyFingerprint(a) === clusterPublicKeyFingerprint(b);
  } catch {
    return false;
  }
}
function expectPinnedPeer(db, nodeId) {
  return (remote) => {
    if (remote.nodeId !== nodeId) throw new Error("Relay connected a different machine");
    const pinned = pinnedClusterPublicKey(db, nodeId);
    if (!pinned) throw new Error("This machine has no pinned key for that peer");
    if (!sameKey(pinned, remote.publicKey)) throw new Error("Peer key does not match the pinned key");
  };
}
function expectAnnouncedPeer(db, from, fromKey) {
  return (remote) => {
    if (remote.nodeId !== from || !sameKey(remote.publicKey, fromKey)) throw new Error("Peer identity does not match the relay's announcement");
    const pinned = pinnedClusterPublicKey(db, from);
    if (pinned && !sameKey(pinned, remote.publicKey)) throw new Error("Peer key does not match the pinned key");
  };
}
export {
  channelPrologue,
  expectAnnouncedPeer,
  expectPinnedPeer,
  localRelayIdentity,
  parseIdentityPayload,
  sameKey,
  verifyIdentityPayload
};
