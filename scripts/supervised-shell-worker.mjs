import { execFile, spawn } from "node:child_process";
import { requestSupervisor } from "./supervisor-client.mjs";

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const terminal = new Set(["completed", "failed", "stopped", "stopping", "unknown"]);

function fail(message) {
  console.error(`Joint Bob supervised shell: ${message}`);
  process.exitCode = 1;
}

async function groupHasCommands(groupId) {
  let queryPid;
  const output = await new Promise((resolve, reject) => {
    const query = execFile("/bin/ps", ["-axo", "pid=,pgid=,stat="], {
      timeout: 2000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    queryPid = query.pid;
  });
  return output.split("\n").some(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) return false;
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    const stat = match[3];
    return pgid === groupId && pid !== groupId && pid !== process.pid && pid !== queryPid && !stat.startsWith("Z") && !stat.startsWith("X");
  });
}

async function main() {
  const id = process.env.JOINT_BOB_SUPERVISED_SHELL_ID;
  const socket = process.env.JOINT_BOB_TASK_SOCKET;
  const token = process.env.JOINT_BOB_TASK_TOKEN;
  if (!id || !socket || !token) {
    fail("invalid launch context");
    return;
  }

  const deadline = Date.now() + 10_000;
  let groupId;
  while (true) {
    let task;
    try {
      task = await requestSupervisor(socket, token, { action: "task", id }, 2000);
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

  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "JOINT_BOB_SUPERVISED_SHELL_ID" && typeof value === "string"));
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
    while (await groupHasCommands(groupId)) await pause(100);
  } catch {
    fail("could not inspect command process group");
    return;
  }
  process.exitCode = code ?? 1;
}

await main();
