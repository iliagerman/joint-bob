import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const managedIgnorePatterns = [
  ".git",
  ".git/**",
  "**/.git",
  "**/.git/**",
  "node_modules/",
  "node_modules/**",
  "**/node_modules",
  "**/node_modules/**",
  ".venv/",
  "venv/",
  "dist/",
  "build/",
  "coverage/",
  "__pycache__/",
  ".DS_Store",
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
  "logs/",
  "**/logs/",
  "*.log",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials.json",
  "service-account*.json",
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
        response.end(JSON.stringify({ ignore: ["secrets/", "*.pem", ".git", "secrets/"] }));
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

test("Syncthing treats a null ignore list as empty", async () => {
  let postedIgnore: string[] | undefined;
  await withSyncthingApi((request, response) => {
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
  }, async (syncthing) => {
    await syncthing.reconcileSyncthingProjectFolders([{ syncFolderId: "demo" }]);
  });
  assert.deepEqual(postedIgnore, managedIgnorePatterns);
});

test("Syncthing reconciliation puts managed ignores before user negations", async () => {
  let ignore = ["!.env", "!**", ...managedIgnorePatterns.slice().reverse()];
  const posts: string[][] = [];
  await withSyncthingApi((request, response) => {
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
  }, async (syncthing) => {
    await syncthing.reconcileSyncthingProjectFolders([{ syncFolderId: "demo" }]);
    await syncthing.reconcileSyncthingProjectFolders([{ syncFolderId: "demo" }]);
  });
  assert.deepEqual(posts, [[...managedIgnorePatterns, "!.env", "!**"]]);
});

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
    await withSyncthingApi((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/rest/db/ignores?folder=demo") {
        response.end(JSON.stringify({ ignore: [] }));
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

test("engine config and session folders are created and shared without credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-engine-sync-"));
  const folders: Array<{ id: string; label: string; path: string; type: string; devices: Array<{ deviceID: string }> }> = [];
  const devices: Array<{ deviceID: string; name: string; addresses: string[] }> = [];
  const ignores = new Map<string, string[]>();
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
      const ignoreFolder = new URL(request.url ?? "", "http://localhost").searchParams.get("folder");
      if (request.method === "GET" && request.url?.startsWith("/rest/db/ignores?") && ignoreFolder) { response.end(JSON.stringify({ ignore: ignores.get(ignoreFolder) ?? [] })); return; }
      if (request.method === "POST" && request.url?.startsWith("/rest/db/ignores?") && ignoreFolder) { ignores.set(ignoreFolder, (JSON.parse(body) as { ignore: string[] }).ignore); response.end("{}"); return; }
      response.statusCode = 404;
      response.end();
    });
  }, async (syncthing) => {
    await syncthing.ensureEngineSyncFolders(root, "NODE-A", "Node A");
  });
  assert.deepEqual(folders.map((folder) => ({ id: folder.id, path: folder.path, devices: folder.devices })), [
    { id: "dot-pi", path: path.join(root, ".pi"), devices: [{ deviceID: "LOCAL" }, { deviceID: "NODE-A" }] },
    { id: "dot-claude", path: path.join(root, ".claude"), devices: [{ deviceID: "LOCAL" }, { deviceID: "NODE-A" }] },
  ]);
  assert.ok(ignores.get("dot-pi")?.includes("/agent/auth.json"));
  assert.ok(ignores.get("dot-pi")?.includes("/agent/models.json"));
  assert.ok(ignores.get("dot-claude")?.includes("/.credentials.json"));
  assert.ok(ignores.get("dot-claude")?.includes("/daemon/"));
  assert.ok(ignores.get("dot-claude")?.includes("/settings.json"));
  assert.ok(ignores.get("dot-claude")?.includes("/.mcp.json"));
  assert.deepEqual(devices, [{ deviceID: "NODE-A", name: "Node A", addresses: ["dynamic"] }]);
  await rm(root, { recursive: true, force: true });
});

test("reconciliation updates ignores for existing synced folders without recreating them", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  await withSyncthingApi((request, response) => {
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
  }, async (syncthing) => {
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
