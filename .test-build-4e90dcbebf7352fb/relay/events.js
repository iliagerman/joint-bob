import { EventEmitter } from "node:events";
const events = new EventEmitter();
function notifyRelayPeersChanged() {
  events.emit("peers-changed");
}
function onRelayPeersChanged(listener) {
  events.on("peers-changed", listener);
  return () => events.off("peers-changed", listener);
}
export {
  notifyRelayPeersChanged,
  onRelayPeersChanged
};
