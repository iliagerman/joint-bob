// One relay channel as a Node stream (RELAY-PLAN.md §4.2–4.3).
//
// A machine-to-machine channel runs a Noise XX handshake first, binding each side's
// static Noise key to its Ed25519 node identity, then carries ciphertext only. A phone
// gateway channel is plain, because the relay itself is the HTTP client on that hop.
//
// The stream also offers the parts of the net.Socket surface that Node's HTTP server,
// HTTP client and the ws library use, so it can be handed to them as a connection.
import { Duplex } from "node:stream";
import { MAX_CHUNK, INITIAL_WINDOW, WINDOW_GRANT_THRESHOLD, type ChannelKind } from "./protocol.js";
import { NoiseHandshake, noiseDecrypt, noiseEncrypt, type NoiseCipherState } from "./noise.js";
import type { LocalRelayIdentity, RemoteRelayIdentity } from "./identity.js";
import { parseIdentityPayload, verifyIdentityPayload } from "./identity.js";

export interface StreamLink {
  sendData(channel: number, payload: Buffer): void;
  sendWindow(channel: number, credit: number): void;
  sendClose(channel: number, reason: string): void;
  forget(channel: number): void;
}

export interface SecureOptions {
  initiator: boolean;
  identity: LocalRelayIdentity;
  /** The node this side expects at the other end, and the key it must prove. */
  expectRemote: (remote: RemoteRelayIdentity) => void;
  prologue: Buffer;
}

export class RelayChannelError extends Error {
  readonly code = "ERELAYCHANNEL";
}

type PendingWrite = { chunk: Buffer; callback: (error?: Error | null) => void };

export class RelayStream extends Duplex {
  channel: number | undefined;
  readonly relayTransport: ChannelKind;
  /** The machine proven at the other end of a secure channel. */
  relayPeer: RemoteRelayIdentity | undefined;
  /** A phone's address, on gateway channels only. */
  remoteAddress: string | undefined;
  readonly remotePort = undefined;
  readonly remoteFamily = undefined;
  readonly localAddress = undefined;
  readonly localPort = undefined;
  /** Node's HTTP server reads this to decide whether a request arrived over TLS. */
  readonly encrypted = true;
  connecting = true;
  server: unknown;

  private link: StreamLink | undefined;
  private readonly secure: SecureOptions | undefined;
  private handshake: NoiseHandshake | undefined;
  private sendCipher: NoiseCipherState | undefined;
  private receiveCipher: NoiseCipherState | undefined;
  private ready = false;
  private credit = INITIAL_WINDOW;
  private readonly outbox: Array<{ payload: Buffer; done?: () => void }> = [];
  private readonly beforeReady: PendingWrite[] = [];
  private grant = 0;
  private readerWaiting = true;
  private remoteClosed = false;
  private closeSent = false;
  private idleMs = 0;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(kind: ChannelKind, secure: SecureOptions | undefined) {
    super({ allowHalfOpen: false, highWaterMark: INITIAL_WINDOW });
    this.relayTransport = kind;
    this.secure = secure;
  }

  /** Called once the relay has assigned the channel. */
  attach(link: StreamLink, channel: number): void {
    if (this.destroyed) { link.sendClose(channel, "Stream closed"); return; }
    this.link = link;
    this.channel = channel;
    if (!this.secure) { this.becomeReady(); return; }
    this.handshake = new NoiseHandshake({ initiator: this.secure.initiator, prologue: this.secure.prologue, staticKeyPair: this.secure.identity.staticKeyPair });
    if (this.secure.initiator) this.sendRaw(this.handshake.writeMessage());
  }

  /** Set by the opener: called when a relay cannot reach the peer, to try another relay. Returns true when it did. */
  retryOpen: ((error: Error) => boolean) | undefined;

  /** The relay could not open the channel. */
  fail(error: Error): void { this.destroy(error); }

  receiveData(payload: Buffer): void {
    if (this.destroyed || this.remoteClosed) return;
    this.touch();
    this.grant += payload.length;
    try {
      if (!this.ready) { this.advanceHandshake(payload); this.returnCredit(); return; }
      const plaintext = this.receiveCipher ? noiseDecrypt(this.receiveCipher, payload) : payload;
      if (!this.push(plaintext)) this.readerWaiting = false;
      this.returnCredit();
    } catch (error) {
      this.destroy(error instanceof Error ? error : new RelayChannelError(String(error)));
    }
  }

  receiveWindow(credit: number): void {
    this.credit += credit;
    this.pump();
  }

  receiveClose(reason: string): void {
    this.remoteClosed = true;
    this.closeSent = true;
    if (!this.ready) { this.destroy(new RelayChannelError(reason || "Relay channel closed")); return; }
    this.push(null);
    // The other side is gone and will grant no more credit. What is still queued is dropped,
    // as TCP drops data to a closed peer, so pending writes finish and the stream can close.
    for (const item of this.outbox.splice(0)) item.done?.();
    if (!this.writableEnded) this.end();
  }

  // ---- net.Socket surface used by http, https Agent and ws ----
  setTimeout(ms: number, callback?: () => void): this {
    this.idleMs = ms;
    if (callback) { if (ms === 0) this.removeListener("timeout", callback); else this.once("timeout", callback); }
    this.touch();
    return this;
  }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
  address(): Record<string, never> { return {}; }
  destroySoon(): void { this.end(); }

  override _read(): void {
    if (this.readerWaiting) return;
    this.readerWaiting = true;
    this.returnCredit();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.remoteClosed) { callback(new RelayChannelError("Relay channel closed")); return; }
    this.touch();
    if (!this.ready) { this.beforeReady.push({ chunk, callback }); return; }
    this.queuePlain(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.ready) {
      // Nothing was sent yet; wait for the channel so queued writes are not lost.
      this.once("relay-ready", () => this._final(callback));
      return;
    }
    // Closing a channel closes both directions, so the readable side ends here too.
    const finish = (): void => { this.sendCloseOnce("Stream ended"); if (!this.remoteClosed) this.push(null); callback(); };
    if (this.outbox.length) this.outbox[this.outbox.length - 1].done = chain(this.outbox[this.outbox.length - 1].done, finish);
    else finish();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.clearIdle();
    for (const pending of this.beforeReady.splice(0)) pending.callback(error ?? new RelayChannelError("Relay channel closed"));
    this.outbox.length = 0;
    if (this.channel !== undefined && this.link) {
      this.sendCloseOnce(error ? "Stream failed" : "Stream closed");
      this.link.forget(this.channel);
    }
    callback(error);
  }

  private advanceHandshake(message: Buffer): void {
    const handshake = this.handshake;
    const secure = this.secure;
    if (!handshake || !secure) throw new RelayChannelError("Unexpected data before the channel opened");
    const payload = handshake.readMessage(message);
    if (secure.initiator) {
      // Second message: the responder's identity.
      this.verifyRemote(payload, handshake);
      this.sendRaw(handshake.writeMessage(secure.identity.payload));
    } else if (!handshake.complete) {
      // First message: answer with this side's identity.
      this.sendRaw(handshake.writeMessage(secure.identity.payload));
      return;
    } else {
      this.verifyRemote(payload, handshake);
    }
    if (!handshake.complete) throw new RelayChannelError("Noise handshake did not complete");
    const { send, receive } = handshake.split();
    this.sendCipher = send;
    this.receiveCipher = receive;
    this.handshake = undefined;
    this.becomeReady();
  }

  private verifyRemote(payload: Buffer, handshake: NoiseHandshake): void {
    const remoteStatic = handshake.remoteStaticKey;
    if (!remoteStatic) throw new RelayChannelError("Peer did not send a static key");
    const remote = parseIdentityPayload(payload);
    if (!verifyIdentityPayload(remote, remoteStatic)) throw new RelayChannelError("Peer identity signature is invalid");
    this.secure!.expectRemote(remote);
    this.relayPeer = { nodeId: remote.nodeId, publicKey: remote.publicKey };
  }

  private becomeReady(): void {
    this.ready = true;
    this.connecting = false;
    for (const pending of this.beforeReady.splice(0)) this.queuePlain(pending.chunk, pending.callback);
    this.emit("relay-ready");
    this.emit("connect");
    this.emit("secureConnect");
  }

  private queuePlain(chunk: Buffer, callback: (error?: Error | null) => void): void {
    try {
      const pieces: Buffer[] = [];
      for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK) pieces.push(chunk.subarray(offset, offset + MAX_CHUNK));
      if (!pieces.length) { callback(); return; }
      pieces.forEach((piece, index) => {
        const payload = this.sendCipher ? noiseEncrypt(this.sendCipher, piece) : Buffer.from(piece);
        this.outbox.push({ payload, done: index === pieces.length - 1 ? () => callback() : undefined });
      });
      this.pump();
    } catch (error) {
      callback(error instanceof Error ? error : new RelayChannelError(String(error)));
    }
  }

  private sendRaw(payload: Buffer): void {
    this.outbox.push({ payload });
    this.pump();
  }

  private pump(): void {
    if (!this.link || this.channel === undefined) return;
    while (this.outbox.length && this.outbox[0].payload.length <= this.credit) {
      const next = this.outbox.shift()!;
      this.credit -= next.payload.length;
      this.link.sendData(this.channel, next.payload);
      next.done?.();
    }
  }

  private returnCredit(): void {
    if (!this.link || this.channel === undefined || !this.readerWaiting) return;
    if (this.grant >= WINDOW_GRANT_THRESHOLD || (!this.ready && this.grant > 0)) {
      this.link.sendWindow(this.channel, this.grant);
      this.grant = 0;
    }
  }

  private sendCloseOnce(reason: string): void {
    if (this.closeSent || !this.link || this.channel === undefined) return;
    this.closeSent = true;
    this.link.sendClose(this.channel, reason);
  }

  private touch(): void {
    this.clearIdle();
    if (this.idleMs > 0 && !this.destroyed) {
      this.idleTimer = setTimeout(() => this.emit("timeout"), this.idleMs);
      this.idleTimer.unref();
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

function chain(first: (() => void) | undefined, second: () => void): () => void {
  return () => { first?.(); second(); };
}

/** True for connections that arrived through a relay. They are never local traffic. */
export function relayTransportOf(socket: unknown): ChannelKind | undefined {
  return socket instanceof RelayStream ? socket.relayTransport : undefined;
}

export function relayPeerOf(socket: unknown): RemoteRelayIdentity | undefined {
  return socket instanceof RelayStream && socket.relayTransport !== "gateway" ? socket.relayPeer : undefined;
}
