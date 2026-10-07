import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requestTaskControl } from "./supervisor-client.mjs";

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const terminal = new Set(["completed", "failed", "stopped", "stopping", "unknown"]);

function fail(message) {
  console.error(`Joint Bob supervised shell: ${message}`);
  process.exitCode = 1;
}

async function groupHasCommands(groupId) {
  let queryPid;
  const output = await new Promise((resolve, reject) => {
    const query = execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat="], {
      timeout: 2000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    queryPid = query.pid;
  });
  const processes = output.split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)).filter(Boolean)
    .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), stat: match[4] }));
  // Under a person's OS account the worker starts through sudo, which stays in the group as
  // this worker's parent until it exits; this worker's ancestors are never the command's.
  const parents = new Map(processes.map(entry => [entry.pid, entry.ppid]));
  const ancestors = new Set();
  for (let pid = parents.get(process.pid); pid && pid !== groupId && !ancestors.has(pid); pid = parents.get(pid)) ancestors.add(pid);
  return processes.some(({ pid, pgid, stat }) => pgid === groupId && pid !== groupId && pid !== process.pid && pid !== queryPid && !ancestors.has(pid) && !stat.startsWith("Z") && !stat.startsWith("X"));
}

async function main() {
  const id = process.env.JOINT_BOB_SUPERVISED_SHELL_ID;
  const token = process.env.JOINT_BOB_TASK_TOKEN;
  if (!id || !token || !(process.env.JOINT_BOB_TASK_SOCKET || process.env.JOINT_BOB_TASK_RELAY)) {
    fail("invalid launch context");
    return;
  }

  const deadline = Date.now() + 10_000;
  let groupId;
  while (true) {
    let task;
    try {
      task = await requestTaskControl(process.env, { action: "task", id }, 2000);
    } catch {
      fail("could not confirm task registration");
      return;
    }
    if (task.status === "running") {
      if (!Number.isInteger(task.pid) || task.pid <= 0) {
        fail("invalid task registration");
        return;
      }
      groupId = task.pid;
      break;
    }
    if (terminal.has(task.status)) {
      fail("task stopped before launch");
      return;
    }
    if (task.status !== "starting" || Date.now() >= deadline) {
      fail("task did not become ready");
      return;
    }
    await pause(25);
  }

  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "JOINT_BOB_SUPERVISED_SHELL_ID" && name !== "JOINT_BOB_SHELL_EXITS" && typeof value === "string"));
  let child;
  try {
    child = spawn("/bin/bash", process.argv.slice(2), {
      cwd: process.cwd(), env, stdio: ["ignore", "inherit", "inherit"], detached: false, shell: false,
    });
  } catch {
    fail("could not launch command");
    return;
  }
  child.once("error", () => fail("could not launch command"));
  const code = await new Promise(resolve => child.once("close", resolve));
  try {
    // Inspect once before publishing the shell exit. Otherwise a slow ps can
    // outlast the shim's grace period and falsely report background children.
    let commandsRemain = await groupHasCommands(groupId);
    const exits = process.env.JOINT_BOB_SHELL_EXITS || path.join(process.env.JOINT_BOB_TASK_DATA_DIR, "shell-exits");
    mkdirSync(exits, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(exits, id), String(code ?? 1), { mode: 0o600 });
    while (commandsRemain) {
      await pause(100);
      commandsRemain = await groupHasCommands(groupId);
    }
  } catch {
    fail("could not inspect command process group");
    return;
  }
  process.exitCode = code ?? 1;
}

await main();
