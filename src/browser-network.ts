import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

export function browserLoopbackHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return value === "localhost" || value.endsWith(".localhost") || value === "::1" || (net.isIP(value) === 4 && value.startsWith("127."));
}

export function browserTcpConnect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error("Browser target connection timed out")), 10000);
    socket.once("error", reject);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("close", () => clearTimeout(timer));
  });
}

/** Per-context forward proxy. Only loopback traffic is tunneled to the app node by
 * the supplied connector. Public HTTPS stays encrypted end to end through CONNECT. */
export async function createBrowserProxy(connect: (host: string, port: number) => Promise<Duplex>): Promise<{server: string; close: () => Promise<void>}> {
  const connections = new Set<Duplex>();
  const track = (socket: Duplex) => { connections.add(socket); socket.once("close", () => connections.delete(socket)); return socket; };
  const target = (url: URL) => {
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid browser proxy URL");
    const port = Number(url.port || (["https:", "wss:"].includes(url.protocol) ? 443 : 80));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid browser target port");
    return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
  };
  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    connect(String(options.host), Number(options.port)).then(socket => callback?.(null, track(socket)), error => callback?.(error, undefined as never));
    return undefined as never;
  };
  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url || "");
      const { host, port } = target(url);
      if (url.protocol !== "http:") throw new Error("Use CONNECT for encrypted requests");
      const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host };
      delete headers["proxy-authorization"]; delete headers["proxy-connection"];
      const upstream = http.request({ hostname: host, port, method: request.method, path: url.pathname + url.search, headers, agent }, result => {
        response.writeHead(result.statusCode || 502, result.headers); result.pipe(response);
      });
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end("Browser target is unavailable"); });
      request.on("aborted", () => upstream.destroy());
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    } catch { response.writeHead(400); response.end("Invalid browser proxy request"); }
  });
  server.on("connection", track);
  server.on("connect", (request, client, head) => {
    let destination: { host: string; port: number };
    try { destination = target(new URL(`https://${request.url}`)); }
    catch { client.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    void connect(destination.host, destination.port).then(upstream => {
      track(upstream);
      if (client.destroyed) { upstream.destroy(); return; }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
      client.pipe(upstream); upstream.pipe(client);
    }, () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  });
  server.on("upgrade", (request, client, head) => {
    try {
      const url = new URL(request.url || ""); const { host, port } = target(url);
      void connect(host, port).then(upstream => {
        track(upstream);
        if (client.destroyed) { upstream.destroy(); return; }
        const headers = Object.entries(request.headers).filter(([key]) => !key.startsWith("proxy-")).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("\r\n");
        upstream.write(`${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers}\r\n\r\n`);
        if (head.length) upstream.write(head);
        client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
        client.pipe(upstream); upstream.pipe(client);
      }, () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    } catch { client.end("HTTP/1.1 400 Bad Request\r\n\r\n"); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    server: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    close: async () => { agent.destroy(); for (const connection of connections) connection.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
