// File sync between machines that reach each other only through a relay (RELAY-PLAN.md §4.9).
//
// For such a peer, this machine listens on a loopback port and adds `tcp://127.0.0.1:<port>`
// to the peer's Syncthing addresses. A connection on that port becomes an encrypted relay
// channel to the peer, which pipes it into its own Syncthing. Syncthing ranks this LAN-like
// address above its public relays, so those are used only when the tunnel is down.
//
// Which folders go to which device is still decided by the sharing code; a tunnel only
// changes the address Syncthing dials, and Syncthing's own device authentication still runs.
import net, { type Server } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { syncthingListenPort, updateSyncthingDeviceAddresses } from "../syncthing.js";
import { recordTunnelAddress, tunnelAddresses } from "./store.js";
import type { RelayRuntime } from "./runtime.js";
import type { RelayStream } from "./stream.js";
import { peerUsesRelay } from "./transport.js";

interface Tunnel { peerId: string; deviceIds: string[]; server: Server; port: number }

export class SyncthingTunnels {
  private readonly tunnels = new Map<string, Tunnel>();
  private planning: Promise<void> | undefined;
  private replan = false;

  constructor(private readonly db: DatabaseSync, private readonly runtime: RelayRuntime, private readonly localSyncPort: () => Promise<number> = syncthingListenPort) {}

  /** Loopback port of each active tunnel, by peer. */
  ports(): Record<string, number> {
    return Object.fromEntries([...this.tunnels].map(([peerId, tunnel]) => [peerId, tunnel.port]));
  }

  /** Peers that share files with this machine, with their Syncthing device IDs and URLs. */
  private enrolledPeers(): Map<string, { deviceIds: Set<string>; url: string | undefined }> {
    const peers = new Map<string, { deviceIds: Set<string>; url: string | undefined }>();
    let rows: Array<{ peer_id: string; device_id: string }> = [];
    try { rows = this.db.prepare("SELECT DISTINCT peer_id, device_id FROM cluster_v2_file_enrollments").all() as typeof rows; } catch { return peers; }
    for (const row of rows) {
      let entry = peers.get(row.peer_id);
      if (!entry) {
        let url: string | undefined;
        try { url = (this.db.prepare("SELECT url FROM cluster_v2_peer_endpoints WHERE node_id=? LIMIT 1").get(row.peer_id) as { url: string } | undefined)?.url; } catch { url = undefined; }
        entry = { deviceIds: new Set(), url };
        peers.set(row.peer_id, entry);
      }
      entry.deviceIds.add(row.device_id);
    }
    return peers;
  }

  /** Whether a peer may open a tunnel here: it must already share files with this machine. */
  allowed(peerId: string): boolean {
    try { return Boolean(this.db.prepare("SELECT 1 FROM cluster_v2_file_enrollments WHERE peer_id=? LIMIT 1").get(peerId)); } catch { return false; }
  }

  /** Pipes a peer's tunnel into the local Syncthing listener. */
  accept(stream: RelayStream): void {
    void this.localSyncPort().then((port) => {
      const local = net.connect({ host: "127.0.0.1", port });
      local.on("error", () => stream.destroy());
      stream.on("error", () => local.destroy());
      stream.pipe(local);
      local.pipe(stream);
    }, () => stream.destroy());
  }

  /** Re-plans tunnels after presence or sharing changed. Calls made while planning coalesce. */
  update(): Promise<void> {
    if (this.planning) { this.replan = true; return this.planning; }
    this.planning = (async () => {
      do {
        this.replan = false;
        try { await this.plan(); } catch (error) { console.warn("Relay Syncthing tunnel planning failed", error); }
      } while (this.replan);
    })().finally(() => { this.planning = undefined; });
    return this.planning;
  }

  private async plan(): Promise<void> {
    const peers = this.enrolledPeers();
    for (const peerId of peers.keys()) this.runtime.ensureWatched(peerId);
    for (const [peerId, tunnel] of this.tunnels) {
      const peer = peers.get(peerId);
      if (peer && peerUsesRelay(peerId, peer.url)) continue;
      this.tunnels.delete(peerId);
      tunnel.server.close();
    }
    const wanted = new Map<string, string>();
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
    // Only the address a tunnel added is ever removed; addresses users or tests configured stay.
    // Recorded addresses survive restarts, so a stale tunnel port from an earlier run is cleaned up too.
    const recorded = tunnelAddresses(this.db);
    for (const [deviceId, address] of recorded) {
      if (wanted.get(deviceId) === address) continue;
      const done = await updateSyncthingDeviceAddresses(deviceId, (current) => current.filter((item) => item !== address)).catch(() => false);
      if (done) recordTunnelAddress(this.db, deviceId, null);
    }
    for (const [deviceId, address] of wanted) {
      if (recorded.get(deviceId) === address) continue;
      // The tunnel goes first; Syncthing also ranks it above its public relays (LAN-like address).
      const done = await updateSyncthingDeviceAddresses(deviceId, (current) => [address, ...current.filter((item) => item !== address)]).catch(() => false);
      if (done) recordTunnelAddress(this.db, deviceId, address);
    }
  }

  private listen(peerId: string): Promise<Tunnel> {
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
        if (!address || typeof address === "string") { server.close(); reject(new Error("Tunnel has no port")); return; }
        resolve({ peerId, deviceIds: [], server, port: address.port });
      });
    });
  }

  close(): void {
    for (const tunnel of this.tunnels.values()) tunnel.server.close();
    this.tunnels.clear();
  }
}
