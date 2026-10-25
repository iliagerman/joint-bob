#!/usr/bin/env node
// Measures how fast and how cheaply a file sync engine moves changes from this machine to a peer.
//
// The same scenarios run against Syncthing (the baseline, FILE-SYNC-PLAN.md 10.2) and against the
// built-in engine, so the two can be compared side by side. Changes are written into a local folder
// that the engine under test keeps in step with a folder on the peer; a small waiter started over ssh
// on the peer reports the moment the change is there. Timing is taken on this machine from the end of
// the local write to the waiter's answer, so the two clocks never need to agree.
//
//   node scripts/sync-bench.mjs --setup syncthing            create a dedicated Syncthing folder pair
//   node scripts/sync-bench.mjs --engine syncthing [--scenarios a,b] [--out file.json]
//   node scripts/sync-bench.mjs --engine builtin --local-dir <project path> --remote-dir <peer path>
//   node scripts/sync-bench.mjs --teardown syncthing         remove the folder pair and its files
//
// Options: --host <ssh host> (default homeserver), --local-dir, --remote-dir (default ~/jb-sync-bench on
// both), --repeat <n> (default 3, small scenarios only), --timeout <s> (default 900 per scenario).
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile, cp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  engine: { type: "string" }, setup: { type: "string" }, teardown: { type: "string" },
  host: { type: "string", default: "homeserver" }, "local-dir": { type: "string" }, "remote-dir": { type: "string" },
  scenarios: { type: "string" }, out: { type: "string" }, repeat: { type: "string", default: "3" }, timeout: { type: "string", default: "900" },
  "tree-source": { type: "string" },
} });
const host = values.host;
const localDir = path.resolve(values["local-dir"] ?? path.join(os.homedir(), "jb-sync-bench"));
const remoteDir = values["remote-dir"] ?? "jb-sync-bench";          // relative paths are under the peer's home
const repeat = Number(values.repeat);
const timeoutMs = Number(values.timeout) * 1000;
const FOLDER_ID = "jb-sync-bench";

function ssh(command, input) {
  return execFileSync("ssh", ["-o", "ConnectTimeout=10", host, command], { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

// ---- Syncthing REST on both machines ------------------------------------------------------------
async function localSyncthing() {
  const file = process.platform === "darwin" ? path.join(os.homedir(), "Library/Application Support/Syncthing/config.xml") : path.join(os.homedir(), ".local/state/syncthing/config.xml");
  const xml = await readFile(file, "utf8");
  const gui = xml.match(/<gui[^>]*>([\s\S]*?)<\/gui>/)?.[1] ?? "";
  const address = gui.match(/<address>([^<]+)<\/address>/)?.[1]?.replace(/^0\.0\.0\.0:/, "127.0.0.1:");
  const key = gui.match(/<apikey>([^<]+)<\/apikey>/)?.[1];
  if (!address || !key) throw new Error(`No Syncthing GUI address or API key in ${file}`);
  return async (endpoint, init = {}) => {
    const response = await fetch(`http://${address}/rest/${endpoint}`, { ...init, headers: { "X-API-Key": key, "Content-Type": "application/json" } });
    if (!response.ok) throw new Error(`Local Syncthing ${endpoint}: ${response.status} ${await response.text()}`);
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  };
}

function remoteSyncthing() {
  const script = `
const fs=require("fs"),os=require("os");
const xml=fs.readFileSync(os.homedir()+"/.local/state/syncthing/config.xml","utf8");
const gui=(xml.match(/<gui[^>]*>([\\s\\S]*?)<\\/gui>/)||[])[1]||"";
const address=((gui.match(/<address>([^<]+)<\\/address>/)||[])[1]||"127.0.0.1:8384").replace(/^0\\.0\\.0\\.0:/,"127.0.0.1:");
const key=(gui.match(/<apikey>([^<]+)<\\/apikey>/)||[])[1];
const [endpoint,method,body]=JSON.parse(process.argv[1]);
fetch("http://"+address+"/rest/"+endpoint,{method,body:body??undefined,headers:{"X-API-Key":key,"Content-Type":"application/json"}})
  .then(async r=>{const t=await r.text();if(!r.ok){console.error(r.status+" "+t);process.exit(1)}process.stdout.write(t)});`;
  return async (endpoint, init = {}) => {
    const out = ssh(`node -e ${shellQuote(script)} ${shellQuote(JSON.stringify([endpoint, init.method ?? "GET", init.body ?? null]))}`);
    return out ? JSON.parse(out) : undefined;
  };
}

function shellQuote(text) { return `'${text.replaceAll("'", "'\\''")}'`; }

async function setupSyncthing() {
  const local = await localSyncthing(), remote = remoteSyncthing();
  const [localId, remoteId] = [(await local("system/status")).myID, (await remote("system/status")).myID];
  const remoteHome = ssh("printf %s \"$HOME\"");
  const remotePath = path.posix.isAbsolute(remoteDir) ? remoteDir : `${remoteHome}/${remoteDir}`;
  await mkdir(localDir, { recursive: true });
  ssh(`mkdir -p ${shellQuote(remotePath)}`);
  const devices = [{ deviceID: localId }, { deviceID: remoteId }];
  // Syncthing's defaults are what Joint Bob's project folders run with (src/syncthing.ts ensureFolder sends no tuning).
  await local("config/folders", { method: "POST", body: JSON.stringify({ id: FOLDER_ID, label: "Joint Bob sync benchmark", path: localDir, type: "sendreceive", devices }) });
  await remote("config/folders", { method: "POST", body: JSON.stringify({ id: FOLDER_ID, label: "Joint Bob sync benchmark", path: remotePath, type: "sendreceive", devices }) });
  const folder = await local(`config/folders/${FOLDER_ID}`);
  console.log(`Created folder ${FOLDER_ID}: ${localDir} ↔ ${host}:${remotePath} (watcher delay ${folder.fsWatcherDelayS}s, rescan ${folder.rescanIntervalS}s)`);
}

async function teardownSyncthing() {
  const local = await localSyncthing(), remote = remoteSyncthing();
  await local(`config/folders/${FOLDER_ID}`, { method: "DELETE" }).catch((error) => console.warn(String(error)));
  await remote(`config/folders/${FOLDER_ID}`, { method: "DELETE" }).catch((error) => console.warn(String(error)));
  await rm(localDir, { recursive: true, force: true });
  ssh(`rm -rf -- ${shellQuote(remoteDir)}`);
  console.log(`Removed folder ${FOLDER_ID} and both copies`);
}

// ---- Engine probes: bytes on the wire and CPU of the sync process ----------------------------------
async function syncthingProbe() {
  const local = await localSyncthing(), remote = remoteSyncthing();
  const remoteId = (await remote("system/status")).myID;
  const localPid = execFileSync("pgrep", ["-f", "syncthing.*serve|bin/syncthing --no-browser"], { encoding: "utf8" }).trim().split("\n").pop();
  const remotePid = ssh("pgrep -f 'syncthing serve' | tail -1");
  return {
    name: "syncthing",
    async sample() {
      const connection = (await local("system/connections")).connections?.[remoteId] ?? {};
      return { outBytes: connection.outBytesTotal ?? 0, inBytes: connection.inBytesTotal ?? 0, localCpuMs: cpuMs(localPid), remoteCpuMs: remoteCpuMs(remotePid) };
    },
  };
}

function builtinProbe() {
  const localPid = execFileSync("pgrep", ["-f", "joint-bob/app/releases/.*/dist/server.js"], { encoding: "utf8" }).trim().split("\n")[0];
  const remotePid = ssh("pgrep -f 'joint-bob/app/releases/.*/dist/server.js' | head -1");
  return {
    name: "builtin",
    // The engine runs in a worker thread of the Joint Bob process: CPU here is the whole process.
    async sample() { return { outBytes: 0, inBytes: 0, localCpuMs: cpuMs(localPid), remoteCpuMs: remoteCpuMs(remotePid) }; },
  };
}

function parseCpuTime(text) {
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return ((Number(days) * 24 + parts[0]) * 3600 + parts[1] * 60 + parts[2]) * 1000;
}
function cpuMs(pid) { return parseCpuTime(execFileSync("ps", ["-o", "time=", "-p", pid], { encoding: "utf8" }).trim()); }
function remoteCpuMs(pid) {
  // Linux ps prints whole seconds; /proc gives clock ticks.
  const ticks = ssh(`awk '{print $14+$15}' /proc/${pid}/stat`);
  return Number(ticks) * 10;
}

// ---- The waiter on the peer ---------------------------------------------------------------------
const WAITER = `
const fs=require("fs"),path=require("path"),crypto=require("crypto");
const spec=JSON.parse(process.argv[1]);const root=path.resolve(require("os").homedir(),spec.root);
const started=Date.now();
function ok(item){
  const file=path.join(root,item.path);
  if(item.gone){return !fs.existsSync(file);}
  let st;try{st=fs.statSync(file)}catch{return false}
  if(item.count!==undefined){let n=0,b=0;const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.isFile()&&!e.name.startsWith(".syncthing.")&&!e.name.startsWith(".joint-bob-sync.")){n++;b+=fs.statSync(p).size}}};try{walk(file)}catch{return false}return n===item.count&&b===item.bytes;}
  if(st.size!==item.size)return false;
  if(item.sha256){const h=crypto.createHash("sha256");const fd=fs.openSync(file,"r");try{const len=item.length??st.size;const buf=Buffer.alloc(Math.min(len,1<<20));let off=item.offset??0,left=len;while(left>0){const n=fs.readSync(fd,buf,0,Math.min(buf.length,left),off);if(!n)return false;h.update(buf.subarray(0,n));off+=n;left-=n}}finally{fs.closeSync(fd)}return h.digest("hex")===item.sha256;}
  return true;
}
let pending=spec.items.slice();
process.stdout.write(JSON.stringify({armed:true})+"\\n");
const tick=()=>{pending=pending.filter(i=>!ok(i));if(!pending.length){process.stdout.write(JSON.stringify({ready:true,ms:Date.now()-started})+"\\n");process.exit(0)}
  if(Date.now()-started>spec.timeoutMs){process.stdout.write(JSON.stringify({ready:false,pending:pending.length,first:pending[0]})+"\\n");process.exit(2)}
  setTimeout(tick,spec.intervalMs)};
tick();`;

function startWaiter(items, intervalMs = 50) {
  const child = spawn("ssh", ["-o", "ConnectTimeout=10", host, `node -e ${shellQuote(WAITER)} ${shellQuote(JSON.stringify({ root: remoteDir, items, timeoutMs, intervalMs }))}`], { stdio: ["ignore", "pipe", "inherit"] });
  let buffer = "";
  const lines = [];
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      lines.push({ line, at: performance.now() });
      waiters.splice(0).forEach((wake) => wake());
    }
  });
  const next = () => new Promise((resolve, reject) => {
    const take = () => { if (lines.length) resolve(lines.shift()); else if (child.exitCode !== null && !lines.length) reject(new Error(`Waiter exited with ${child.exitCode}`)); else waiters.push(take); };
    take();
    child.once("exit", () => waiters.splice(0).forEach((wake) => wake()));
  });
  return { next, child };
}

async function measure(probe, label, items, write, intervalMs) {
  const waiter = startWaiter(items, intervalMs);
  const armed = await waiter.next();
  if (!armed.line.armed) throw new Error("Waiter did not start");
  const before = await probe.sample();
  const writeStart = performance.now();
  await write();
  const written = performance.now();
  const answer = await waiter.next();
  const after = await probe.sample();
  if (!answer.line.ready) throw new Error(`${label}: not on the peer after ${values.timeout}s (${JSON.stringify(answer.line)})`);
  return {
    label, writeMs: Math.round(written - writeStart), arrivalMs: Math.round(answer.at - written),
    outBytes: after.outBytes - before.outBytes, inBytes: after.inBytes - before.inBytes,
    localCpuMs: after.localCpuMs - before.localCpuMs, remoteCpuMs: after.remoteCpuMs - before.remoteCpuMs,
  };
}

// ---- Scenarios ------------------------------------------------------------------------------------
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const run = randomBytes(4).toString("hex");

const SCENARIOS = {
  async "small-edit"(probe) {
    const results = [];
    for (let attempt = 0; attempt < repeat; attempt += 1) {
      const name = `small-${run}-${attempt}.txt`, content = Buffer.from(`edit ${attempt} ${randomBytes(16).toString("hex")}\n`);
      results.push(await measure(probe, "small-edit", [{ path: name, size: content.length, sha256: sha(content) }], () => writeFile(path.join(localDir, name), content)));
    }
    return results;
  },
  async "turn-50"(probe) {
    const results = [];
    for (let attempt = 0; attempt < repeat; attempt += 1) {
      const dir = `turn-${run}-${attempt}`;
      const files = Array.from({ length: 50 }, (_, index) => ({ path: `${dir}/src/module-${index}.ts`, content: Buffer.from(`export const value${index} = ${JSON.stringify(randomBytes(200 + index * 40).toString("base64"))};\n`) }));
      results.push(await measure(probe, "turn-50", files.map((file) => ({ path: file.path, size: file.content.length, sha256: sha(file.content) })), async () => {
        await mkdir(path.join(localDir, dir, "src"), { recursive: true });
        for (const file of files) await writeFile(path.join(localDir, file.path), file.content);
      }));
    }
    return results;
  },
  async "bulk-10k"(probe) {
    const dir = `bulk-${run}`, count = 10_000;
    const files = Array.from({ length: count }, (_, index) => ({ path: `${dir}/d${index % 100}/f${index}.txt`, content: Buffer.from(`${index} ${randomBytes(64 + (index % 512)).toString("base64")}\n`) }));
    const bytes = files.reduce((total, file) => total + file.content.length, 0);
    const result = await measure(probe, "bulk-10k", [{ path: dir, count, bytes }], async () => {
      for (let index = 0; index < 100; index += 1) await mkdir(path.join(localDir, dir, `d${index}`), { recursive: true });
      for (const file of files) await writeFile(path.join(localDir, file.path), file.content);
    }, 500);
    const deleted = await measure(probe, "delete-10k", [{ path: dir, gone: true }], () => rm(path.join(localDir, dir), { recursive: true, force: true }), 200);
    return [result, deleted];
  },
  async "big-file"(probe) {
    const name = `big-${run}.bin`, size = 500 * 1024 * 1024, chunk = 4 * 1024 * 1024;
    const hash = createHash("sha256");
    const first = await measure(probe, "big-file-500mb", [{ path: name, size }], async () => {
      const file = await open(path.join(localDir, name), "w");
      try { for (let offset = 0; offset < size; offset += chunk) { const block = randomBytes(chunk); hash.update(block); await file.write(block, 0, block.length, offset); } } finally { await file.close(); }
    }, 250);
    // 1 MiB changed in the middle, same size: Syncthing sends changed blocks only; whole-file engines send it all.
    const patch = randomBytes(1024 * 1024), offset = 200 * 1024 * 1024;
    const second = await measure(probe, "big-file-1mb-change", [{ path: name, size, offset, length: patch.length, sha256: sha(patch) }], async () => {
      const file = await open(path.join(localDir, name), "r+");
      try { await file.write(patch, 0, patch.length, offset); } finally { await file.close(); }
    }, 250);
    const gone = await measure(probe, "big-file-delete", [{ path: name, gone: true }], () => rm(path.join(localDir, name), { force: true }), 200);
    return [first, second, gone];
  },
  async "tree-copy"(probe) {
    // Stands in for a new worktree of a real repository: its tracked files, copied into a new folder.
    const source = path.resolve(values["tree-source"] ?? process.cwd());
    const tracked = execFileSync("git", ["-C", source, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\0").filter(Boolean);
    const dir = `tree-${run}`;
    const files = [];
    for (const relative of tracked) {
      try { const info = await stat(path.join(source, relative)); if (info.isFile()) files.push({ relative, size: info.size }); } catch { /* deleted in the work tree */ }
    }
    const bytes = files.reduce((total, file) => total + file.size, 0);
    const result = await measure(probe, `tree-copy (${files.length} files, ${(bytes / 1048576).toFixed(1)} MB)`, [{ path: dir, count: files.length, bytes }], async () => {
      for (const file of files) await cp(path.join(source, file.relative), path.join(localDir, dir, file.relative), { force: true });
    }, 500);
    const deleted = await measure(probe, "tree-delete", [{ path: dir, gone: true }], () => rm(path.join(localDir, dir), { recursive: true, force: true }), 200);
    return [result, deleted];
  },
};

async function main() {
  if (values.setup === "syncthing") return setupSyncthing();
  if (values.teardown === "syncthing") return teardownSyncthing();
  if (!values.engine) throw new Error("Pass --engine syncthing|builtin, --setup syncthing or --teardown syncthing");
  const probe = values.engine === "syncthing" ? await syncthingProbe() : builtinProbe();
  const names = values.scenarios ? values.scenarios.split(",") : Object.keys(SCENARIOS);
  const report = { engine: probe.name, host, localDir, remoteDir, startedAt: new Date().toISOString(), node: process.version, results: [] };
  for (const name of names) {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(`Unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(", ")}`);
    process.stderr.write(`${name}…\n`);
    for (const result of await scenario(probe)) { report.results.push(result); process.stderr.write(`  ${JSON.stringify(result)}\n`); }
  }
  report.finishedAt = new Date().toISOString();
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out) await writeFile(values.out, text); else process.stdout.write(text);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
