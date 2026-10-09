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
let relayServer;
let runtime;
let tunnels;
let nodeName = "machine";
let advertised;
let starting;
let tunnelTimer;
requestInterceptors.push((request, response) => relayServer?.handleRequest(request, response) ?? false);
upgradeHandlers.push((request, socket, head) => relayServer?.handleUpgrade(request, socket, head) ?? false);
let peersTimer;
onRelayPeersChanged(() => {
  if (peersTimer) return;
  peersTimer = setTimeout(() => {
    peersTimer = void 0;
    relayPeersChanged();
  }, 500);
  peersTimer.unref();
});
function relayServerInstance() {
  return relayServer;
}
function relayRuntimeInstance() {
  return runtime;
}
function rows(db, sql, ...args) {
  try {
    return db.prepare(sql).all(...args);
  } catch {
    return [];
  }
}
function knownPeers(db) {
  return [...new Set([
    ...rows(db, "SELECT DISTINCT node_id FROM cluster_v2_peer_endpoints"),
    ...rows(db, "SELECT DISTINCT node_id FROM cluster_v2_membership_nodes")
  ].map((row) => row.node_id))];
}
async function advertisedNodeUrl(node) {
  const local = node ?? await getClusterNode();
  if (local.url && isClusterOriginUrl(local.url)) return new URL(local.url).origin;
  if (relayServer?.enabled) return relayServer.origin;
  const db = await clusterV2Database();
  if (listMemberships(db).some((item) => item.status === "admitted")) return virtualRelayUrl(local.id);
  return "";
}
async function republishIfAdvertisedChanged() {
  const next = await advertisedNodeUrl();
  if (next === advertised) return;
  advertised = next;
  if (!next) return;
  const { publishNodeDescriptor } = await import("../server/cluster-v2.js");
  await publishNodeDescriptor();
}
function scheduleTunnels() {
  if (tunnelTimer) return;
  tunnelTimer = setTimeout(() => {
    tunnelTimer = void 0;
    void tunnels?.update();
  }, 1e3);
  tunnelTimer.unref();
}
function startRelay() {
  starting ??= (async () => {
    const db = await clusterV2Database();
    const node = await getClusterNode();
    nodeName = node.name;
    advertised = await advertisedNodeUrl(node);
    relayServer = new RelayServer(db, node.id, () => nodeName, (topic, message) => {
      try {
        void publishNtfyMessage(savedNtfyServer(void 0), topic, { title: "Joint Bob relay", message }).catch((error) => console.warn("Relay alert failed", error));
      } catch (error) {
        console.warn("Relay alert failed", error);
      }
    });
    relayServer.reload();
    runtime = new RelayRuntime(db, node.id, server, {
      acceptSyncthing: (stream) => tunnels?.accept(stream),
      syncthingAllowed: (from) => tunnels?.allowed(from) ?? false,
      knownPeers: () => knownPeers(db),
      peerOnline: (nodeId) => markPeerReachable(nodeId),
      membershipsChanged: () => {
        void republishIfAdvertisedChanged().catch((error) => console.warn("Publishing this machine's relay address failed", error));
      },
      nodeName: () => nodeName
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
async function relayServingChanged() {
  await startRelay();
  relayServer?.reload();
  relayServer?.syncLocalPresence();
  runtime?.refreshWatch();
  runtime?.changed();
  await republishIfAdvertisedChanged().catch((error) => console.warn("Publishing this machine's relay address failed", error));
}
function relayPeersChanged() {
  relayServer?.enforceOwnMachinesOnly();
  runtime?.refreshWatch();
  scheduleTunnels();
}
function setRelayNodeName(name) {
  nodeName = name;
}
function stopRelay() {
  runtime?.stop();
  tunnels?.close();
  setRelayTransport(void 0);
}
export {
  advertisedNodeUrl,
  relayPeersChanged,
  relayRuntimeInstance,
  relayServerInstance,
  relayServingChanged,
  setRelayNodeName,
  startRelay,
  stopRelay
};
