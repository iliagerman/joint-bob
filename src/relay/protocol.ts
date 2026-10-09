// Wire format between a machine and a relay (RELAY-PLAN.md §4.1–4.2).
//
// One WebSocket per machine and relay carries binary frames. The first byte is the
// frame type: control messages are JSON, the other three move one channel's bytes.
// Channel payloads between machines are Noise ciphertext, so a relay routes them by
// channel ID and counts them, but never reads them.
import { createHash } from "node:crypto";

export const FRAME_CONTROL = 0;
export const FRAME_DATA = 1;
export const FRAME_WINDOW = 2;
export const FRAME_CLOSE = 3;

/** Bytes a sender may have in flight on one channel before the receiver grants more. */
export const INITIAL_WINDOW = 256 * 1024;
/** A receiver returns credit once it has consumed this much. */
export const WINDOW_GRANT_THRESHOLD = 64 * 1024;
/** Upper bound on credit a receiver may grant; more is a protocol violation. */
export const MAX_WINDOW = 16 * 1024 * 1024;
/** Largest plaintext chunk sealed into one DATA frame. */
export const MAX_CHUNK = 16 * 1024;
/** Largest frame a relay or machine accepts. */
export const MAX_FRAME = 64 * 1024 + 64;

export const CONNECT_PATH = "/api/relay/v1/connect";
export const VIRTUAL_RELAY_SUFFIX = ".relay.invalid";

export type ChannelKind = "peer" | "syncthing" | "gateway";

/** Why a relay refused a machine. Only "unavailable" is worth retrying on its own. */
export type DeniedCode = "not-admitted" | "revoked" | "suspended" | "declined" | "invalid-token" | "full" | "requests-off" | "rate-limited" | "key-mismatch" | "owner-only" | "unavailable";

/** What a relay tells a machine about a peer it already knows: its name there, and whether phones can open it. */
export interface PeerListing { name: string; phone: boolean }

export type ControlMessage =
  | { t: "hello"; relayNodeId: string; relayPublicKey: string; nonce: string; protocol: 1 }
  | { t: "auth"; nodeId: string; publicKey: string; name: string; nonce: string; signature: string; token?: string; request?: boolean; requestNonce?: string; gateway: boolean }
  | { t: "welcome"; name: string; environment: string; relayOrigin: string; relayName?: string; relayPhone?: boolean; signature: string }
  | { t: "pending"; pairingCode: string; signature: string }
  | { t: "denied"; reason: string; code: DeniedCode }
  | { t: "admin"; event: "renamed" | "suspended" | "revoked"; name?: string }
  | { t: "watch"; nodeIds: string[] }
  | { t: "presence"; online: string[]; offline: string[]; listings?: Record<string, PeerListing> }
  | { t: "gateway"; enabled: boolean }
  | { t: "open"; ref: number; to: string; kind: Exclude<ChannelKind, "gateway"> }
  | { t: "opened"; ref: number; channel: number }
  | { t: "open-failed"; ref: number; error: string }
  | { t: "incoming"; channel: number; from: string; fromKey: string; kind: ChannelKind; clientIp?: string }
  | { t: "reject"; channel: number; reason: string };

export function encodeControl(message: ControlMessage): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from([FRAME_CONTROL]), json]);
}

export function encodeData(channel: number, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame[0] = FRAME_DATA;
  frame.writeUInt32BE(channel, 1);
  payload.copy(frame, 5);
  return frame;
}

export function encodeWindow(channel: number, credit: number): Buffer {
  const frame = Buffer.allocUnsafe(9);
  frame[0] = FRAME_WINDOW;
  frame.writeUInt32BE(channel, 1);
  frame.writeUInt32BE(credit, 5);
  return frame;
}

export function encodeClose(channel: number, reason = ""): Buffer {
  const text = Buffer.from(reason.slice(0, 200), "utf8");
  const frame = Buffer.allocUnsafe(5 + text.length);
  frame[0] = FRAME_CLOSE;
  frame.writeUInt32BE(channel, 1);
  text.copy(frame, 5);
  return frame;
}

export type DecodedFrame =
  | { type: typeof FRAME_CONTROL; message: ControlMessage }
  | { type: typeof FRAME_DATA; channel: number; payload: Buffer }
  | { type: typeof FRAME_WINDOW; channel: number; credit: number }
  | { type: typeof FRAME_CLOSE; channel: number; reason: string };

export class RelayProtocolError extends Error {}

export function decodeFrame(frame: Buffer): DecodedFrame {
  if (frame.length < 1 || frame.length > MAX_FRAME) throw new RelayProtocolError("Invalid frame size");
  switch (frame[0]) {
    case FRAME_CONTROL: {
      let message: unknown;
      try { message = JSON.parse(frame.subarray(1).toString("utf8")); } catch { throw new RelayProtocolError("Invalid control frame"); }
      if (!message || typeof message !== "object" || typeof (message as { t?: unknown }).t !== "string") throw new RelayProtocolError("Invalid control frame");
      return { type: FRAME_CONTROL, message: message as ControlMessage };
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

/** What a machine signs to log in: the relay's fresh nonce, its own, and the relay it means. */
export function authPayload(relayNonce: string, machineNonce: string, relayOrigin: string, nodeId: string): string {
  return JSON.stringify(["relay-auth-v1", relayNonce, machineNonce, relayOrigin, nodeId]);
}

/** What a relay signs back, so a machine knows it reached the relay it pinned. */
export function welcomePayload(relayNonce: string, machineNonce: string, nodeId: string, status: string): string {
  return JSON.stringify(["relay-welcome-v1", relayNonce, machineNonce, nodeId, status]);
}

/**
 * Six digits both sides compute on their own, from both key fingerprints, the machine's node
 * ID and a random nonce the machine chose for this request. A machine that reached a different
 * relay, or a relay that sees a different machine key, shows another code; and because the
 * nonce is secret until the request is made, nobody can grind a key to match a victim's code.
 */
export function pairingCode(machineFingerprint: string, relayFingerprint: string, nodeId: string, requestNonce: string): string {
  const digest = createHash("sha256").update(`joint-bob-relay-pairing-v2\n${machineFingerprint}\n${relayFingerprint}\n${nodeId}\n${requestNonce}`).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export const REQUEST_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A DNS label proposed from a node name: lowercase letters, digits and inner hyphens. */
export function relayNameSlug(name: string): string {
  const slug = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/g, "");
  return slug || "machine";
}

export const RELAY_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The cluster URL of a machine that is reachable only through relays. It never resolves;
    peers recognise it and route through a relay both machines are on. */
export function virtualRelayUrl(nodeId: string): string {
  return `https://${nodeId}${VIRTUAL_RELAY_SUFFIX}`;
}

const VIRTUAL_HOST = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.relay\.invalid$/;
export function virtualRelayNodeId(url: string | URL): string | undefined {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return VIRTUAL_HOST.exec(parsed.hostname)?.[1];
  } catch { return undefined; }
}

/** Relay origins follow the cluster URL rule: HTTPS, or HTTP on loopback for development. */
export function normalizeRelayOrigin(value: string): string {
  const url = new URL(value.trim());
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new RelayProtocolError("Relay origin must be an HTTPS origin");
  }
  return url.origin;
}

export function relayConnectUrl(origin: string): string {
  const url = new URL(CONNECT_PATH, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** The address a phone opens to reach a machine through a relay. */
export function phoneAddress(relayOrigin: string, name: string): string {
  const url = new URL(relayOrigin);
  return `${url.protocol}//${name}.${url.host}`;
}
