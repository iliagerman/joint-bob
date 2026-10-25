// The real port adapter (src/file-sync/worker.ts) around a stand-in core, for the relay-bridge tests:
// main's relay fallback and serve routes see exactly the messages a production worker sends.
// `status` runs a transport request (its `shares` arg is [peer, target, delayMs | "never"]); `repair` reports counters.
import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import type { DirectTransport } from "../../src/file-sync/direct.js";
import type { FilesEndpoint, ServeAnswer } from "../../src/file-sync/protocol.js";
import { attachWorkerPort } from "../../src/file-sync/worker.js";

const { nodeId } = workerData as { nodeId: string };
const counters = { produced: 0, finalized: 0 };

function patternByte(offset: number): number { return offset % 251; }

async function* pattern(total: number, chunk = 64 * 1024): AsyncGenerator<Uint8Array> {
  try {
    for (let sent = 0; sent < total; sent += chunk) {
      const size = Math.min(chunk, total - sent);
      const bytes = new Uint8Array(size);
      for (let index = 0; index < size; index++) bytes[index] = patternByte(sent + index);
      counters.produced += size;
      yield bytes;
    }
  } finally {
    counters.finalized++;
  }
}

async function serve(peer: string, endpoint: FilesEndpoint, query: Record<string, string>, body: unknown, range?: string): Promise<ServeAnswer> {
  switch (endpoint) {
    case "shares": return { status: 200, headers: {}, json: { fileSync: { protocol: 1, minProtocol: 1, enabled: true }, nodeId, peer, shares: [] } };
    case "status": return { status: 200, headers: {}, json: { peer, body, query } };
    case "changed": return { status: 202, headers: {}, json: {} };
    case "index": return { status: 200, headers: { "content-type": "application/x-joint-bob-index+gzip" }, body: pattern(Number(query.bytes ?? 1_000_000)) };
    case "file": {
      const size = Number((body as { size?: number }).size ?? 0);
      return { status: 206, headers: { "content-type": "application/octet-stream", "content-length": String(size), "content-range": `bytes 0-${size - 1}/${size}`, "x-range": range ?? "" }, body: pattern(size) };
    }
    default: throw Object.assign(new Error("Project is not shared with this node"), { statusCode: 403 });
  }
}

attachWorkerPort(parentPort!, {
  nodeId,
  nonces: { consume: () => true },
  core: ({ transport }) => ({
    service: { serve },
    async call(op: string, args: unknown) {
      if (op === "repair") return { ...counters } as never;
      if (op !== "status") return {} as never;
      const [peer, target, delay] = (args as { shares: [string, string, string] }).shares;
      try {
        const response = await transport.request(peer, { method: "GET", target, purpose: "index" });
        // A reader that never reads: main must give the request up on its own.
        if (delay === "never") return { status: response.status } as never;
        const hash = createHash("sha256");
        let bytes = 0;
        let chunks = 0;
        for await (const chunk of response.body) {
          hash.update(chunk);
          bytes += chunk.byteLength;
          // A slow reader: main has to stop reading the peer's answer once the window is full.
          if (++chunks % 4 === 0 && Number(delay) > 0) await new Promise((resolve) => setTimeout(resolve, Number(delay)));
        }
        return { status: response.status, contentType: response.headers["content-type"], bytes, sha256: hash.digest("hex"), route: (transport as DirectTransport).route(peer) } as never;
      } catch (error) {
        return { error: (error as Error).message, code: (error as { code?: string }).code ?? null, route: (transport as DirectTransport).route(peer) } as never;
      }
    },
    async close() {},
  }),
});
