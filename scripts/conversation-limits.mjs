import { availableParallelism } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { processTable } from "./subprocess-lifetime.mjs";

export const MIN_CONVERSATION_CPU_CORES = 0.1;
export const MAX_CONVERSATION_CPU_CORES = 1024;
export const MIN_CONVERSATION_MEMORY_GB = 0.1;
export const MAX_CONVERSATION_MEMORY_GB = 4096;
export function validConversationCpuLimit(value) {
  return value === null || typeof value === "number" && Number.isFinite(value) && value >= MIN_CONVERSATION_CPU_CORES && value <= MAX_CONVERSATION_CPU_CORES;
}
export function validConversationMemoryLimit(value) {
  return value === null || typeof value === "number" && Number.isFinite(value) && value >= MIN_CONVERSATION_MEMORY_GB && value <= MAX_CONVERSATION_MEMORY_GB;
}

// Read only this node's policy, as the lifetime limit does: the supervisor enforces it
// without the app, so the limits keep holding while the app is replaced.
export function conversationLimits(dataDirectory) {
  let db;
  try {
    db = new DatabaseSync(path.join(dataDirectory, "node.db"), { readOnly: true });
    const read = db.prepare("SELECT value FROM node_settings WHERE key=?");
    const limit = (key, valid) => {
      const stored = read.get(key)?.value;
      const value = stored === undefined || stored === "unlimited" ? null : Number(stored);
      return valid(value) ? value : null;
    };
    return { cpuCores: limit("conversationCpuLimitCores", validConversationCpuLimit), memoryGb: limit("conversationMemoryLimitGb", validConversationMemoryLimit) };
  } catch {
    return { cpuCores: null, memoryGb: null };
  } finally { db?.close(); }
}

const POLICY_CACHE_MS = 1000;
const policyCache = new Map();
function sharedConversationLimits(dataDirectory) {
  const cached = policyCache.get(dataDirectory);
  if (cached && Date.now() - cached.at < POLICY_CACHE_MS) return cached.value;
  const value = conversationLimits(dataDirectory);
  policyCache.set(dataDirectory, { at: Date.now(), value });
  return value;
}

/** A throttled conversation always keeps this share of the time, so it can still finish. */
const MIN_RUN_FRACTION = 0.05;

function gigabytes(kilobytes) { return Math.round(kilobytes / 1_048_576 * 10) / 10; }

/**
 * Holds every conversation's commands to this node's CPU and memory limits. A conversation
 * is the tasks sharing one identity; its processes are the descendants each task's lifetime
 * watch has verified, so nothing is adopted by PID, name or process group.
 *
 * Neither macOS nor an unprivileged Linux user can cap a process tree in the kernel. CPU is
 * held by pausing the tree for part of each slice (SIGSTOP, SIGCONT); memory by stopping the
 * conversation's largest command, as a container does when it runs out.
 */
export function createConversationLimiter(options = {}) {
  const readLimits = options.limits ?? (() => sharedConversationLimits(options.dataDirectory));
  const observe = options.observe ?? processTable;
  const signal = options.signal ?? ((pid, name) => process.kill(pid, name));
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 1000;
  const sliceMs = options.sliceMs ?? 200;
  const memoryStrikes = options.memoryStrikes ?? 3;
  const conversations = new Map();
  let pollTimer;
  let sliceTimer;
  let polling = false;
  let closed = false;

  function send(pid, name) {
    try { signal(pid, name); return true; }
    catch (error) {
      if (error.code !== "ESRCH") console.error(`Joint Bob could not send ${name} to limited process ${pid}: ${error.message}`);
      return false;
    }
  }
  function resume(conversation) {
    clearTimeout(conversation.pauseTimer);
    conversation.pauseTimer = undefined;
    for (const pid of conversation.paused) send(pid, "SIGCONT");
    conversation.paused.clear();
  }
  function pause(conversation) {
    conversation.pauseTimer = undefined;
    if (closed || conversation.fraction >= 1) return;
    for (const { task, row } of conversation.processes) {
      // A command being stopped must be awake to act on its signal.
      if (task.stopping || task.isStopping?.()) continue;
      if (send(row.pid, "SIGSTOP")) conversation.paused.add(row.pid);
    }
  }
  function resumeAll() { for (const conversation of conversations.values()) resume(conversation); }
  function unlimited(conversation) {
    resume(conversation);
    Object.assign(conversation, { fraction: 1, processes: [], sampledAt: undefined, overMemory: 0 });
    conversation.cpu.clear();
  }

  function slice() {
    for (const conversation of conversations.values()) {
      resume(conversation);
      if (conversation.fraction >= 1) continue;
      conversation.pauseTimer = setTimeout(() => pause(conversation), sliceMs * conversation.fraction);
      conversation.pauseTimer.unref?.();
    }
  }
  function scheduleSlices() {
    const needed = !closed && [...conversations.values()].some(conversation => conversation.fraction < 1);
    if (needed && !sliceTimer) {
      sliceTimer = setInterval(slice, sliceMs);
      sliceTimer.unref?.();
      slice();
    } else if (!needed && sliceTimer) {
      clearInterval(sliceTimer);
      sliceTimer = undefined;
      resumeAll();
    }
  }

  function measure(conversation, rows, at, limits) {
    const processes = [];
    for (const task of conversation.tasks.values()) {
      if (task.stopping || task.isStopping?.()) continue;
      for (const known of task.watch.descendants) {
        const row = rows.get(known.pid);
        if (row && row.birth === known.birth && row.uid === known.uid) processes.push({ task, row });
      }
    }
    const elapsedMs = conversation.sampledAt === undefined ? 0 : at - conversation.sampledAt;
    const cpu = new Map();
    let usedMs = 0;
    for (const { row } of processes) {
      if (!Number.isFinite(row.cpuMs)) continue;
      const key = `${row.pid}:${row.birth}`;
      const before = conversation.cpu.get(key);
      // A process first seen now ran for at most this interval on every core.
      usedMs += before === undefined ? Math.min(row.cpuMs, elapsedMs * availableParallelism()) : Math.max(0, row.cpuMs - before);
      cpu.set(key, row.cpuMs);
    }
    conversation.cpu = cpu;
    conversation.sampledAt = at;
    conversation.processes = processes;

    if (limits.cpuCores === null) conversation.fraction = 1;
    else if (elapsedMs > 0) {
      // What it would use unpaused: it only ran for its fraction of the last interval.
      const demand = usedMs / elapsedMs / conversation.fraction;
      const target = demand > limits.cpuCores ? Math.max(MIN_RUN_FRACTION, limits.cpuCores / demand) : 1;
      conversation.fraction = target < 1 && conversation.fraction < 1 ? (conversation.fraction + target) / 2 : target;
    }

    if (limits.memoryGb === null) { conversation.overMemory = 0; return; }
    const usedByTask = new Map();
    for (const { task, row } of processes) usedByTask.set(task, (usedByTask.get(task) ?? 0) + (Number.isFinite(row.rssKb) ? row.rssKb : 0));
    const usedKb = [...usedByTask.values()].reduce((total, value) => total + value, 0);
    conversation.overMemory = usedKb > limits.memoryGb * 1_048_576 ? conversation.overMemory + 1 : 0;
    if (conversation.overMemory < memoryStrikes) return;
    conversation.overMemory = 0;
    const largest = [...usedByTask].sort((left, right) => right[1] - left[1])[0]?.[0];
    if (!largest) return;
    largest.stopping = true;
    resume(conversation);
    largest.onMemoryExceeded(`Joint Bob stopped this command: its conversation was using ${gigabytes(usedKb)} GB of memory, over the ${limits.memoryGb} GB limit for one conversation (Settings > Shell commands).`);
  }

  async function poll() {
    if (polling || closed) return;
    polling = true;
    try {
      const limits = readLimits();
      if (limits.cpuCores === null && limits.memoryGb === null) {
        for (const conversation of conversations.values()) unlimited(conversation);
        return;
      }
      const rows = await observe();
      if (closed) return;
      const at = rows.capturedAt ?? now();
      for (const conversation of conversations.values()) measure(conversation, rows, at, limits);
    } catch (error) {
      // Without a reading nothing is known to be over its limit, so nothing stays paused.
      for (const conversation of conversations.values()) unlimited(conversation);
      console.error(`Joint Bob conversation limit check failed: ${error.message}`);
    } finally {
      polling = false;
      scheduleSlices();
    }
  }

  // A paused process outlives whoever paused it, so never leave one behind.
  const onExit = () => resumeAll();
  process.once("exit", onExit);

  return {
    /** `watch` is the task worker's lifetime watch; `onMemoryExceeded` must stop the task. */
    add({ identity, id, watch, isStopping, onMemoryExceeded }) {
      if (closed) return { dispose() {} };
      let conversation = conversations.get(identity);
      if (!conversation) {
        conversation = { tasks: new Map(), cpu: new Map(), paused: new Set(), processes: [], fraction: 1, sampledAt: undefined, overMemory: 0, pauseTimer: undefined };
        conversations.set(identity, conversation);
      }
      const task = { watch, isStopping, onMemoryExceeded, stopping: false };
      conversation.tasks.set(id, task);
      if (!pollTimer) {
        pollTimer = setInterval(() => void poll(), pollMs);
        pollTimer.unref?.();
      }
      return {
        dispose() {
          if (conversations.get(identity) !== conversation || !conversation.tasks.delete(id)) return;
          // Its processes may be paused and are no longer this limiter's to wake later.
          resume(conversation);
          conversation.processes = conversation.processes.filter(process => process.task !== task);
          if (conversation.tasks.size) return;
          conversations.delete(identity);
          if (conversations.size) return;
          clearInterval(pollTimer);
          pollTimer = undefined;
          scheduleSlices();
        },
      };
    },
    poll,
    /** The share of time each limited conversation currently runs; 1 means not slowed. */
    get fractions() { return new Map([...conversations].map(([identity, conversation]) => [identity, conversation.fraction])); },
    close() {
      closed = true;
      clearInterval(pollTimer);
      clearInterval(sliceTimer);
      pollTimer = sliceTimer = undefined;
      resumeAll();
      conversations.clear();
      process.removeListener("exit", onExit);
    },
  };
}
