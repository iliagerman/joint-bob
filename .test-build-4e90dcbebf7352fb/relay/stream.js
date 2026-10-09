import { Duplex } from "node:stream";
import { MAX_CHUNK, INITIAL_WINDOW, WINDOW_GRANT_THRESHOLD } from "./protocol.js";
import { NoiseHandshake, noiseDecrypt, noiseEncrypt } from "./noise.js";
import { parseIdentityPayload, verifyIdentityPayload } from "./identity.js";
class RelayChannelError extends Error {
  code = "ERELAYCHANNEL";
}
class RelayStream extends Duplex {
  channel;
  relayTransport;
  /** The machine proven at the other end of a secure channel. */
  relayPeer;
  /** A phone's address, on gateway channels only. */
  remoteAddress;
  remotePort = void 0;
  remoteFamily = void 0;
  localAddress = void 0;
  localPort = void 0;
  /** Node's HTTP server reads this to decide whether a request arrived over TLS. */
  encrypted = true;
  connecting = true;
  server;
  link;
  secure;
  handshake;
  sendCipher;
  receiveCipher;
  ready = false;
  credit = INITIAL_WINDOW;
  outbox = [];
  beforeReady = [];
  grant = 0;
  readerWaiting = true;
  remoteClosed = false;
  closeSent = false;
  idleMs = 0;
  idleTimer;
  constructor(kind, secure) {
    super({ allowHalfOpen: false, highWaterMark: INITIAL_WINDOW });
    this.relayTransport = kind;
    this.secure = secure;
  }
  /** Called once the relay has assigned the channel. */
  attach(link, channel) {
    if (this.destroyed) {
      link.sendClose(channel, "Stream closed");
      return;
    }
    this.link = link;
    this.channel = channel;
    if (!this.secure) {
      this.becomeReady();
      return;
    }
    this.handshake = new NoiseHandshake({ initiator: this.secure.initiator, prologue: this.secure.prologue, staticKeyPair: this.secure.identity.staticKeyPair });
    if (this.secure.initiator) this.sendRaw(this.handshake.writeMessage());
  }
  /** Set by the opener: called when a relay cannot reach the peer, to try another relay. Returns true when it did. */
  retryOpen;
  /** The relay could not open the channel. */
  fail(error) {
    this.destroy(error);
  }
  receiveData(payload) {
    if (this.destroyed || this.remoteClosed) return;
    this.touch();
    this.grant += payload.length;
    try {
      if (!this.ready) {
        this.advanceHandshake(payload);
        this.returnCredit();
        return;
      }
      const plaintext = this.receiveCipher ? noiseDecrypt(this.receiveCipher, payload) : payload;
      if (!this.push(plaintext)) this.readerWaiting = false;
      this.returnCredit();
    } catch (error) {
      this.destroy(error instanceof Error ? error : new RelayChannelError(String(error)));
    }
  }
  receiveWindow(credit) {
    this.credit += credit;
    this.pump();
  }
  receiveClose(reason) {
    this.remoteClosed = true;
    this.closeSent = true;
    if (!this.ready) {
      this.destroy(new RelayChannelError(reason || "Relay channel closed"));
      return;
    }
    this.push(null);
    for (const item of this.outbox.splice(0)) item.done?.();
    if (!this.writableEnded) this.end();
  }
  // ---- net.Socket surface used by http, https Agent and ws ----
  setTimeout(ms, callback) {
    this.idleMs = ms;
    if (callback) {
      if (ms === 0) this.removeListener("timeout", callback);
      else this.once("timeout", callback);
    }
    this.touch();
    return this;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  address() {
    return {};
  }
  destroySoon() {
    this.end();
  }
  _read() {
    if (this.readerWaiting) return;
    this.readerWaiting = true;
    this.returnCredit();
  }
  _write(chunk, _encoding, callback) {
    if (this.remoteClosed) {
      callback(new RelayChannelError("Relay channel closed"));
      return;
    }
    this.touch();
    if (!this.ready) {
      this.beforeReady.push({ chunk, callback });
      return;
    }
    this.queuePlain(chunk, callback);
  }
  _final(callback) {
    if (!this.ready) {
      this.once("relay-ready", () => this._final(callback));
      return;
    }
    const finish = () => {
      this.sendCloseOnce("Stream ended");
      if (!this.remoteClosed) this.push(null);
      callback();
    };
    if (this.outbox.length) this.outbox[this.outbox.length - 1].done = chain(this.outbox[this.outbox.length - 1].done, finish);
    else finish();
  }
  _destroy(error, callback) {
    this.clearIdle();
    for (const pending of this.beforeReady.splice(0)) pending.callback(error ?? new RelayChannelError("Relay channel closed"));
    this.outbox.length = 0;
    if (this.channel !== void 0 && this.link) {
      this.sendCloseOnce(error ? "Stream failed" : "Stream closed");
      this.link.forget(this.channel);
    }
    callback(error);
  }
  advanceHandshake(message) {
    const handshake = this.handshake;
    const secure = this.secure;
    if (!handshake || !secure) throw new RelayChannelError("Unexpected data before the channel opened");
    const payload = handshake.readMessage(message);
    if (secure.initiator) {
      this.verifyRemote(payload, handshake);
      this.sendRaw(handshake.writeMessage(secure.identity.payload));
    } else if (!handshake.complete) {
      this.sendRaw(handshake.writeMessage(secure.identity.payload));
      return;
    } else {
      this.verifyRemote(payload, handshake);
    }
    if (!handshake.complete) throw new RelayChannelError("Noise handshake did not complete");
    const { send, receive } = handshake.split();
    this.sendCipher = send;
    this.receiveCipher = receive;
    this.handshake = void 0;
    this.becomeReady();
  }
  verifyRemote(payload, handshake) {
    const remoteStatic = handshake.remoteStaticKey;
    if (!remoteStatic) throw new RelayChannelError("Peer did not send a static key");
    const remote = parseIdentityPayload(payload);
    if (!verifyIdentityPayload(remote, remoteStatic)) throw new RelayChannelError("Peer identity signature is invalid");
    this.secure.expectRemote(remote);
    this.relayPeer = { nodeId: remote.nodeId, publicKey: remote.publicKey };
  }
  becomeReady() {
    this.ready = true;
    this.connecting = false;
    for (const pending of this.beforeReady.splice(0)) this.queuePlain(pending.chunk, pending.callback);
    this.emit("relay-ready");
    this.emit("connect");
    this.emit("secureConnect");
  }
  queuePlain(chunk, callback) {
    try {
      const pieces = [];
      for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK) pieces.push(chunk.subarray(offset, offset + MAX_CHUNK));
      if (!pieces.length) {
        callback();
        return;
      }
      pieces.forEach((piece, index) => {
        const payload = this.sendCipher ? noiseEncrypt(this.sendCipher, piece) : Buffer.from(piece);
        this.outbox.push({ payload, done: index === pieces.length - 1 ? () => callback() : void 0 });
      });
      this.pump();
    } catch (error) {
      callback(error instanceof Error ? error : new RelayChannelError(String(error)));
    }
  }
  sendRaw(payload) {
    this.outbox.push({ payload });
    this.pump();
  }
  pump() {
    if (!this.link || this.channel === void 0) return;
    while (this.outbox.length && this.outbox[0].payload.length <= this.credit) {
      const next = this.outbox.shift();
      this.credit -= next.payload.length;
      this.link.sendData(this.channel, next.payload);
      next.done?.();
    }
  }
  returnCredit() {
    if (!this.link || this.channel === void 0 || !this.readerWaiting) return;
    if (this.grant >= WINDOW_GRANT_THRESHOLD || !this.ready && this.grant > 0) {
      this.link.sendWindow(this.channel, this.grant);
      this.grant = 0;
    }
  }
  sendCloseOnce(reason) {
    if (this.closeSent || !this.link || this.channel === void 0) return;
    this.closeSent = true;
    this.link.sendClose(this.channel, reason);
  }
  touch() {
    this.clearIdle();
    if (this.idleMs > 0 && !this.destroyed) {
      this.idleTimer = setTimeout(() => this.emit("timeout"), this.idleMs);
      this.idleTimer.unref();
    }
  }
  clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = void 0;
  }
}
function chain(first, second) {
  return () => {
    first?.();
    second();
  };
}
function relayTransportOf(socket) {
  return socket instanceof RelayStream ? socket.relayTransport : void 0;
}
function relayPeerOf(socket) {
  return socket instanceof RelayStream && socket.relayTransport !== "gateway" ? socket.relayPeer : void 0;
}
export {
  RelayChannelError,
  RelayStream,
  relayPeerOf,
  relayTransportOf
};
