// Starts relay serving and relay memberships with the server (RELAY-PLAN.md §5).
import type { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { publishNtfyMessage, savedNtfyServer } from "../ntfy-publish.js";
import { markPeerReachable } from "../server/peer-availability.js";
import { isClusterOriginUrl } from "../server/http-auth.js";
import { requestInterceptors, server, upgradeHandlers } from "../server/state.js";
import { virtualRelayUrl } from "./protocol.js";
import { RelayServer } from "./relay-server.js";
import { RelayRuntime } from "./runtime.js";
import { listMemberships } from "./store.js";
import { SyncthingTunnels } from "./syncthing-tunnels.js";
import { setRelayTransport } from "./transport.js";
import { onRelayPeersChanged } from "./events.js";
import { setPhonePolicyDatabase } from "./phone-policy.js";

let relayServer: RelayServer | undefined;
let runtime: RelayRuntime | undefined;
let tunnels: SyncthingTunnels | undefined;
let nodeName = "machine";
let advertised: string | undefined;
let starting: Promise<void> | undefined;
let tunnelTimer: NodeJS.Timeout | undefined;

requestInterceptors.push((request, response) => relayServer?.handleRequest(request, response) ?? false);
upgradeHandlers.push((request, socket, head) => relayServer?.handleUpgrade(request, socket, head) ?? false);

let peersTimer: NodeJS.Timeout | undefined;
onRelayPeersChanged(() => {
  if (peersTimer) return;
  peersTimer = setTimeout(() => { peersTimer = undefined; relayPeersChanged(); }, 500);
  peersTimer.unref();
});

export function relayServerInstance(): RelayServer | undefined { return relayServer; }
export function relayRuntimeInstance(): RelayRuntime | undefined { return runtime; }

function rows<T>(db: DatabaseSync, sql: string, ...args: string[]): T[] {
  try { return db.prepare(sql).all(...args) as T[]; } catch { return []; }
}

/** Peers this machine knows from its own cluster and twin records; the relay adds none. */
function knownPeers(db: DatabaseSync): string[] {
  return [...new Set([
    ...rows<{ node_id: string }>(db, "SELECT DISTINCT node_id FROM cluster_v2_peer_endpoints"),
    ...rows<{ node_id: string }>(db, "SELECT DISTINCT node_id FROM cluster_v2_membership_nodes"),
  ].map((row) => row.node_id))];
}

/**
 * The URL this machine gives its clusters and twins: its own direct URL when it has one,
 * the relay origin when it serves a relay, otherwise a `.relay.invalid` name that peers
 * route through a relay both machines are on. Empty when there is no way to reach it.
 */
export async function advertisedNodeUrl(node?: { id: string; url: string }): Promise<string> {
  const local = node ?? await getClusterNode();
  if (local.url && isClusterOriginUrl(local.url)) return new URL(local.url).origin;
  if (relayServer?.enabled) return relayServer.origin;
  const db = await clusterV2Database();
  if (listMemberships(db).some((item) => item.status === "admitted")) return virtualRelayUrl(local.id);
  return "";
}

/** Tells peers the new URL when relay changes alter what this machine advertises. */
async function republishIfAdvertisedChanged(): Promise<void> {
  const next = await advertisedNodeUrl();
  if (next === advertised) return;
  advertised = next;
  if (!next) return;
  const { publishNodeDescriptor } = await import("../server/cluster-v2.js");
  await publishNodeDescriptor();
}

function scheduleTunnels(): void {
  if (tunnelTimer) return;
  tunnelTimer = setTimeout(() => { tunnelTimer = undefined; void tunnels?.update(); }, 1_000);
  tunnelTimer.unref();
}

export function startRelay(): Promise<void> {
  starting ??= (async () => {
    const db = await clusterV2Database();
    const node = await getClusterNode();
    nodeName = node.name;
    advertised = await advertisedNodeUrl(node);
    relayServer = new RelayServer(db, node.id, () => nodeName, (topic, message) => {
      try {
        void publishNtfyMessage(savedNtfyServer(undefined), topic, { title: "Joint Bob relay", message }).catch((error) => console.warn("Relay alert failed", error));
      } catch (error) { console.warn("Relay alert failed", error); }
    });
    relayServer.reload();
    runtime = new RelayRuntime(db, node.id, server, {
      acceptSyncthing: (stream) => tunnels?.accept(stream),
      syncthingAllowed: (from) => tunnels?.allowed(from) ?? false,
      knownPeers: () => knownPeers(db),
      peerOnline: (nodeId) => markPeerReachable(nodeId),
      membershipsChanged: () => { void republishIfAdvertisedChanged().catch((error) => console.warn("Publishing this machine's relay address failed", error)); },
      nodeName: () => nodeName,
    }, relayServer);
    setRelayTransport(runtime);
    setPhonePolicyDatabase(db);
    tunnels = new SyncthingTunnels(db, runtime);
    runtime.on("changed", scheduleTunnels);
    runtime.start();
    scheduleTunnels();
  })();
  return starting;
}

/** Applies changed relay serving settings. */
export async function relayServingChanged(): Promise<void> {
  await startRelay();
  relayServer?.reload();
  relayServer?.syncLocalPresence();
  runtime?.refreshWatch();
  runtime?.changed();
  await republishIfAdvertisedChanged().catch((error) => console.warn("Publishing this machine's relay address failed", error));
}

/** Clusters or twins changed: watch the new peer set, re-plan file tunnels, and drop former twins from an own-machines-only relay. */
export function relayPeersChanged(): void {
  relayServer?.enforceOwnMachinesOnly();
  runtime?.refreshWatch();
  scheduleTunnels();
}

export function setRelayNodeName(name: string): void { nodeName = name; }

export function stopRelay(): void {
  runtime?.stop();
  tunnels?.close();
  setRelayTransport(undefined);
}
