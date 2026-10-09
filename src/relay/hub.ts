// The machine end of one relay link: it opens channels, receives incoming ones, and
// routes frames to their streams. A relay node uses the same class in-process for itself
// and for its phone gateway, so the relay routes every channel the same way.
import { FRAME_CLOSE, FRAME_CONTROL, FRAME_DATA, FRAME_WINDOW, decodeFrame, encodeClose, encodeControl, encodeData, encodeWindow, type ChannelKind, type ControlMessage } from "./protocol.js";
import { RelayChannelError, RelayStream, type SecureOptions, type StreamLink } from "./stream.js";

export interface IncomingChannel {
  channel: number;
  from: string;
  fromKey: string;
  kind: ChannelKind;
  clientIp?: string;
}

export interface HubOptions {
  send(frame: Buffer): void;
  /** Decide about a channel another machine opened. Return a stream to accept it, or a reason to refuse. */
  onIncoming(incoming: IncomingChannel): RelayStream | string;
  /** Control messages the hub does not handle itself. */
  onControl?(message: ControlMessage): void;
}

const MAX_PENDING_OPENS = 256;

export class ChannelHub implements StreamLink {
  private readonly streams = new Map<number, RelayStream>();
  private readonly opening = new Map<number, RelayStream>();
  private nextRef = 1;
  private closed = false;

  constructor(private readonly options: HubOptions) {}

  get openChannels(): number { return this.streams.size + this.opening.size; }

  /** Opens a channel to another machine. The stream buffers writes until it is ready. */
  open(to: string, kind: Exclude<ChannelKind, "gateway">, secure: SecureOptions): RelayStream {
    return this.openWith(new RelayStream(kind, secure), to, kind);
  }

  /** Opens a channel for a stream created earlier, while its opener waited for a route. */
  openWith(stream: RelayStream, to: string, kind: Exclude<ChannelKind, "gateway">): RelayStream {
    if (this.closed) { process.nextTick(() => stream.fail(new RelayChannelError("Relay connection is closed"))); return stream; }
    if (this.opening.size >= MAX_PENDING_OPENS) { process.nextTick(() => stream.fail(new RelayChannelError("Too many channels are opening"))); return stream; }
    const ref = this.nextRef++;
    this.opening.set(ref, stream);
    stream.once("close", () => { this.opening.delete(ref); });
    this.options.send(encodeControl({ t: "open", ref, to, kind }));
    return stream;
  }

  /** Registers a stream on a channel the relay already paired (the relay's own gateway end). */
  adopt(stream: RelayStream, channel: number): void {
    this.streams.set(channel, stream);
    stream.attach(this, channel);
  }

  handleFrame(frame: Buffer): void {
    const decoded = decodeFrame(frame);
    switch (decoded.type) {
      case FRAME_CONTROL: this.handleControl(decoded.message); return;
      case FRAME_DATA: this.streams.get(decoded.channel)?.receiveData(decoded.payload); return;
      case FRAME_WINDOW: this.streams.get(decoded.channel)?.receiveWindow(decoded.credit); return;
      case FRAME_CLOSE: {
        const stream = this.streams.get(decoded.channel);
        this.streams.delete(decoded.channel);
        stream?.receiveClose(decoded.reason);
        return;
      }
    }
  }

  /** The link to the relay is gone: every channel on it ends. */
  closeAll(reason: string): void {
    this.closed = true;
    const error = new RelayChannelError(reason);
    for (const stream of [...this.opening.values(), ...this.streams.values()]) stream.destroy(error);
    this.opening.clear();
    this.streams.clear();
  }

  sendControl(message: ControlMessage): void { if (!this.closed) this.options.send(encodeControl(message)); }
  sendData(channel: number, payload: Buffer): void { this.options.send(encodeData(channel, payload)); }
  sendWindow(channel: number, credit: number): void { this.options.send(encodeWindow(channel, credit)); }
  sendClose(channel: number, reason: string): void { if (!this.closed) this.options.send(encodeClose(channel, reason)); }
  forget(channel: number): void { this.streams.delete(channel); }

  private handleControl(message: ControlMessage): void {
    switch (message.t) {
      case "opened": {
        const stream = this.opening.get(message.ref);
        this.opening.delete(message.ref);
        if (!stream || stream.destroyed) { this.sendClose(message.channel, "Opener went away"); return; }
        this.streams.set(message.channel, stream);
        stream.attach(this, message.channel);
        return;
      }
      case "open-failed": {
        const stream = this.opening.get(message.ref);
        this.opening.delete(message.ref);
        const error = new RelayChannelError(typeof message.error === "string" ? message.error : "The relay could not reach that machine");
        if (stream && !stream.destroyed && !stream.retryOpen?.(error)) stream.fail(error);
        return;
      }
      case "incoming": {
        let decision: RelayStream | string;
        try { decision = this.options.onIncoming(message); } catch (error) { decision = error instanceof Error ? error.message : "Refused"; }
        if (typeof decision === "string") { this.options.send(encodeControl({ t: "reject", channel: message.channel, reason: decision })); return; }
        this.streams.set(message.channel, decision);
        decision.attach(this, message.channel);
        return;
      }
      default:
        this.options.onControl?.(message);
    }
  }
}
