import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { createBrowserProxy, browserLoopbackHost } from "../src/browser-network.js";

async function app(identity: string) {
  const server = http.createServer((request, response) => { response.setHeader("x-app", identity); response.end(identity + ":" + request.url); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { server, port: (server.address() as net.AddressInfo).port };
}
async function request(proxy: string, target: string) {
  const url = new URL(proxy);
  return new Promise<{status: number; body: string}>((resolve, reject) => {
    http.get({ hostname: url.hostname, port: url.port, path: target }, response => {
      let body = ""; response.on("data", chunk => body += chunk); response.on("end", () => resolve({ status: response.statusCode!, body }));
    }).on("error", reject);
  });
}
function connect(port: number) { return new Promise<net.Socket>((resolve, reject) => { const socket = net.connect(port, "127.0.0.1", () => resolve(socket)); socket.once("error", reject); }); }

test("browser proxies keep identical localhost URLs scoped to their own app nodes", async () => {
  const a = await app("A"), b = await app("B");
  const calls: Array<[string, number]> = [];
  const proxyA = await createBrowserProxy(async (host, port) => { calls.push([host, port]); return connect(a.port); });
  const proxyB = await createBrowserProxy(async () => connect(b.port));
  try {
    const target = "http://localhost:3000/hello?same=1";
    assert.deepEqual(await request(proxyA.server, target), { status: 200, body: "A:/hello?same=1" });
    assert.deepEqual(await request(proxyB.server, target), { status: 200, body: "B:/hello?same=1" });
    assert.deepEqual(calls, [["localhost", 3000]]);
  } finally { await proxyA.close(); await proxyB.close(); a.server.closeAllConnections(); b.server.closeAllConnections(); await Promise.all([new Promise<void>(r => a.server.close(() => r())), new Promise<void>(r => b.server.close(() => r()))]); }
});

test("browser proxy CONNECT carries arbitrary TCP bytes for HTTPS and WebSockets", async () => {
  const echo = net.createServer(socket => socket.pipe(socket)); echo.listen(0, "127.0.0.1"); await once(echo, "listening");
  const proxy = await createBrowserProxy(async (_host, port) => { assert.equal(port, 443); return connect((echo.address() as net.AddressInfo).port); });
  const socket = await connect(Number(new URL(proxy.server).port));
  try {
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    const [response] = await once(socket, "data"); assert.match(response.toString(), /^HTTP\/1.1 200/);
    socket.write("opaque TLS or WebSocket bytes");
    const [data] = await once(socket, "data"); assert.equal(data.toString(), "opaque TLS or WebSocket bytes");
  } finally { socket.destroy(); await proxy.close(); await new Promise<void>(r => echo.close(() => r())); }
});

test("browser proxy reports connection failures and rejects non-web URLs", async () => {
  const proxy = await createBrowserProxy(async () => { throw Error("App node offline"); });
  try {
    assert.equal((await request(proxy.server, "http://localhost:3000/")).status, 502);
    assert.equal((await request(proxy.server, "file:///etc/passwd")).status, 400);
    assert.equal((await request(proxy.server, "http://user:pass@localhost:3000/")).status, 400);
  } finally { await proxy.close(); }
});

test("loopback routing recognizes browser localhost aliases without matching public domains", () => {
  for (const host of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.0.0.2", "::1", "[::1]"]) assert.equal(browserLoopbackHost(host), true, host);
  for (const host of ["localhost.example.com", "example.com", "192.168.1.1", "127.0.0.1.attacker.test"]) assert.equal(browserLoopbackHost(host), false, host);
});
