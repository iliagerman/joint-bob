#!/usr/bin/env node
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

const token = process.env.JOINT_BOB_BROWSER_TOKEN;
const endpoint = process.env.JOINT_BOB_BROWSER_URL;
const usage = "Usage: start [url] [--profile ID | --name LABEL] [--node UUID] | status | tabs | profiles | snapshot | screenshot PATH | click SELECTOR | fill SELECTOR TEXT | fill-secret SELECTOR ENV_NAME --origin URL | upload SELECTOR FILE... | download ID PATH | navigate URL | evaluate EXPRESSION | command JSON | close | save-login LABEL. Account commands accept --profile ID; required when multiple profiles run. Use -- before positional values beginning with --.";
const uploadLimit = 20 * 1024 * 1024;
let sensitiveValue;

function redact(text) {
  for (const value of [token, sensitiveValue]) {
    if (!value) continue;
    for (const variant of [value, JSON.stringify(value).slice(1, -1)]) text = text.split(variant).join("[redacted]");
  }
  return text;
}

function print(value) {
  const json = redact(JSON.stringify(value));
  console.log(json.length <= 32000 ? json : JSON.stringify({ truncated: true, preview: json.slice(0, 12000) }));
}

async function responseText(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 40 * 1024 * 1024) throw new Error("Browser response exceeds 40 MiB; narrow the query");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function request(body, raw = false, sensitive = false) {
  if (!token || !endpoint) throw new Error("Browser environment missing; run inside a Joint Bob conversation");
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(120000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Browser bridge unreachable or timed out; check the local Joint Bob service on the agent's execution machine.");
  }
  if (!response.ok) {
    if (sensitive) {
      await response.body?.cancel();
      throw new Error(`Secret fill failed (HTTP ${response.status}); check browser status. Server details withheld.`);
    }
    const text = await responseText(response);
    let message;
    try { message = JSON.parse(text).error; } catch { /* Do not echo non-JSON server bodies. */ }
    throw new Error(`Browser request failed (HTTP ${response.status}): ${typeof message === "string" ? message : "invalid server response"}`);
  }
  if (raw) return response;
  if (sensitive) { await response.body?.cancel(); return { ok: true }; }
  try { return JSON.parse(await responseText(response)); }
  catch { throw new Error("Invalid or oversized JSON response from browser bridge"); }
}

function currentSession(status, profileId) {
  if (!profileId && status.unavailableNodes?.length) throw new Error("Browser attachment discovery incomplete. Specify --profile ID for a known account or reconnect the missing machine.");
  const running = status.sessions?.filter((session) => session.state === "running" && (!profileId || session.profileId === profileId));
  if (!running?.length) throw new Error("No running browser for this profile; use start first");
  if (running.length !== 1) throw new Error("Multiple browser profiles are running. Specify --profile ID.");
  return running[0];
}

async function uploadFiles(inputs) {
  const files = [];
  const names = new Set();
  let total = 0;
  async function add(input, name) {
    const info = await lstat(input);
    if (info.isDirectory()) {
      for (const entry of (await readdir(input)).sort()) await add(path.join(input, entry), `${name}/${entry}`);
      return;
    }
    if (!info.isFile()) throw new Error("Upload accepts regular files and directories, not symlinks or devices");
    if (name.length > 255 || name.includes("\\") || name.includes(":")) throw new Error("Invalid upload file name");
    if (names.has(name)) throw new Error("Duplicate upload file name");
    if (files.length >= 25) throw new Error("Upload accepts at most 25 files");
    if (total + info.size > uploadLimit) throw new Error("Upload exceeds 20 MiB total");
    const chunks = [];
    for await (const chunk of createReadStream(input)) {
      total += chunk.length;
      if (total > uploadLimit) throw new Error("Upload exceeds 20 MiB total");
      chunks.push(chunk);
    }
    names.add(name);
    files.push({ name, data: Buffer.concat(chunks).toString("base64") });
  }
  for (const input of inputs) await add(input, path.basename(path.resolve(input)));
  if (!files.length) throw new Error("Upload requires at least one file");
  return files;
}

async function save(output, source) {
  const destination = path.resolve(output);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.part`;
  try {
    if (Buffer.isBuffer(source)) await writeFile(temporary, source, { mode: 0o600, flag: "wx" });
    else await pipeline(Readable.fromWeb(source), createWriteStream(temporary, { mode: 0o600, flags: "wx" }));
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  print({ path: destination });
}

async function main() {
  const [verb, ...input] = process.argv.slice(2);
  const { positionals: args, values } = parseArgs({ args: input, allowPositionals: true, options: {
    profile: { type: "string" }, ...(verb === "start" ? { name: { type: "string" }, node: { type: "string" } } : {}),
    ...(verb === "fill-secret" ? { origin: { type: "string" } } : {}),
  } });
  const profileId = values.profile;
  if (profileId !== undefined && (!profileId || ["status", "profiles"].includes(verb))) throw new Error(usage);
  const target = profileId === undefined ? {} : { profileId };
  const arity = (n) => { if (args.length !== n) throw new Error(usage); };
  const command = (value) => request({ operation: "command", command: value, ...target });
  let result;
  switch (verb) {
    case "start": {
      const profileName = values.name?.trim();
      const nodeId = values.node;
      if (nodeId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nodeId)) throw new Error("--node requires a machine UUID from browser status");
      if (args.length > 1 || (values.name !== undefined && (!profileName || profileName.length > 80 || profileId))) throw new Error(usage);
      result = await request({ operation: "start", ...(args[0] ? { url: args[0] } : {}), ...target, ...(profileName ? { profileName } : {}), ...(nodeId ? { nodeId } : {}) });
      break;
    }
    case "status": case "profiles":
      arity(0); result = await request({ operation: verb }); break;
    case "tabs": {
      arity(0);
      const session = currentSession(await request({ operation: "status" }), profileId);
      result = { tabs: session.tabs, activePageId: session.activePageId }; break;
    }
    case "snapshot": case "close":
      arity(0); result = await command({ action: verb }); break;
    case "navigate": case "evaluate": case "click": case "save-login": {
      arity(1);
      const [action, key] = { navigate: ["navigate", "url"], evaluate: ["evaluate", "expression"], click: ["clickElement", "selector"], "save-login": ["saveProfile", "label"] }[verb];
      result = await command({ action, [key]: args[0] }); break;
    }
    case "fill":
      arity(2); result = await command({ action: "fill", selector: args[0], text: args[1] }); break;
    case "fill-secret": {
      arity(2);
      if (!values.origin) throw new Error(usage);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(args[1]) || args[1].startsWith("JOINT_BOB_BROWSER_")) throw new Error("Use an attached credential environment variable name");
      sensitiveValue = process.env[args[1]];
      if (sensitiveValue === undefined) throw new Error("Attached credential environment variable is not set");
      let expected;
      try { expected = new URL(values.origin); } catch { throw new Error("--origin requires an absolute HTTP(S) URL"); }
      if (!["http:", "https:"].includes(expected.protocol) || expected.username || expected.password) throw new Error("--origin requires an HTTP(S) origin without credentials");
      const session = currentSession(await request({ operation: "status" }), profileId);
      if (session.owner !== "agent") throw new Error("Manual takeover pauses agent commands; wait for the user to resume");
      const page = session.tabs?.find((tab) => tab.id === session.activePageId);
      let origin;
      try { origin = new URL(page?.url).origin; } catch { /* Missing or opaque page cannot receive credentials. */ }
      if (origin !== expected.origin) throw new Error("Secret fill refused: current active page origin does not match --origin");
      result = await request({ operation: "command", profileId: session.profileId, command: {
        action: "fill", selector: args[0], text: sensitiveValue, expectedOrigin: expected.origin, expectedPageId: session.activePageId,
      } }, false, true); break;
    }
    case "upload":
      if (args.length < 2) throw new Error(usage);
      result = await command({ action: "upload", selector: args[0], files: await uploadFiles(args.slice(1)) }); break;
    case "download": {
      arity(2);
      const response = await request({ operation: "download", downloadId: args[0], ...target }, true);
      await save(args[1], response.body); return;
    }
    case "screenshot": {
      arity(1);
      const response = await command({ action: "screenshot" });
      const data = response.result?.data;
      if (typeof data !== "string" || !data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Invalid screenshot response");
      await save(args[0], Buffer.from(data, "base64")); return;
    }
    case "command": {
      arity(1);
      let value;
      try { value = JSON.parse(args[0]); } catch { throw new Error("command requires valid JSON"); }
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.action !== "string") throw new Error("command requires a BrowserCommand JSON object with action");
      if (value.action === "screenshot") throw new Error("Use screenshot PATH to save the image without printing base64");
      result = await command(value); break;
    }
    default: throw new Error(usage);
  }
  print(result);
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : "Browser command failed").slice(0, 4000));
  process.exitCode = 1;
});
