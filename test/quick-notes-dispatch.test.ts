import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { getClusterNode } from "../src/cluster.js";
import { addProject } from "../src/store.js";
import { saveSecretAccount } from "../src/secrets.js";
import {
  claimQuickNoteForLaunch,
  createQuickNote,
  finishQuickNote,
  getQuickNote,
  getQuickNoteQueue,
  setQuickNoteQueue,
  type QuickNote,
} from "../src/quick-notes.js";
import { launchQuickNote, planQuickNoteLaunches, prepareQuickNoteConversation, QuickNoteLaunchError } from "../src/server/quick-note-dispatch.js";
import { server } from "../src/server/state.js";

const minute = 60_000;

interface PlanNote { id: string; status: QuickNote["status"]; createdAt: string; scheduledAt: string | null }

function planNote(id: string, createdAt: string, scheduledAt: string | null = null, status: QuickNote["status"] = "pending"): PlanNote {
  return { id, status, createdAt, scheduledAt };
}

test("queue planning starts only eligible notes oldest-first within the parallel limit", () => {
  const now = Date.parse("2026-01-01T09:00:00.000Z");
  const queue = { enabled: true, maxParallel: 2 };
  assert.deepEqual(planQuickNoteLaunches([planNote("unscheduled", "2026-01-01T08:00:01.000Z")], { enabled: false, maxParallel: 1 }, 0, now), []);
  assert.deepEqual(planQuickNoteLaunches([planNote("unscheduled", "2026-01-01T08:00:01.000Z")], queue, 2, now), [], "a full node starts nothing");
  assert.deepEqual(planQuickNoteLaunches([planNote("unscheduled", "2026-01-01T08:00:01.000Z")], queue, 0, now), ["unscheduled"]);
  assert.deepEqual(planQuickNoteLaunches([planNote("future", "2026-01-01T08:00:01.000Z", new Date(now + 30 * minute).toISOString())], queue, 0, now), [], "a scheduled note never starts early");
  assert.deepEqual(planQuickNoteLaunches([planNote("future", "2026-01-01T08:00:01.000Z", new Date(now + 30 * minute).toISOString())], { enabled: false, maxParallel: 1 }, 0, now), []);
  assert.deepEqual(planQuickNoteLaunches([planNote("due", "2026-01-01T08:00:01.000Z", new Date(now - minute).toISOString())], { enabled: false, maxParallel: 1 }, 0, now), ["due"], "a due scheduled note starts even with the queue disabled");
  assert.deepEqual(planQuickNoteLaunches([planNote("due", "2026-01-01T08:00:01.000Z", new Date(now).toISOString())], { enabled: false, maxParallel: 1 }, 0, now), ["due"], "due means due at the current instant");
  assert.deepEqual(planQuickNoteLaunches([
    planNote("oldest", "2026-01-01T08:00:01.000Z"),
    planNote("blocked", "2026-01-01T08:00:02.000Z", new Date(now + minute).toISOString()),
    planNote("newest", "2026-01-01T08:00:03.000Z"),
  ], queue, 1, now), ["oldest"], "the limit wins and unscheduled notes wait their FIFO turn");
  assert.deepEqual(planQuickNoteLaunches([
    planNote("oldest", "2026-01-01T08:00:01.000Z"),
    planNote("middle", "2026-01-01T08:00:02.000Z"),
    planNote("newest", "2026-01-01T08:00:03.000Z"),
  ], queue, 0, now), ["oldest", "middle"]);
  assert.deepEqual(planQuickNoteLaunches([
    planNote("running", "2026-01-01T08:00:01.000Z", null, "started"),
    planNote("failed", "2026-01-01T08:00:02.000Z", null, "failed"),
    planNote("pending", "2026-01-01T08:00:03.000Z"),
  ], queue, 0, now), ["pending"], "only pending notes dispatch automatically");
});

/** Synthetic /ws endpoint speaking the machine prompt-queue protocol; no model runs. */
interface SyntheticQueue {
  urls: URL[];
  prompts: Array<Record<string, unknown>>;
  accept: () => void;
  complete: () => void;
  failPrompt: (error: string) => void;
}

async function syntheticPromptQueue(): Promise<{ endpoint: WebSocketServer; queue: SyntheticQueue }> {
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  const queue: SyntheticQueue = {
    urls: [], prompts: [],
    accept: () => undefined, complete: () => undefined, failPrompt: () => undefined,
  };
  endpoint.on("connection", (socket: WebSocket, request) => {
    queue.urls.push(new URL(request.url ?? "/", "http://127.0.0.1"));
    socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "zai", id: "glm-5.3-flash" }, thinkingLevel: "high", isStreaming: false } }));
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      queue.prompts.push(message);
      if (message.type !== "prompt") return;
      const requestId = message.requestId;
      let queueId: string | undefined;
      queue.accept = () => {
        queueId = randomUUID();
        socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId, queueId }));
      };
      queue.complete = () => {
        socket.send(JSON.stringify({ type: "promptStarted", queueId }));
        socket.send(JSON.stringify({ type: "promptCompleted", queueId }));
      };
      queue.failPrompt = (error: string) => socket.send(JSON.stringify({ type: "promptFailed", queueId, error }));
    });
  });
  return { endpoint, queue };
}

async function waitForPrompts(queue: SyntheticQueue, count = 1): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (queue.prompts.length < count) {
    if (Date.now() > deadline) throw new Error(`Synthetic queue saw ${queue.prompts.length}/${count} prompts`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function closeEndpoint(endpoint: WebSocketServer): Promise<void> {
  for (const socket of endpoint.clients) socket.terminate();
  await new Promise<void>(resolve => endpoint.close(() => resolve()));
}

let projectRoot: string;

test.before(async () => {
  projectRoot = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-note-dispatch-"));
  setQuickNoteQueue({ enabled: false, maxParallel: 1 });
});

test("a manual launch drives the /ws prompt-queue protocol with images, settings, and accounts", async (context) => {
  const { endpoint, queue } = await syntheticPromptQueue();
  context.mock.method(server, "address", () => endpoint.address());
  const project = await addProject("dispatch-manual", path.join(projectRoot, "dispatch-manual"));
  const account = await saveSecretAccount({ label: "Dispatch account", provider: "custom", variables: [{ name: "DISPATCH_TOKEN", kind: "value", value: "secret" }] });
  const imageData = Buffer.from("dispatch-image").toString("base64");
  const note = createQuickNote({
    projectId: project.id,
    title: "Wire everything",
    content: "Do the thing",
    harnessId: "pi",
    provider: "zai",
    modelId: "glm-5.3-flash",
    thinkingLevel: "low",
    secretAccountIds: [account.id],
    images: [{ id: randomUUID(), kind: "image", name: "chart.png", mimeType: "image/png", data: imageData }],
  });
  try {
    const launch = launchQuickNote(note.id);
    await waitForPrompts(queue);
    queue.accept();
    const started = await launch;
    assert.equal(started.status, "started");
    assert.match(started.sessionId!, /^[0-9a-f-]{36}$/);
    const [prompt] = queue.prompts as Array<{ type: string; message: string; requestId: string; images: unknown; queueSettings: unknown }>;
    assert.equal(prompt.type, "prompt");
    assert.equal(prompt.message, "Wire everything\n\nDo the thing");
    assert.equal(prompt.requestId, getQuickNote(note.id)?.launchRequestId);
    assert.deepEqual(prompt.images, [{ name: "chart.png", mimeType: "image/png", data: imageData }]);
    assert.deepEqual(prompt.queueSettings, { harnessId: "pi", provider: "zai", modelId: "glm-5.3-flash", reasoning: "low" });
    const url = queue.urls[0];
    assert.equal(url.searchParams.get("projectId"), project.id);
    assert.equal(url.searchParams.get("sessionId"), started.sessionId);
    assert.equal(url.searchParams.get("sessionPath"), `draft:pi:${started.sessionId}`);
    assert.equal(url.searchParams.get("nodeSession"), "1");
    assert.equal(url.searchParams.get("secretAccountIds"), account.id);
    queue.complete();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(getQuickNote(note.id)?.status, "completed", "the slot is kept until prompt completion");
  } finally {
    await closeEndpoint(endpoint);
  }
});

test("a duplicate manual start is rejected while the first launch is in flight", async (context) => {
  const { endpoint, queue } = await syntheticPromptQueue();
  context.mock.method(server, "address", () => endpoint.address());
  const project = await addProject("dispatch-duplicate", path.join(projectRoot, "dispatch-duplicate"));
  const note = createQuickNote({ projectId: project.id, title: "Only once", content: "Body", harnessId: "pi" });
  try {
    const launch = launchQuickNote(note.id);
    await waitForPrompts(queue);
    await assert.rejects(launchQuickNote(note.id), (error: unknown) => {
      assert.ok(error instanceof QuickNoteLaunchError);
      assert.equal(error.status, 409);
      assert.match(error.message, /already starting/);
      return true;
    });
    queue.accept();
    const started = await launch;
    assert.equal(started.status, "started");
    await assert.rejects(launchQuickNote(note.id), (error: unknown) => {
      assert.ok(error instanceof QuickNoteLaunchError);
      assert.equal(error.status, 409);
      assert.match(error.message, /already (been )?started/);
      return true;
    });
    queue.complete();
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    await closeEndpoint(endpoint);
  }
});

test("missing secret accounts fail the launch instead of silently dropping them", async (context) => {
  const { endpoint, queue } = await syntheticPromptQueue();
  context.mock.method(server, "address", () => endpoint.address());
  const project = await addProject("dispatch-secrets", path.join(projectRoot, "dispatch-secrets"));
  const missing = randomUUID();
  const note = createQuickNote({ projectId: project.id, title: "Needs secrets", content: "Body", harnessId: "pi", secretAccountIds: [missing] });
  try {
    await assert.rejects(launchQuickNote(note.id), (error: unknown) => {
      assert.ok(error instanceof QuickNoteLaunchError);
      assert.equal(error.status, 400);
      assert.match(error.message, new RegExp(missing));
      return true;
    });
    const failed = getQuickNote(note.id)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, new RegExp(missing));
    assert.equal(queue.urls.length, 0, "no conversation may start without its credentials");
  } finally {
    await closeEndpoint(endpoint);
  }
});

test("a selected node that does not exist fails the launch without falling back to this node", async (context) => {
  const { endpoint, queue } = await syntheticPromptQueue();
  context.mock.method(server, "address", () => endpoint.address());
  const project = await addProject("dispatch-node", path.join(projectRoot, "dispatch-node"));
  const note = createQuickNote({ projectId: project.id, title: "Elsewhere", content: "Body", harnessId: "pi", nodeId: randomUUID() });
  try {
    await assert.rejects(launchQuickNote(note.id), (error: unknown) => {
      assert.ok(error instanceof QuickNoteLaunchError);
      assert.equal(error.status, 502);
      assert.match(error.message, /selected node/i);
      return true;
    });
    assert.equal(getQuickNote(note.id)?.status, "failed");
    assert.equal(queue.urls.length, 0, "an unavailable node must not degrade into a local launch");
  } finally {
    await closeEndpoint(endpoint);
  }
});

test("a refused conversation surfaces the wire error on the note", async (context) => {
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  context.mock.method(server, "address", () => endpoint.address());
  const project = await addProject("dispatch-refused", path.join(projectRoot, "dispatch-refused"));
  const note = createQuickNote({ projectId: project.id, title: "Refused", content: "Body", harnessId: "pi" });
  endpoint.on("connection", socket => socket.close(1008, "Project not found"));
  try {
    await assert.rejects(launchQuickNote(note.id), /Project not found/);
    const failed = getQuickNote(note.id)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /Project not found/);
  } finally {
    await closeEndpoint(endpoint);
  }
});

test("a prompt that fails mid-turn returns the note to failed", async (context) => {
  const { endpoint, queue } = await syntheticPromptQueue();
  context.mock.method(server, "address", () => endpoint.address());
  const project = await addProject("dispatch-failed-prompt", path.join(projectRoot, "dispatch-failed-prompt"));
  const note = createQuickNote({ projectId: project.id, title: "Fails mid-turn", content: "Body", harnessId: "pi" });
  try {
    const launch = launchQuickNote(note.id);
    await waitForPrompts(queue);
    queue.accept();
    assert.equal((await launch).status, "started");
    queue.failPrompt("Model exploded");
    const deadline = Date.now() + 5_000;
    while (getQuickNote(note.id)?.status !== "failed") {
      if (Date.now() > deadline) throw new Error(`note status stayed ${getQuickNote(note.id)?.status}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(getQuickNote(note.id)!.error!, /Model exploded/);
  } finally {
    await closeEndpoint(endpoint);
  }
});

test("an empty note falls back to its title as the prompt", async (context) => {
  const { endpoint, queue } = await syntheticPromptQueue();
  context.mock.method(server, "address", () => endpoint.address());
  const project = await addProject("dispatch-title", path.join(projectRoot, "dispatch-title"));
  const note = createQuickNote({ projectId: project.id, title: "Just a title", content: "", harnessId: "pi" });
  try {
    const launch = launchQuickNote(note.id);
    await waitForPrompts(queue);
    queue.accept();
    await launch;
    assert.equal((queue.prompts[0] as { message: string }).message, "Just a title");
    queue.complete();
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    await closeEndpoint(endpoint);
  }
});

test("a stalled launch fails closed as uncertain and a late reply cannot resurrect it", async (context) => {
  const { endpoint, queue } = await syntheticPromptQueue();
  context.mock.method(server, "address", () => endpoint.address());
  const project = await addProject("dispatch-stall", path.join(projectRoot, "dispatch-stall"));
  const note = createQuickNote({ projectId: project.id, title: "Stalled", content: "Body", harnessId: "pi" });
  const nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
  const launchTimer = {} as NodeJS.Timeout;
  let launchTimerActive = true, expireLaunchTimer = () => undefined;
  context.mock.method(globalThis, "setTimeout", ((callback: () => void, milliseconds?: number, ...args: unknown[]) => {
    if (milliseconds === 30_000) {
      expireLaunchTimer = () => { if (launchTimerActive) callback(...args); };
      return launchTimer;
    }
    return nativeSetTimeout(callback, milliseconds, ...args);
  }) as typeof setTimeout);
  context.mock.method(globalThis, "clearTimeout", ((timer: NodeJS.Timeout) => {
    if (timer === launchTimer) launchTimerActive = false;
    else nativeClearTimeout(timer);
  }) as typeof clearTimeout);
  const stalledSockets: WebSocket[] = [];
  endpoint.on("connection", (socket: WebSocket) => stalledSockets.push(socket));
  try {
    const launch = launchQuickNote(note.id);
    await waitForPrompts(queue);
    expireLaunchTimer();
    await assert.rejects(launch, /uncertain/i);
    assert.equal(getQuickNote(note.id)?.status, "failed");
    // The server belatedly confirms the queue; the terminated socket must ignore it.
    for (const socket of stalledSockets) {
      socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: queue.prompts[0].requestId, queueId: randomUUID() }));
      socket.send(JSON.stringify({ type: "promptCompleted", queueId: queue.prompts[0].requestId }));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(getQuickNote(note.id)?.status, "failed", "a closed launch may not turn into a phantom dispatch");
  } finally {
    await closeEndpoint(endpoint);
  }
});

test("a lost monitor marks the launch failed-uncertain and disables the queue", async (context) => {
  const { endpoint, queue } = await syntheticPromptQueue();
  context.mock.method(server, "address", () => endpoint.address());
  const project = await addProject("dispatch-abandoned", path.join(projectRoot, "dispatch-abandoned"));
  const note = createQuickNote({ projectId: project.id, title: "Watched", content: "Body", harnessId: "pi" });
  setQuickNoteQueue({ enabled: true, maxParallel: 2 });
  try {
    const launch = launchQuickNote(note.id);
    await waitForPrompts(queue);
    queue.accept();
    assert.equal((await launch).status, "started");
    for (const socket of endpoint.clients) socket.close();
    const deadline = Date.now() + 5_000;
    while (getQuickNote(note.id)?.status !== "failed") {
      if (Date.now() > deadline) throw new Error(`abandoned note stayed ${getQuickNote(note.id)?.status}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const abandoned = getQuickNote(note.id)!;
    assert.match(abandoned.error!, /uncertain/i);
    assert.ok(abandoned.sessionId, "the possibly running conversation stays addressable");
    assert.equal(getQuickNoteQueue().enabled, false, "an uncertain outcome disarms the queue");
  } finally {
    setQuickNoteQueue({ enabled: false });
    await closeEndpoint(endpoint);
  }
});

test("secret accounts owned by another project cannot ride a note", async (context) => {
  const { endpoint, queue } = await syntheticPromptQueue();
  context.mock.method(server, "address", () => endpoint.address());
  const owner = await addProject("dispatch-account-owner", path.join(projectRoot, "dispatch-account-owner"));
  const other = await addProject("dispatch-account-other", path.join(projectRoot, "dispatch-account-other"));
  const account = await saveSecretAccount({ label: "Owned account", provider: "custom", projectId: owner.id, variables: [{ name: "OWNED_TOKEN", kind: "value", value: "secret" }] });
  const note = createQuickNote({ projectId: other.id, title: "Borrowed", content: "Body", harnessId: "pi", secretAccountIds: [account.id] });
  try {
    await assert.rejects(launchQuickNote(note.id), (error: unknown) => {
      assert.ok(error instanceof QuickNoteLaunchError);
      assert.equal(error.status, 400);
      assert.match(error.message, /another project/i);
      return true;
    });
    assert.equal(getQuickNote(note.id)?.status, "failed");
    assert.equal(queue.urls.length, 0);
  } finally {
    await closeEndpoint(endpoint);
  }
});

test("peer launches need replicating accounts and respect project locks", async (context) => {
  const { endpoint, queue } = await syntheticPromptQueue();
  context.mock.method(server, "address", () => endpoint.address());
  const project = await addProject("dispatch-peer", path.join(projectRoot, "dispatch-peer"));
  // A fake selected node: one HTTP server for prepare and the /ws upgrade.
  let prepareRequests = 0;
  const peerHttp = createServer((request, response) => {
    prepareRequests += request.url?.includes("/prepare") ? 1 : 0;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(resolve => peerHttp.listen(0, "127.0.0.1", resolve));
  const peerPort = (peerHttp.address() as AddressInfo).port;
  const { saveClusterPeer } = await import("../src/cluster.js");
  const now = new Date().toISOString();
  const peerId = randomUUID();
  await saveClusterPeer({ id: peerId, name: "selected-peer", url: `http://127.0.0.1:${peerPort}`, token: "peer-token", pairedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now });
  const local = await saveSecretAccount({ label: "Local only", provider: "custom", variables: [{ name: "LOCAL_TOKEN", kind: "value", value: "secret" }] });
  try {
    const remote = createQuickNote({ projectId: project.id, title: "Replicate me", content: "Body", harnessId: "pi", nodeId: peerId, secretAccountIds: [local.id] });
    await assert.rejects(launchQuickNote(remote.id), (error: unknown) => {
      assert.ok(error instanceof QuickNoteLaunchError);
      assert.match(error.message, /replicate/i);
      return true;
    });
    assert.equal(prepareRequests, 0, "a non-replicating account must fail before touching the peer");
    assert.equal(getQuickNoteQueue().enabled, false);

    // A project locked by another node never launches, locally or remotely.
    const locks = new DatabaseSync(path.join(process.env.PI_WEB_DATA_DIR!, "node.db"));
    try {
      locks.exec("PRAGMA busy_timeout = 5000");
      locks.prepare("INSERT OR REPLACE INTO project_locks (project_id, node_id, node_name, locked_at, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(project.id, randomUUID(), "Foreign node", new Date().toISOString(), new Date().toISOString(), randomUUID());
    } finally {
      locks.close();
    }
    const locked = createQuickNote({ projectId: project.id, title: "Locked out", content: "Body", harnessId: "pi" });
    await assert.rejects(launchQuickNote(locked.id), (error: unknown) => {
      assert.ok(error instanceof QuickNoteLaunchError);
      assert.equal(error.status, 409);
      assert.match(error.message, /locked by Foreign node/i);
      return true;
    });
    assert.equal(getQuickNote(locked.id)?.status, "failed");
    assert.equal(queue.urls.length, 0);
  } finally {
    await closeEndpoint(endpoint);
    await new Promise<void>(resolve => peerHttp.close(() => resolve()));
  }
});

test("peer preparation refuses projects the selected node has not been granted", async () => {
  await assert.rejects(prepareQuickNoteConversation({ projectId: "never-granted", engine: "pi", sessionId: randomUUID(), title: "Nope" }), /not mapped|not found/i);
});

test("launch claims stay exclusive so dispatch passes cannot overlap on one note", async () => {
  const project = await addProject("dispatch-overlap", path.join(projectRoot, "dispatch-overlap"));
  const note = createQuickNote({ projectId: project.id, title: "Overlap", content: "Body", harnessId: "pi" });
  const claimed = claimQuickNoteForLaunch(note.id, randomUUID(), randomUUID())!;
  assert.equal(claimed.status, "starting");
  assert.equal(claimQuickNoteForLaunch(note.id, randomUUID(), randomUUID()), undefined);
  finishQuickNote(note.id, "failed", "settled");
});

test("the quick note queue default stays disabled on this node", async () => {
  assert.equal(getQuickNoteQueue().enabled, false);
  assert.ok((await getClusterNode()).id);
});
