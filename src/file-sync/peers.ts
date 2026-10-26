import net from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { pinnedClusterPublicKey } from "../cluster-identity.js";
import { onPeerReturned, peerAway } from "../peer-presence.js";
import { fileSyncListenAddresses, isTailnetAddress } from "./control.js";
import { FILE_SYNC_MIN_PROTOCOL, FILE_SYNC_PROTOCOL, type PeerSpec } from "./protocol.js";
import { originSchema } from "./wire.js";

/* The peer directory the worker needs: whose signatures to accept (pinned keys), where a peer
   listens directly, whether it is around, and whether its engine can sync at all. What a peer says
   about its engine arrives in /hello (body and answer) and in its /files/shares answers; it is kept
   in memory only, and unknown means "not capable" until the peer says otherwise. */

export interface PeerFileSync {
  /** 0: the peer has no file sync engine (an older node: its hello or answer said nothing about one). */
  protocol: number;
  minProtocol?: number;
  /** Absent when the peer did not say (a hello body from a node that predates the field). */
  enabled?: boolean;
  /** auto-transition: its owner moves projects by itself, and file sync is on there unless someone turned it off (said in hellos only). */
  autoSwitch?: boolean;
  /** Direct origins that passed acceptablePeerOrigin. */
  origins: string[];
  hostId?: string;
  via: "hello" | "answer" | "shares";
  at: number;
}

const directory = new Map<string, PeerFileSync>();
const listeners = new Set<(peer: string) => void>();

function privateOrLoopback(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Where this node's worker may send signed requests for a peer. Direct listeners speak plain HTTP
 * inside WireGuard, so by default only tailnet addresses qualify. An operator who moved the
 * listener off the tailnet (JOINT_BOB_FILE_SYNC_LISTEN naming addresses) trusts loopback and private
 * networks too; "none" (relay only) widens nothing. Public and link-local addresses (cloud metadata)
 * never qualify.
 */
export function acceptablePeerOrigin(origin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!originSchema.safeParse(origin).success) return false;
  const url = new URL(origin);
  if (url.protocol !== "http:" || !url.port || !net.isIPv4(url.hostname)) return false;
  if (isTailnetAddress(url.hostname)) return true;
  const listen = env.JOINT_BOB_FILE_SYNC_LISTEN?.trim();
  return Boolean(listen) && fileSyncListenAddresses(env).length > 0 && privateOrLoopback(url.hostname);
}

const originList = z.array(z.unknown()).max(16).catch([]);
const announced = z.object({
  protocol: z.number().int().min(1).max(1_000_000),
  minProtocol: z.number().int().min(1).max(1_000_000).optional().catch(undefined),
  origins: originList.default([]),
  enabled: z.boolean().optional().catch(undefined),
  autoSwitch: z.boolean().optional().catch(undefined),
});

/** The fileSync part of a /hello body or answer; an absent or unreadable part means an engine-less (older) node. */
export function parseFileSyncPart(message: unknown, env: NodeJS.ProcessEnv = process.env): Omit<PeerFileSync, "via" | "at"> {
  const part = message && typeof message === "object" ? (message as { fileSync?: unknown }).fileSync : undefined;
  const parsed = announced.safeParse(part);
  if (!parsed.success) return { protocol: 0, origins: [] };
  const origins = parsed.data.origins.filter((origin): origin is string => typeof origin === "string" && acceptablePeerOrigin(origin, env));
  return {
    protocol: parsed.data.protocol,
    ...(parsed.data.minProtocol !== undefined ? { minProtocol: parsed.data.minProtocol } : {}),
    ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
    ...(parsed.data.autoSwitch !== undefined ? { autoSwitch: parsed.data.autoSwitch } : {}),
    origins: [...new Set(origins)],
  };
}

/** `enabled` absent: this node could not read its own switch (integrate: unknown, which an owner must not take for off). */
export interface HelloFileSync { protocol: number; minProtocol: number; origins: string[]; enabled?: boolean; autoSwitch: true }

/** This node's part of a /hello body and answer. Old receivers ignore the body; old senders ignore the answer. */
export function helloFileSync(self: { origins: readonly string[]; enabled: boolean | undefined }): HelloFileSync {
  return { protocol: FILE_SYNC_PROTOCOL, minProtocol: FILE_SYNC_MIN_PROTOCOL, origins: [...self.origins], ...(self.enabled !== undefined ? { enabled: self.enabled } : {}), autoSwitch: true };
}

/** Records what a peer said about its engine; listeners hear of it only when its origins or capability changed. */
export function notePeerFileSync(peer: string, info: Omit<PeerFileSync, "at">, now = Date.now()): boolean {
  const previous = directory.get(peer);
  // Shares answers do not say whether it moves projects by itself: what its hello said stays while its engine is the same, a
  // hello that said nothing as false (a later shares answer must not make a release without automatic moves look like one).
  const said = previous && previous.protocol === info.protocol && info.protocol > 0 ? previous.autoSwitch ?? (previous.via !== "shares" ? false : undefined) : undefined;
  const autoSwitch = info.autoSwitch ?? (info.via === "shares" ? said : undefined);
  const next: PeerFileSync = { ...info, ...(autoSwitch !== undefined ? { autoSwitch } : {}), origins: [...new Set(info.origins)], at: now };
  directory.set(peer, next);
  const changed = !previous || previous.protocol !== next.protocol || previous.enabled !== next.enabled || predatesAutoSwitch(previous) !== predatesAutoSwitch(next) || previous.origins.join("\n") !== next.origins.join("\n");
  if (changed) for (const listener of listeners) {
    try { listener(peer); } catch { /* a listener's failure is not the directory's */ }
  }
  return changed;
}

export function peerFileSync(peer: string): PeerFileSync | undefined { return directory.get(peer); }

/**
 * auto-transition: the peer runs a release without automatic moves (its hello or answer said nothing
 * of them), where file sync is off until someone turns it on: updating is what turns it on. False
 * while only its shares answers were heard (they do not say).
 */
export function predatesAutoSwitch(known: PeerFileSync | undefined): boolean {
  return Boolean(known && known.protocol > 0 && (known.autoSwitch === false || (known.via !== "shares" && known.autoSwitch === undefined)));
}

export function peerOrigins(peer: string): string[] { return [...directory.get(peer)?.origins ?? []]; }

/** Called when a peer's origins or capability changed (configure carries them to the worker). */
export function onPeerFileSyncChanged(listener: (peer: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests: forgets every peer. */
export function forgetPeerFileSync(): void { directory.clear(); }

/** One entry per peer with a pinned key, sorted, so an unchanged directory serializes identically. */
export function peerSpecs(db: DatabaseSync, peers: Iterable<string>): PeerSpec[] {
  const specs: PeerSpec[] = [];
  for (const nodeId of [...new Set(peers)].sort()) {
    let publicKey: string | undefined;
    try { publicKey = pinnedClusterPublicKey(db, nodeId); } catch { continue; }
    if (!publicKey) continue;
    specs.push({ nodeId, publicKey, origins: peerOrigins(nodeId), present: !peerAway(nodeId) });
  }
  return specs;
}

/** Called when a peer that was away answers again (a relay saw it, or it contacted us). */
export function onPeerPresent(listener: (peer: string) => void): () => void { return onPeerReturned(listener); }
