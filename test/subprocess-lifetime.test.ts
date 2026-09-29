import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { watchSubprocess } from "../scripts/subprocess-lifetime.mjs";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function cleaned(watch: { active: boolean }) {
  const deadline = Date.now() + 3000;
  while (watch.active && Date.now() < deadline) await delay(20);
  assert.equal(watch.active, false, "lifetime timer must release exited root and descendants");
}

test("wall-clock expiration uses TERM then KILL even with continuous output", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>console.log('active'),10)"], { stdio: ["ignore", "pipe", "ignore"] });
  await once(child.stdout!, "data");
  const ended = once(child, "exit");
  const watch = watchSubprocess(child, { lifetimeMs: () => 120, graceMs: 60, pollMs: 20 });
  try {
    const [, signal] = await ended;
    assert.equal(signal, "SIGKILL");
    await cleaned(watch);
  } finally { child.kill("SIGKILL"); watch.dispose(); }
});

test("changing lifetime applies to original launch time and exit cancels timers", async () => {
  let limit = 10_000;
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  const ended = once(child, "exit");
  const watch = watchSubprocess(child, { lifetimeMs: () => limit, graceMs: 30, pollMs: 20 });
  try {
    await delay(150);
    limit = 40;
    assert.equal((await ended)[1], "SIGTERM");
    await cleaned(watch);
  } finally { child.kill("SIGKILL"); watch.dispose(); }
  const short = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const cleanup = watchSubprocess(short, { lifetimeMs: () => 10_000, pollMs: 20 });
  await once(short, "exit");
  await cleaned(cleanup);
});

test("expiration cleans descendants without touching a sibling", async () => {
  const sibling = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  const child = spawn(process.execPath, ["-e", `const sub=require('child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});console.log(sub.pid);setInterval(()=>{},1000)`]);
  const [output] = await once(child.stdout!, "data");
  const descendantPid = Number(String(output).trim());
  assert.ok(descendantPid > 1);
  const watch = watchSubprocess(child, { lifetimeMs: () => 350, graceMs: 80, pollMs: 20 });
  try {
    await once(child, "exit");
    await cleaned(watch);
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
    assert.equal(sibling.exitCode, null);
    assert.equal(sibling.signalCode, null);
  } finally { child.kill("SIGKILL"); sibling.kill("SIGKILL"); watch.dispose(); }
});

test("reused descendant PID is not signalled after identity changes", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 900001, exitCode: null, signalCode: null, kill: () => true });
  const root = { pid: child.pid, parent: process.pid, uid: process.getuid!(), birth: "root" };
  const descendant = { pid: 900002, parent: child.pid, uid: process.getuid!(), birth: "original" };
  let reads = 0;
  const signals: number[] = [];
  const watch = watchSubprocess(child as any, {
    lifetimeMs: () => 1, pollMs: 10, graceMs: 10,
    observe: async () => {
      reads++;
      return new Map([[root.pid, root], [descendant.pid, reads === 1 ? descendant : { ...descendant, parent: 1, birth: "replacement" }]]);
    },
    signalDescendant: pid => { signals.push(pid); },
  });
  try {
    await delay(80);
    assert.ok(reads > 1);
    assert.deepEqual(signals, []);
    child.emit("exit", 0);
    await cleaned(watch);
  } finally { watch.dispose(); }
});

test("failed spawn releases its lifetime watch", async () => {
  const child = spawn("/nonexistent-joint-bob-lifetime-fixture");
  const watch = watchSubprocess(child, { lifetimeMs: () => 100, pollMs: 10 });
  await once(child, "error");
  await cleaned(watch);
});

test("normal root exit cleans a previously observed stubborn descendant", async () => {
  const child = spawn(process.execPath, ["-e", `const sub=require('child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});console.log(sub.pid);process.stdin.once('data',()=>process.exit(0));setInterval(()=>{},1000)`]);
  const [output] = await once(child.stdout!, "data");
  const pid = Number(String(output).trim());
  const watch = watchSubprocess(child, { lifetimeMs: () => 10_000, graceMs: 50, pollMs: 20 });
  try {
    const deadline = Date.now() + 3000;
    while (!watch.descendantCount && Date.now() < deadline) await delay(20);
    assert.equal(watch.descendantCount, 1, "fixture descendant must be observed before root exits");
    const exit = once(child, "exit");
    child.stdin!.write("exit\n");
    assert.equal((await exit)[0], 0);
    await cleaned(watch);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { child.kill("SIGKILL"); watch.dispose(); }
});
