import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const managedIgnorePatterns = [
  ".git",
  ".git/**",
  "**/.git",
  "**/.git/**",
  "(?d)node_modules/",
  "(?d)node_modules/**",
  "(?d)**/node_modules",
  "(?d)**/node_modules/**",
  "(?d).venv/",
  "(?d)venv/",
  "(?d)dist/",
  "(?d)build/",
  "(?d)coverage/",
  "(?d)test-results/",
  "(?d)**/test-results/",
  "(?d)playwright-report/",
  "(?d)**/playwright-report/",
  "(?d).pytest_cache/",
  "(?d)**/.pytest_cache/",
  "(?d).mypy_cache/",
  "(?d)**/.mypy_cache/",
  "(?d).ruff_cache/",
  "(?d)**/.ruff_cache/",
  "(?d)__pycache__/",
  "(?d).DS_Store",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  ".joint-bob/",
  "**/.joint-bob/",
  ".pi-mobile-web/",
  "**/.pi-mobile-web/",
  "(?d).dev-env/",
  "(?d)**/.dev-env/",
  "(?d)aidlc/.aidlc-*",
  "(?d)**/aidlc/.aidlc-*",
  "(?d)aidlc/spaces/*/intents/.aidlc-*",
  "(?d)**/aidlc/spaces/*/intents/.aidlc-*",
  "(?d)aidlc/spaces/*/intents/*/.aidlc-*",
  "(?d)**/aidlc/spaces/*/intents/*/.aidlc-*",
  "(?d)logs/",
  "(?d)**/logs/",
  "(?d)*.log",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials.json",
  "service-account*.json",
  "(?d)test_database_*.db",
  "(?d)**/test_database_*.db",
];

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

test("Syncthing config discovery reads the actual localhost GUI address", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-bob-syncthing-"));
  try {
    const configPath = path.join(root, "config.xml");
    await writeFile(configPath, `<configuration><gui enabled="true" tls="false"><address>127.0.0.1:59936</address><apikey>fixture-key</apikey></gui></configuration>`);
    const syncthing = await import(new URL(`../src/syncthing.ts?discover=${Date.now()}`, import.meta.url).href);

    assert.deepEqual(await syncthing.discoverSyncthingConfig([configPath]), {
      url: "http://127.0.0.1:59936",
      apiKey: "fixture-key",
      configPath,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing Syncthing folder gains every newly paired node device", async () => {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", body: body ? JSON.parse(body) : null });
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/rest/config/folders") {
        response.end(JSON.stringify([{ id: "demo", label: "Demo", path: "/tmp/demo", type: "sendreceive", devices: [{ deviceID: "LOCAL" }, { deviceID: "NODE-A" }] }]));
        return;
      }
      if (request.method === "GET" && request.url === "/rest/system/status") {
        response.end(JSON.stringify({ myID: "LOCAL" }));
        return;
      }
      if (request.method === "GET" && request.url === "/rest/db/ignores?folder=demo") {
        response.end(JSON.stringify({ ignore: ["secrets/", "*.pem", ".git", "__pycache__/", "playwright-report/", "aidlc/.aidlc-*", "secrets/"] }));
        return;
      }
      response.end("{}");
    });
  });
  const port = await listen(server);
  const previousUrl = process.env.PI_MOBILE_WEB_SYNCTHING_URL;
  const previousKey = process.env.PI_MOBILE_WEB_SYNCTHING_API_KEY;
  process.env.PI_MOBILE_WEB_SYNCTHING_URL = `http://127.0.0.1:${port}`;
  process.env.PI_MOBILE_WEB_SYNCTHING_API_KEY = "test-key";
  try {
    const syncthing = await import(new URL(`../src/syncthing.ts?merge=${Date.now()}`, import.meta.url).href);
    await syncthing.ensureSyncthingFolder("demo", "Demo", "/tmp/demo", "NODE-B");

    const update = requests.find((request) => request.method === "PUT" && request.url === "/rest/config/folders/demo");
    assert.ok(update);
    assert.deepEqual((update.body as { devices: Array<{ deviceID: string }> }).devices, [
      { deviceID: "LOCAL" },
      { deviceID: "NODE-A" },
      { deviceID: "NODE-B" },
    ]);
    const ignores = requests.find((request) => request.method === "POST" && request.url === "/rest/db/ignores?folder=demo");
    assert.ok(ignores);
    assert.deepEqual((ignores.body as { ignore: string[] }).ignore, [...managedIgnorePatterns, "secrets/"]);
  } finally {
    if (previousUrl === undefined) delete process.env.PI_MOBILE_WEB_SYNCTHING_URL;
    else process.env.PI_MOBILE_WEB_SYNCTHING_URL = previousUrl;
    if (previousKey === undefined) delete process.env.PI_MOBILE_WEB_SYNCTHING_API_KEY;
    else process.env.PI_MOBILE_WEB_SYNCTHING_API_KEY = previousKey;
    server.close();
  }
});

test("an existing Syncthing folder updates when its requested path changes", async () => {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  await withSyncthingApi((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", body: body ? JSON.parse(body) : null });
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/rest/config/folders") {
        response.end(JSON.stringify([{ id: "demo", label: "Demo", path: "/old/demo", type: "sendreceive", devices: [{ deviceID: "LOCAL" }] }]));
        return;
      }
      if (request.method === "GET" && request.url === "/rest/system/status") {
        response.end(JSON.stringify({ myID: "LOCAL" }));
        return;
      }
      if (request.method === "GET" && request.url === "/rest/db/ignores?folder=demo") {
        response.end(JSON.stringify({ ignore: [] }));
        return;
      }
      if (request.method === "POST" && request.url === "/rest/db/ignores?folder=demo") {
        response.end("{}");
        return;
      }
      if (request.method === "PUT" && request.url === "/rest/config/folders/demo") {
        response.end("{}");
        return;
      }
      response.statusCode = 404;
      response.end();
    });
  }, async (syncthing) => {
    await syncthing.ensureSyncthingFolder("demo", "Demo", "/new/demo");
  });

  const update = requests.find((request) => request.method === "PUT" && request.url === "/rest/config/folders/demo");
  assert.ok(update);
  assert.equal((update.body as { path: string }).path, path.resolve("/new/demo"));
  assert.deepEqual((update.body as { devices: Array<{ deviceID: string }> }).devices, [{ deviceID: "LOCAL" }]);
});

test("Syncthing ignores AI-DLC machine-local runtime state", async () => {
  let postedIgnore: string[] | undefined;
  await withSyncthingApi(withConfiguredFolders(["demo"], (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/rest/db/ignores?folder=demo") {
        response.end(JSON.stringify({ ignore: [] }));
        return;
      }
      if (request.method === "POST" && request.url === "/rest/db/ignores?folder=demo") {
        postedIgnore = (JSON.parse(body) as { ignore: string[] }).ignore;
        response.end("{}");
        return;
      }
      response.statusCode = 404;
      response.end();
    });
  }), async (syncthing) => {
    await syncthing.reconcileSyncthingProjectFolders([{ syncFolderId: "demo" }]);
  });
  assert.ok(postedIgnore?.includes("(?d)aidlc/.aidlc-*"), "AI-DLC state must not block a remote folder deletion");
  assert.ok(postedIgnore?.includes("(?d)**/aidlc/spaces/*/intents/*/.aidlc-*"));
  assert.ok(!postedIgnore?.some((rule) => rule === ".aidlc-*" || rule === "**/.aidlc-*"));
});

test("Syncthing ignores the local dev-cluster scratch directory as deletable", async () => {
  let postedIgnore: string[] | undefined;
  await withSyncthingApi(withConfiguredFolders(["demo"], (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/rest/db/ignores?folder=demo") {
        response.end(JSON.stringify({ ignore: [] }));
        return;
      }
      if (request.method === "POST" && request.url === "/rest/db/ignores?folder=demo") {
        postedIgnore = (JSON.parse(body) as { ignore: string[] }).ignore;
        response.end("{}");
        return;
      }
      response.statusCode = 404;
      response.end();
    });
  }), async (syncthing) => {
    await syncthing.reconcileSyncthingProjectFolders([{ syncFolderId: "demo" }]);
  });
  assert.ok(postedIgnore?.includes("(?d).dev-env/"));
  assert.ok(postedIgnore?.includes("(?d)**/.dev-env/"));
});

test("Syncthing treats a null ignore list as empty", async () => {
  let postedIgnore: string[] | undefined;
  await withSyncthingApi(withConfiguredFolders(["demo"], (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/rest/db/ignores?folder=demo") {
        response.end(JSON.stringify({ ignore: null }));
        return;
      }
      if (request.method === "POST" && request.url === "/rest/db/ignores?folder=demo") {
        postedIgnore = (JSON.parse(body) as { ignore: string[] }).ignore;
        response.end("{}");
        return;
      }
      response.statusCode = 404;
      response.end();
    });
  }), async (syncthing) => {
    await syncthing.reconcileSyncthingProjectFolders([{ syncFolderId: "demo" }]);
  });
  assert.deepEqual(postedIgnore, managedIgnorePatterns);
});

test("Syncthing reconciliation puts managed ignores before user negations", async () => {
  let ignore = ["!.env", "!**", ...managedIgnorePatterns.slice().reverse()];
  const posts: string[][] = [];
  await withSyncthingApi(withConfiguredFolders(["demo"], (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/rest/db/ignores?folder=demo") {
        response.end(JSON.stringify({ ignore }));
        return;
      }
      if (request.method === "POST" && request.url === "/rest/db/ignores?folder=demo") {
        ignore = (JSON.parse(body) as { ignore: string[] }).ignore;
        posts.push(ignore);
        response.end("{}");
        return;
      }
      response.statusCode = 404;
      response.end();
    });
  }), async (syncthing) => {
    await syncthing.reconcileSyncthingProjectFolders([{ syncFolderId: "demo" }]);
    await syncthing.reconcileSyncthingProjectFolders([{ syncFolderId: "demo" }]);
  });
  assert.deepEqual(posts, [[...managedIgnorePatterns, "!.env", "!**"]]);
});

/** Lists `folderIds` as configured Syncthing folders, so project reconciliation updates their ignores. */
function withConfiguredFolders(folderIds: string[], handler: RequestListener): RequestListener {
  return (request, response) => {
    if (request.method === "GET" && request.url === "/rest/config/folders") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(folderIds.map((id) => ({ id, label: id, path: `/tmp/${id}`, type: "sendreceive", devices: [] }))));
      return;
    }
    handler(request, response);
  };
}

async function withSyncthingApi(handler: Parameters<typeof createServer>[0], run: (syncthing: typeof import("../src/syncthing.js")) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  const port = await listen(server);
  const previousUrl = process.env.PI_MOBILE_WEB_SYNCTHING_URL;
  const previousKey = process.env.PI_MOBILE_WEB_SYNCTHING_API_KEY;
  process.env.PI_MOBILE_WEB_SYNCTHING_URL = `http://127.0.0.1:${port}`;
  process.env.PI_MOBILE_WEB_SYNCTHING_API_KEY = "test-key";
  try {
    await run(await import(new URL(`../src/syncthing.ts?status=${Date.now()}-${Math.random()}`, import.meta.url).href));
  } finally {
    if (previousUrl === undefined) delete process.env.PI_MOBILE_WEB_SYNCTHING_URL;
    else process.env.PI_MOBILE_WEB_SYNCTHING_URL = previousUrl;
    if (previousKey === undefined) delete process.env.PI_MOBILE_WEB_SYNCTHING_API_KEY;
    else process.env.PI_MOBILE_WEB_SYNCTHING_API_KEY = previousKey;
    server.close();
  }
}

test("Syncthing folder rescan posts the encoded folder ID", async () => {
  let scanRequest: { method?: string; url?: string } | undefined;
  await withSyncthingApi((request, response) => {
    scanRequest = { method: request.method, url: request.url };
    response.end();
  }, async (syncthing) => syncthing.rescanSyncthingFolder("project folder"));
  assert.deepEqual(scanRequest, { method: "POST", url: "/rest/db/scan?folder=project%20folder" });
});

test("leaving a cluster removes peer devices only from Joint Bob folders", async () => {
  const folders = [
    { id: "owned", label: "Owned", path: "/tmp/owned", type: "sendreceive", devices: [{ deviceID: "LOCAL" }, { deviceID: "PEER" }] },
    { id: "unrelated", label: "Unrelated", path: "/tmp/unrelated", type: "sendreceive", devices: [{ deviceID: "LOCAL" }, { deviceID: "PEER" }] },
  ];
  await withSyncthingApi((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/rest/config/folders") { response.end(JSON.stringify(folders)); return; }
    if (request.method === "PUT" && request.url === "/rest/config/folders/owned") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => { folders[0] = JSON.parse(body); response.end("{}"); });
      return;
    }
    response.statusCode = 404;
    response.end();
  }, async (syncthing) => syncthing.removeSyncthingDevices(["PEER"], ["owned"]));
  assert.deepEqual(folders[0].devices, [{ deviceID: "LOCAL" }]);
  assert.deepEqual(folders[1].devices, [{ deviceID: "LOCAL" }, { deviceID: "PEER" }]);
});

test("Syncthing folder statuses report every project sync state", async () => {
  await withSyncthingApi((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/rest/config/folders") {
      response.end(JSON.stringify([
        { id: "synced", label: "Synced", path: "/tmp/synced", type: "sendreceive", devices: [] },
        { id: "syncing", label: "Syncing", path: "/tmp/syncing", type: "sendreceive", devices: [] },
        { id: "paused-config", label: "Paused config", path: "/tmp/paused-config", type: "sendreceive", devices: [], paused: true },
        { id: "paused-state", label: "Paused state", path: "/tmp/paused-state", type: "sendreceive", devices: [] },
        { id: "errored", label: "Errored", path: "/tmp/errored", type: "sendreceive", devices: [] },
      ]));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/rest/db/status?folder=")) {
      const id = new URL(request.url, "http://localhost").searchParams.get("folder");
      const status = id === "syncing"
        ? { state: "scanning", needTotalItems: 2, needBytes: 123 }
        : id === "paused-state"
          ? { state: "paused", needTotalItems: 0, needBytes: 0 }
          : id === "errored"
            ? { state: "error", needTotalItems: 0, needBytes: 0, error: "Insufficient space on disk" }
            : { state: "idle", needTotalItems: 0, needBytes: 0 };
      response.end(JSON.stringify(status));
      return;
    }
    response.statusCode = 404;
    response.end();
  }, async (syncthing) => {
    const statuses = await syncthing.syncthingFolderStatuses(["synced", "syncing", "paused-config", "paused-state", "errored", "missing"]);
    assert.equal(statuses.synced.state, "synced");
    assert.deepEqual(statuses.syncing, { state: "syncing", remainingFiles: 2, remainingBytes: 123, message: "Syncthing is synchronizing this folder" });
    assert.equal(statuses["paused-config"].state, "paused");
    assert.equal(statuses["paused-state"].state, "paused");
    assert.deepEqual(statuses.errored, { state: "error", remainingFiles: 0, remainingBytes: 0, message: "Insufficient space on disk" });
    assert.equal(statuses.missing.state, "error");
  });
});

test("Syncthing folder status is unavailable when configuration cannot be listed", async () => {
  await withSyncthingApi((request, response) => {
    if (request.method === "GET" && request.url === "/rest/config/folders") {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "failed" }));
      return;
    }
    response.statusCode = 404;
    response.end();
  }, async (syncthing) => {
    const statuses = await syncthing.syncthingFolderStatuses(["demo"]);
    assert.equal(statuses.demo.state, "unavailable");
  });
});

test("Syncthing folder readiness requires an idle folder with no outstanding data or errors", async () => {
  const cases: Array<[string, { state: string; needTotalItems: number; needBytes: number; errors?: unknown[] | number } | null, boolean]> = [
    ["idle", { state: "idle", needTotalItems: 0, needBytes: 0 }, true],
    ["scanning", { state: "scanning", needTotalItems: 0, needBytes: 0 }, false],
    ["needed items", { state: "idle", needTotalItems: 1, needBytes: 0 }, false],
    ["needed bytes", { state: "idle", needTotalItems: 0, needBytes: 1 }, false],
    ["errors", { state: "idle", needTotalItems: 0, needBytes: 0, errors: 1 }, false],
    ["request error", null, false],
  ];
  for (const [_name, status, ready] of cases) {
    let ignoreReconciled = false;
    await withSyncthingApi((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/rest/db/ignores?folder=demo") {
        response.end(JSON.stringify({ ignore: [] }));
        return;
      }
      if (request.method === "POST" && request.url === "/rest/db/ignores?folder=demo") {
        ignoreReconciled = true;
        response.end("{}");
        return;
      }
      if (request.url === "/rest/db/status?folder=demo") {
        if (!status) { response.statusCode = 500; response.end(JSON.stringify({ error: "failed" })); return; }
        response.end(JSON.stringify(status));
        return;
      }
      response.statusCode = 404;
      response.end();
    }, async (syncthing) => {
      if (ready) await syncthing.assertSyncthingFolderReady("demo");
      else await assert.rejects(syncthing.assertSyncthingFolderReady("demo"), { message: "Syncthing folder is not synchronized on this node" });
    });
    assert.equal(ignoreReconciled, true);
  }
});

test("ticket workspace folder uses one stable path and gains paired devices", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ticket-sync-"));
  const folders: Array<{ id: string; label: string; path: string; type: string; devices: Array<{ deviceID: string }> }> = [];
  const devices: Array<{ deviceID: string; name: string; addresses: string[] }> = [];
  await withSyncthingApi((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/rest/config/folders") { response.end(JSON.stringify(folders)); return; }
      if (request.method === "GET" && request.url === "/rest/config/devices") { response.end(JSON.stringify(devices)); return; }
      if (request.method === "POST" && request.url === "/rest/config/devices") { devices.push(JSON.parse(body)); response.end("{}"); return; }
      if (request.method === "GET" && request.url === "/rest/system/status") { response.end(JSON.stringify({ myID: "LOCAL" })); return; }
      if (request.method === "POST" && request.url === "/rest/config/folders") { folders.push(JSON.parse(body)); response.end("{}"); return; }
      if (request.method === "PUT" && request.url === "/rest/config/folders/joint-bob-ticket-workspaces") { folders[0] = JSON.parse(body); response.end("{}"); return; }
      if (request.method === "GET" && request.url === "/rest/db/ignores?folder=joint-bob-ticket-workspaces") { response.end(JSON.stringify({ ignore: [] })); return; }
      if (request.method === "POST" && request.url === "/rest/db/ignores?folder=joint-bob-ticket-workspaces") { response.end("{}"); return; }
      response.statusCode = 404;
      response.end();
    });
  }, async (syncthing) => {
    await syncthing.ensureTicketWorkspaceFolder(root, "NODE-A", "Node A");
    await syncthing.ensureTicketWorkspaceFolder(root, "NODE-B", "Node B");
  });
  assert.equal(folders.length, 1);
  assert.equal(folders[0].id, "joint-bob-ticket-workspaces");
  assert.equal(folders[0].path, path.resolve(root));
  assert.deepEqual(folders[0].devices, [{ deviceID: "LOCAL" }, { deviceID: "NODE-A" }, { deviceID: "NODE-B" }]);
  assert.deepEqual(devices, [
    { deviceID: "NODE-A", name: "Node A", addresses: ["dynamic"] },
    { deviceID: "NODE-B", name: "Node B", addresses: ["dynamic"] },
  ]);
  await rm(root, { recursive: true, force: true });
});

test("conversation folders are narrow, shared, unpaused, and have no project ignores", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-conversation-sync-"));
  const folders: any[] = [
    { id: "ordinary", label: "Ordinary", path: "/ordinary", type: "sendreceive", paused: true, devices: [{ deviceID: "LOCAL" }] },
    { id: "joint-bob-conversations-pi", label: "old", path: "/old", type: "sendreceive", paused: true, devices: [{ deviceID: "LOCAL" }] },
  ];
  const requests: string[] = [];
  await withSyncthingApi((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/rest/config/folders") { response.end(JSON.stringify(folders)); return; }
      if (request.method === "GET" && request.url === "/rest/config/devices") { response.end(JSON.stringify([])); return; }
      if (request.method === "POST" && request.url === "/rest/config/devices") { response.end("{}"); return; }
      if (request.method === "GET" && request.url === "/rest/system/status") { response.end(JSON.stringify({ myID: "LOCAL" })); return; }
      if (request.method === "POST" && request.url === "/rest/config/folders") { folders.push(JSON.parse(body)); response.end("{}"); return; }
      if (request.method === "PUT" && request.url?.startsWith("/rest/config/folders/")) { folders[folders.findIndex((folder) => folder.id === JSON.parse(body).id)] = JSON.parse(body); response.end("{}"); return; }
      if (request.method === "GET" && request.url === "/rest/db/ignores?folder=ordinary") { response.end(JSON.stringify({ ignore: [] })); return; }
      if (request.method === "POST" && request.url === "/rest/db/ignores?folder=ordinary") { response.end("{}"); return; }
      response.statusCode = 404; response.end();
    });
  }, async (syncthing) => {
    await syncthing.ensureSyncthingFolder("ordinary", "Ordinary", "/ordinary");
    await syncthing.ensureConversationSyncFolders([
      { id: "joint-bob-conversations-pi", label: "Pi conversations", path: path.join(root, "pi") },
      { id: "joint-bob-conversations-claude", label: "Claude conversations", path: path.join(root, "claude") },
    ], "PEER", "Peer");
  });
  assert.deepEqual(folders.map((folder) => folder.id).sort(), ["joint-bob-conversations-claude", "joint-bob-conversations-pi", "ordinary"]);
  assert.equal(folders.find((folder) => folder.id === "ordinary")?.paused, true);
  assert.ok(folders.filter((folder) => folder.id !== "ordinary").every((folder) => !folder.paused && folder.devices.some((device: { deviceID: string }) => device.deviceID === "LOCAL") && folder.devices.some((device: { deviceID: string }) => device.deviceID === "PEER")));
  assert.ok(!requests.some((request) => request.includes("/rest/db/ignores?folder=joint-bob-conversations")));
  await rm(root, { recursive: true, force: true });
});

test("existing engine folders are paused without creating or sharing them", async () => {
  const folders = [
    { id: "dot-pi", label: "Pi", path: "/home/test/.pi", type: "sendreceive", devices: [{ deviceID: "LOCAL" }, { deviceID: "NODE-A" }], markerName: ".stfolder" },
    { id: "dot-claude", label: "Claude", path: "/home/test/.claude", type: "sendreceive", devices: [{ deviceID: "LOCAL" }], paused: true },
    { id: "unrelated", label: "Unrelated", path: "/tmp/unrelated", type: "sendreceive", devices: [{ deviceID: "LOCAL" }] },
  ];
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  await withSyncthingApi((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", body: body ? JSON.parse(body) : null });
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/rest/config/folders") { response.end(JSON.stringify(folders)); return; }
      if (request.method === "PUT" && request.url === "/rest/config/folders/dot-pi") { folders[0] = JSON.parse(body); response.end("{}"); return; }
      response.statusCode = 404;
      response.end();
    });
  }, async (syncthing) => {
    await syncthing.pauseEngineSyncFolders();
  });
  const updates = requests.filter((request) => request.method === "PUT");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].url, "/rest/config/folders/dot-pi");
  assert.deepEqual(updates[0].body, { ...folders[0], paused: true });
  assert.equal(folders.find((folder) => folder.id === "dot-pi")?.paused, true);
  assert.equal(requests.filter((request) => request.method === "POST" && request.url === "/rest/config/folders").length, 0);
  assert.equal(requests.filter((request) => request.url === "/rest/config/devices").length, 0);
  assert.equal(requests.filter((request) => request.method === "PUT" && request.url !== "/rest/config/folders/dot-pi").length, 0);
});

test("reconciliation updates ignores for existing synced folders without recreating them", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  await withSyncthingApi(withConfiguredFolders(["folder-a", "folder-b"], (request, response) => {
    requests.push({ method: request.method ?? "", url: request.url ?? "" });
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url?.startsWith("/rest/db/ignores?folder=")) {
      response.end(JSON.stringify({ ignore: [] }));
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/rest/db/ignores?folder=")) {
      response.end("{}");
      return;
    }
    response.statusCode = 404;
    response.end();
  }), async (syncthing) => {
    await syncthing.reconcileSyncthingProjectFolders([
      { syncFolderId: "folder-a" },
      { syncFolderId: "folder-b" },
      { syncFolderId: "folder-a" },
      {},
    ]);
  });
  assert.deepEqual([...requests].sort((left, right) => left.url.localeCompare(right.url) || left.method.localeCompare(right.method)), [
    { method: "GET", url: "/rest/db/ignores?folder=folder-a" },
    { method: "POST", url: "/rest/db/ignores?folder=folder-a" },
    { method: "GET", url: "/rest/db/ignores?folder=folder-b" },
    { method: "POST", url: "/rest/db/ignores?folder=folder-b" },
  ]);
});

test("reconciliation skips a project folder Syncthing does not have instead of failing", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  await withSyncthingApi(withConfiguredFolders(["folder-a"], (request, response) => {
    requests.push({ method: request.method ?? "", url: request.url ?? "" });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/rest/db/ignores?folder=folder-a") {
      response.end(request.method === "GET" ? JSON.stringify({ ignore: [] }) : "{}");
      return;
    }
    // Syncthing answers 500 when ignores are posted for an unknown folder.
    response.statusCode = 500;
    response.end("folder does not exist");
  }), async (syncthing) => {
    await syncthing.reconcileSyncthingProjectFolders([{ syncFolderId: "folder-a" }, { syncFolderId: "never-created" }]);
  });
  assert.deepEqual(requests.map((request) => request.url).filter((url) => url.includes("never-created")), [], "a missing folder is left to the sync check");
  assert.ok(requests.some((request) => request.method === "POST" && request.url === "/rest/db/ignores?folder=folder-a"), "configured folders still get their ignores");
});

test("agent resources folder is shared unpaused with resource ignores", async () => {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const resourcePath = path.join(os.tmpdir(), "agent-resources");
  await withSyncthingApi((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", body: body ? JSON.parse(body) : null });
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/rest/config/devices") { response.end(JSON.stringify([{ deviceID: "LOCAL" }])); return; }
      if (request.method === "POST" && request.url === "/rest/config/devices") { response.end("{}"); return; }
      if (request.method === "GET" && request.url === "/rest/config/folders") { response.end(JSON.stringify([])); return; }
      if (request.method === "GET" && request.url === "/rest/system/status") { response.end(JSON.stringify({ myID: "LOCAL" })); return; }
      if (request.method === "POST" && request.url === "/rest/config/folders") { response.end("{}"); return; }
      if (request.method === "GET" && request.url === "/rest/db/ignores?folder=joint-bob-agent-resources") { response.end(JSON.stringify({ ignore: ["!.env"] })); return; }
      if (request.method === "POST" && request.url === "/rest/db/ignores?folder=joint-bob-agent-resources") { response.end("{}"); return; }
      response.statusCode = 404;
      response.end();
    });
  }, async (syncthing) => {
    await syncthing.ensureAgentResourcesFolder(resourcePath, "PEER", "Peer");
  });

  const folder = requests.find((request) => request.method === "POST" && request.url === "/rest/config/folders");
  assert.ok(folder);
  assert.deepEqual(folder.body, {
    id: "joint-bob-agent-resources",
    label: "Joint Bob agent resources",
    path: path.resolve(resourcePath),
    type: "sendreceive",
    markerName: ".stfolder",
    devices: [{ deviceID: "LOCAL" }, { deviceID: "PEER" }],
  });
  const ignores = requests.find((request) => request.method === "POST" && request.url === "/rest/db/ignores?folder=joint-bob-agent-resources");
  assert.ok(ignores);
  const ignore = (ignores.body as { ignore: string[] }).ignore;
  assert.ok(ignore.includes(".env"));
  assert.ok(ignore.includes("(?d)node_modules/"));
  assert.ok(ignore.includes(".env") && !ignore.includes("(?d).env"), "secrets are never deletable");
  assert.ok(ignore.includes("*.sync-conflict-*"));
  assert.ok(!ignore.includes("!.env"));
});

test("a new worktree folder pulls smallest files first; a project folder keeps Syncthing's default", async () => {
  const folders: Array<{ id: string; order?: string }> = [];
  await withSyncthingApi((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/rest/config/folders") { response.end(JSON.stringify(folders)); return; }
      if (request.method === "GET" && request.url === "/rest/system/status") { response.end(JSON.stringify({ myID: "LOCAL" })); return; }
      if (request.method === "POST" && request.url === "/rest/config/folders") { folders.push(JSON.parse(body)); response.end("{}"); return; }
      if (request.url?.startsWith("/rest/db/ignores?")) { response.end(request.method === "GET" ? JSON.stringify({ ignore: [] }) : "{}"); return; }
      response.statusCode = 404;
      response.end();
    });
  }, async (syncthing) => {
    await syncthing.ensureSharedProjectFolder("joint-bob-worktrees-abc", "Demo worktrees", "/tmp/worktrees/abc", "NODE-B");
    await syncthing.ensureSharedProjectFolder("demo", "Demo", "/tmp/demo", "NODE-B");
  });
  assert.deepEqual(folders.map((folder) => [folder.id, folder.order]), [["joint-bob-worktrees-abc", "smallestFirst"], ["demo", undefined]]);
});

test("worktree folders get deletable ignore rules that keep heavy trees and binaries out", async () => {
  const posted: string[][] = [];
  const updated: Array<{ id: string; order?: string; devices: unknown[] }> = [];
  const folder = "joint-bob-worktrees-0123";
  await withSyncthingApi(withConfiguredFolders([folder], (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === `/rest/db/ignores?folder=${folder}`) {
        response.end(JSON.stringify({ ignore: [...managedIgnorePatterns, "keep-me/"] }));
        return;
      }
      if (request.method === "POST" && request.url === `/rest/db/ignores?folder=${folder}`) {
        posted.push((JSON.parse(body) as { ignore: string[] }).ignore);
        response.end("{}");
        return;
      }
      if (request.method === "PUT" && request.url === `/rest/config/folders/${folder}`) {
        updated.push(JSON.parse(body));
        response.end("{}");
        return;
      }
      response.statusCode = 404;
      response.end();
    });
  }), async (syncthing) => {
    await syncthing.reconcileSyncthingProjectFolders([{ syncFolderId: folder }]);
  });
  assert.deepEqual(updated.map((entry) => [entry.id, entry.order]), [[folder, "smallestFirst"]], "metadata and conversation markers arrive before the bulk copy");
  const ignore = posted[0];
  assert.ok(ignore, "worktree ignores must be written");
  const managed = ignore.filter((rule) => rule !== "keep-me/");
  assert.ok(managed.every((rule) => rule.startsWith("(?d)")), "every managed worktree rule is deletable so a worktree deletion reaches every node");
  for (const rule of ["(?d).git", "(?d)node_modules/", "(?d).env", "(?d)target", "(?d).next", "(?d)vendor", "(?d)*.egg-info", "(?d)(?i)*.png", "(?d)(?i)*.zip"]) assert.ok(ignore.includes(rule), rule);
  assert.ok(!ignore.includes("(?d).joint-bob-worktree"), "worktree metadata must sync");
  assert.ok(!ignore.some((rule) => rule.includes(".joint-bob-baseline")), "the merge baseline must sync");
  assert.equal(ignore.at(-1), "keep-me/", "user rules survive after the managed rules");
  assert.ok(!managedIgnorePatterns.filter((rule) => !rule.startsWith("(?d)")).some((rule) => ignore.includes(rule)), "project rules are replaced, not duplicated");
});
