import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { syncBuiltinESMExports } from "node:module";

delete process.env.TYPESAFE_AI_API_KEY;

function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || isIP(host) === 4 && host.startsWith("127.");
}

function requestUrl(input, protocol = "https:") {
  if (typeof input === "string" || input instanceof URL) return new URL(input);
  if (input && typeof input.url === "string") return new URL(input.url);
  if (!input || typeof input !== "object") return undefined;
  const host = input.hostname ?? input.host;
  if (!host) return undefined;
  return new URL(`${input.protocol ?? protocol}//${host}${input.path ?? "/"}`);
}

function blocked(url) {
  if (!url || isLoopback(url.hostname)) return false;
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname.replace(/\/+$/, "").toLowerCase();
  if (host === "typesafe.ai" || host.endsWith(".typesafe.ai") || pathname.endsWith("/v1/systemone")) return true;
  const configured = process.env.JOINT_BOB_TYPESAFE_ENDPOINT;
  if (configured) {
    try {
      const endpoint = new URL(configured);
      if (!isLoopback(endpoint.hostname) && endpoint.origin === url.origin) return true;
    } catch { /* Invalid test configuration is handled by the application. */ }
  }
  return false;
}

function refuse(url) {
  if (!blocked(url)) return;
  process.exitCode = 86;
  process.stderr.write("Blocked an outbound decision-service request in the test harness.\n");
  throw new Error("Outbound decision-service requests are disabled in tests");
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  try { refuse(requestUrl(input)); } catch (error) { return Promise.reject(error); }
  return originalFetch(input, ...args);
};

for (const [client, protocol] of [[http, "http:"], [https, "https:"]]) {
  for (const method of ["request", "get"]) {
    const original = client[method];
    client[method] = function (...args) {
      const options = args.find((argument, index) => index > 0 && argument && typeof argument === "object" && !(argument instanceof URL));
      const url = requestUrl(args[0], protocol);
      if (url && options) {
        if (options.protocol) url.protocol = options.protocol;
        if (options.hostname) url.hostname = options.hostname;
        if (options.host) url.host = options.host;
        if (options.path) { const path = new URL(options.path, url); url.pathname = path.pathname; url.search = path.search; }
      }
      refuse(url);
      return original.apply(this, args);
    };
  }
}
syncBuiltinESMExports();
