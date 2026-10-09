// A dependency-free signal from cluster, twin and file-sharing code to the relay runtime:
// the set of peers or shared files changed, so relays should report new peers and
// Syncthing tunnels should be re-planned. Listeners debounce; emitters never wait.
import { EventEmitter } from "node:events";

const events = new EventEmitter();

export function notifyRelayPeersChanged(): void { events.emit("peers-changed"); }

export function onRelayPeersChanged(listener: () => void): () => void {
  events.on("peers-changed", listener);
  return () => events.off("peers-changed", listener);
}
