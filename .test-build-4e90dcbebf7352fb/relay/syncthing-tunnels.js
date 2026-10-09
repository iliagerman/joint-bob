import net from "node:net";
import { syncthingListenPort, updateSyncthingDeviceAddresses } from "../syncthing.js";
import { recordTunnelAddress, tunnelAddresses } from "./store.js";
import { peerUsesRelay } from "./transport.js";
class SyncthingTunnels {
  constructor(db, runtime, localSyncPort = syncthingListenPort) {
    this.db = db;
    this.runtime = runtime;
    this.localSyncPort = localSyncPort;
  }
  db;
  runtime;
  localSyncPort;
  tunnels = /* @__PURE__ */ new Map();
  planning;
  replan = false;
  /** Loopback port of each active tunnel, by peer. */
  ports() {
    return Object.fromEntries([...this.tunnels].map(([peerId, tunnel]) => [peerId, tunnel.port]));
  }
  /** Peers that share files with this machine, with their Syncthing device IDs and URLs. */
  enrolledPeers() {
    const peers = /* @__PURE__ */ new Map();
    let rows = [];
    try {
      rows = this.db.prepare("SELECT DISTINCT peer_id, device_id FROM cluster_v2_file_enrollments").all();
    } catch {
      return peers;
    }
    for (const row of rows) {
      let entry = peers.get(row.peer_id);
      if (!entry) {
        let url;
        try {
          url = this.db.prepare("SELECT url FROM cluster_v2_peer_endpoints WHERE node_id=? LIMIT 1").get(row.peer_id)?.url;
        } catch {
          url = void 0;
        }
        entry = { deviceIds: /* @__PURE__ */ new Set(), url };
        peers.set(row.peer_id, entry);
      }
      entry.deviceIds.add(row.device_id);
    }
    return peers;
  }
  /** Whether a peer may open a tunnel here: it must already share files with this machine. */
  allowed(peerId) {
    try {
      return Boolean(this.db.prepare("SELECT 1 FROM cluster_v2_file_enrollments WHERE peer_id=? LIMIT 1").get(peerId));
    } catch {
      return false;
    }
  }
  /** Pipes a peer's tunnel into the local Syncthing listener. */
  accept(stream) {
    void this.localSyncPort().then((port) => {
      const local = net.connect({ host: "127.0.0.1", port });
      local.on("error", () => stream.destroy());
      stream.on("error", () => local.destroy());
      stream.pipe(local);
      local.pipe(stream);
    }, () => stream.destroy());
  }
  /** Re-plans tunnels after presence or sharing changed. Calls made while planning coalesce. */
  update() {
    if (this.planning) {
      this.replan = true;
      return this.planning;
    }
    this.planning = (async () => {
      do {
        this.replan = false;
        try {
          await this.plan();
        } catch (error) {
          console.warn("Relay Syncthing tunnel planning failed", error);
        }
      } while (this.replan);
    })().finally(() => {
      this.planning = void 0;
    });
    return this.planning;
  }
  async plan() {
    const peers = this.enrolledPeers();
    for (const peerId of peers.keys()) this.runtime.ensureWatched(peerId);
    for (const [peerId, tunnel] of this.tunnels) {
      const peer = peers.get(peerId);
      if (peer && peerUsesRelay(peerId, peer.url)) continue;
      this.tunnels.delete(peerId);
      tunnel.server.close();
    }
    const wanted = /* @__PURE__ */ new Map();
    for (const [peerId, peer] of peers) {
      if (!peerUsesRelay(peerId, peer.url)) continue;
      let tunnel = this.tunnels.get(peerId);
      if (!tunnel) {
        tunnel = await this.listen(peerId);
        this.tunnels.set(peerId, tunnel);
      }
      tunnel.deviceIds = [...peer.deviceIds];
      for (const deviceId of tunnel.deviceIds) wanted.set(deviceId, `tcp://127.0.0.1:${tunnel.port}`);
    }
    const recorded = tunnelAddresses(this.db);
    for (const [deviceId, address] of recorded) {
      if (wanted.get(deviceId) === address) continue;
      const done = await updateSyncthingDeviceAddresses(deviceId, (current) => current.filter((item) => item !== address)).catch(() => false);
      if (done) recordTunnelAddress(this.db, deviceId, null);
    }
    for (const [deviceId, address] of wanted) {
      if (recorded.get(deviceId) === address) continue;
      const done = await updateSyncthingDeviceAddresses(deviceId, (current) => [address, ...current.filter((item) => item !== address)]).catch(() => false);
      if (done) recordTunnelAddress(this.db, deviceId, address);
    }
  }
  listen(peerId) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        const stream = this.runtime.openStream(peerId, "syncthing");
        socket.on("error", () => stream.destroy());
        stream.on("error", () => socket.destroy());
        socket.pipe(stream);
        stream.pipe(socket);
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Tunnel has no port"));
          return;
        }
        resolve({ peerId, deviceIds: [], server, port: address.port });
      });
    });
  }
  close() {
    for (const tunnel of this.tunnels.values()) tunnel.server.close();
    this.tunnels.clear();
  }
}
export {
  SyncthingTunnels
};
