// Synthetic authenticator for isolated repository tests. Never use with real accounts.
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { SeededNode, SignedIn } from "./dev-nodes.js";

export function fixtureTotp(secret: string, offset = 0): string {
  const bits = [...secret].map(char => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const mac = createHmac("sha1", key).update(counter).digest();
  return String((mac.readUInt32BE(mac[mac.length - 1] & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export function fixtureDatabase(node: SeededNode): DatabaseSync {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  return db;
}

export async function authRequest(node: SeededNode, endpoint: string, body?: unknown, session?: SignedIn, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`${node.url}/api/auth${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json", ...(session ? { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
  return { response, body: result };
}

export function responseSession(response: Response, body: { csrfToken: string }): SignedIn {
  return { cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; "), csrfToken: body.csrfToken };
}
