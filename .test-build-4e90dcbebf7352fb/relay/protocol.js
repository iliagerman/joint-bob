import { createHash } from "node:crypto";
const FRAME_CONTROL = 0;
const FRAME_DATA = 1;
const FRAME_WINDOW = 2;
const FRAME_CLOSE = 3;
const INITIAL_WINDOW = 256 * 1024;
const WINDOW_GRANT_THRESHOLD = 64 * 1024;
const MAX_WINDOW = 16 * 1024 * 1024;
const MAX_CHUNK = 16 * 1024;
const MAX_FRAME = 64 * 1024 + 64;
const CONNECT_PATH = "/api/relay/v1/connect";
const VIRTUAL_RELAY_SUFFIX = ".relay.invalid";
function encodeControl(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from([FRAME_CONTROL]), json]);
}
function encodeData(channel, payload) {
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame[0] = FRAME_DATA;
  frame.writeUInt32BE(channel, 1);
  payload.copy(frame, 5);
  return frame;
}
function encodeWindow(channel, credit) {
  const frame = Buffer.allocUnsafe(9);
  frame[0] = FRAME_WINDOW;
  frame.writeUInt32BE(channel, 1);
  frame.writeUInt32BE(credit, 5);
  return frame;
}
function encodeClose(channel, reason = "") {
  const text = Buffer.from(reason.slice(0, 200), "utf8");
  const frame = Buffer.allocUnsafe(5 + text.length);
  frame[0] = FRAME_CLOSE;
  frame.writeUInt32BE(channel, 1);
  text.copy(frame, 5);
  return frame;
}
class RelayProtocolError extends Error {
}
function decodeFrame(frame) {
  if (frame.length < 1 || frame.length > MAX_FRAME) throw new RelayProtocolError("Invalid frame size");
  switch (frame[0]) {
    case FRAME_CONTROL: {
      let message;
      try {
        message = JSON.parse(frame.subarray(1).toString("utf8"));
      } catch {
        throw new RelayProtocolError("Invalid control frame");
      }
      if (!message || typeof message !== "object" || typeof message.t !== "string") throw new RelayProtocolError("Invalid control frame");
      return { type: FRAME_CONTROL, message };
    }
    case FRAME_DATA:
      if (frame.length < 5) throw new RelayProtocolError("Invalid data frame");
      return { type: FRAME_DATA, channel: frame.readUInt32BE(1), payload: frame.subarray(5) };
    case FRAME_WINDOW:
      if (frame.length !== 9) throw new RelayProtocolError("Invalid window frame");
      return { type: FRAME_WINDOW, channel: frame.readUInt32BE(1), credit: frame.readUInt32BE(5) };
    case FRAME_CLOSE:
      if (frame.length < 5) throw new RelayProtocolError("Invalid close frame");
      return { type: FRAME_CLOSE, channel: frame.readUInt32BE(1), reason: frame.subarray(5).toString("utf8") };
    default:
      throw new RelayProtocolError("Unknown frame type");
  }
}
function authPayload(relayNonce, machineNonce, relayOrigin, nodeId) {
  return JSON.stringify(["relay-auth-v1", relayNonce, machineNonce, relayOrigin, nodeId]);
}
function welcomePayload(relayNonce, machineNonce, nodeId, status) {
  return JSON.stringify(["relay-welcome-v1", relayNonce, machineNonce, nodeId, status]);
}
function pairingCode(machineFingerprint, relayFingerprint, nodeId, requestNonce) {
  const digest = createHash("sha256").update(`joint-bob-relay-pairing-v2
${machineFingerprint}
${relayFingerprint}
${nodeId}
${requestNonce}`).digest();
  return String(digest.readUInt32BE(0) % 1e6).padStart(6, "0");
}
const REQUEST_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
function relayNameSlug(name) {
  const slug = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/g, "");
  return slug || "machine";
}
const RELAY_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function virtualRelayUrl(nodeId) {
  return `https://${nodeId}${VIRTUAL_RELAY_SUFFIX}`;
}
const VIRTUAL_HOST = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.relay\.invalid$/;
function virtualRelayNodeId(url) {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return VIRTUAL_HOST.exec(parsed.hostname)?.[1];
  } catch {
    return void 0;
  }
}
function normalizeRelayOrigin(value) {
  const url = new URL(value.trim());
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback || url.username || url.password || url.pathname !== "/" && url.pathname !== "" || url.search || url.hash) {
    throw new RelayProtocolError("Relay origin must be an HTTPS origin");
  }
  return url.origin;
}
function relayConnectUrl(origin) {
  const url = new URL(CONNECT_PATH, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
function phoneAddress(relayOrigin, name) {
  const url = new URL(relayOrigin);
  return `${url.protocol}//${name}.${url.host}`;
}
export {
  CONNECT_PATH,
  FRAME_CLOSE,
  FRAME_CONTROL,
  FRAME_DATA,
  FRAME_WINDOW,
  INITIAL_WINDOW,
  MAX_CHUNK,
  MAX_FRAME,
  MAX_WINDOW,
  RELAY_NAME_PATTERN,
  REQUEST_NONCE_PATTERN,
  RelayProtocolError,
  VIRTUAL_RELAY_SUFFIX,
  WINDOW_GRANT_THRESHOLD,
  authPayload,
  decodeFrame,
  encodeClose,
  encodeControl,
  encodeData,
  encodeWindow,
  normalizeRelayOrigin,
  pairingCode,
  phoneAddress,
  relayConnectUrl,
  relayNameSlug,
  virtualRelayNodeId,
  virtualRelayUrl,
  welcomePayload
};
