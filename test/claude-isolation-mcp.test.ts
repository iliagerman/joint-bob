import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeEnterpriseMcpPath, claudeResourceIsolationArgs } from "../src/harnesses/claude/resources.js";
import { getSettings } from "../src/settings.js";
import { listMcpServers, shareMcpServers } from "../src/resource-inventory.js";

const root = path.join(os.homedir(), "claude-mcp-isolation");
const project = path.join(root, "project");
function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}
function supplied(args: string[]): Record<string, any> {
  const index = args.indexOf("--mcp-config");
  return index < 0 ? {} : JSON.parse(fs.readFileSync(args[index + 1], "utf8")).mcpServers;
}
test.before(() => fs.mkdirSync(project, { recursive: true }));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("only explicit local approvals promote project MCP; rejection and disable always win", (t) => {
  t.mock.method(childProcess, "spawnSync", () => ({ status: 1, signal: null }));
  write(path.join(project, ".mcp.json"), { mcpServers: Object.fromEntries(["approved", "pending", "rejected", "disabled"].map((name) => [name, { command: name }])) });
  write(path.join(project, ".claude/settings.json"), { enableAllProjectMcpServers: true });
  assert.deepEqual(supplied(claudeResourceIsolationArgs(project, [])), {});
  write(path.join(project, ".claude/settings.local.json"), { enabledMcpjsonServers: ["approved", "rejected", "disabled"], disabledMcpjsonServers: ["rejected"] });
  const config = path.join(getSettings().claude.configPath, ".claude.json");
  write(config, { projects: { [project]: { disabledMcpServers: ["disabled"] } } });
  try {
    assert.deepEqual(Object.keys(supplied(claudeResourceIsolationArgs(project, []))), ["approved"]);
    write(path.join(project, ".claude/settings.local.json"), { enableAllProjectMcpServers: true, disabledMcpjsonServers: ["rejected"] });
    assert.deepEqual(Object.keys(supplied(claudeResourceIsolationArgs(project, []))), ["approved", "pending"]);
    t.mock.method(childProcess, "spawnSync", () => ({ status: 0, signal: null }));
    assert.deepEqual(supplied(claudeResourceIsolationArgs(project, [])), {}, "tracked local settings cannot approve executables");
    t.mock.method(childProcess, "spawnSync", () => ({ status: 128, signal: null }));
    assert.deepEqual(supplied(claudeResourceIsolationArgs(project, [])), {}, "indeterminate local settings cannot approve executables");
    const userSettings = path.join(getSettings().claude.configPath, "settings.json");
    write(userSettings, { enabledMcpjsonServers: ["approved", "rejected"] });
    try { assert.deepEqual(Object.keys(supplied(claudeResourceIsolationArgs(project, []))), ["approved"]); }
    finally { fs.rmSync(userSettings); }
  } finally { fs.rmSync(config); fs.rmSync(path.join(project, ".claude"), { recursive: true }); fs.rmSync(path.join(project, ".mcp.json")); }
});

test("managed plugin MCP retains namespace, paths, environment expansion and inventory", async () => {
  const plugin = path.join(root, "managed/claude/plugins/tools");
  write(path.join(plugin, ".claude-plugin/plugin.json"), { name: "tools", mcpServers: "extra.json" });
  write(path.join(plugin, ".mcp.json"), { mcpServers: { local: { command: "${CLAUDE_PLUGIN_ROOT}/server", args: ["${CLAUDE_PROJECT_DIR}", "${TOKEN:-fallback}"], env: { DATA: "${CLAUDE_PLUGIN_DATA}" } } } });
  write(path.join(plugin, "extra.json"), { remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "${TOKEN}" } } });
  const shared = path.join(root, "shared.json");
  write(shared, { mcpServers: { shared: { command: "shared", env: { SYNTHETIC_TOKEN: "synthetic-managed-key" } } } });
  const args = claudeResourceIsolationArgs(project, ["--plugin-dir", plugin, "--mcp-config", shared]);
  assert.equal(args.filter((arg) => arg === "--mcp-config").length, 1);
  assert.equal(args.join(" ").includes("synthetic-managed-key"), false, "MCP credentials must not appear in process arguments");
  const configPath = args[args.indexOf("--mcp-config") + 1];
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600, "generated MCP credentials stay private to this user");
  const servers = supplied(args);
  assert.equal(servers.shared.env.SYNTHETIC_TOKEN, "synthetic-managed-key");
  assert.deepEqual(Object.keys(servers), ["plugin:tools:local", "plugin:tools:remote", "shared"]);
  assert.equal(servers["plugin:tools:local"].command, `${plugin}/server`);
  assert.deepEqual(servers["plugin:tools:local"].args, [project, "${TOKEN:-fallback}"]);
  assert.equal(servers["plugin:tools:local"].env.CLAUDE_PLUGIN_ROOT, plugin);
  assert.equal(servers["plugin:tools:local"].env.DATA, servers["plugin:tools:local"].env.CLAUDE_PLUGIN_DATA);
  assert.equal(servers["plugin:tools:remote"].headers.Authorization, "${TOKEN}");
  const inventory = await listMcpServers(project, path.join(root, "managed"));
  assert.ok(inventory.some((server) => server.name === "plugin:tools:local" && server.enabled));
  assert.ok(inventory.some((server) => server.name === "plugin:tools:remote" && server.enabled));
  assert.deepEqual(await shareMcpServers(path.join(plugin, ".claude-plugin/plugin.json"), ["plugin:tools:remote"], { projectPath: project, resourceRoot: path.join(root, "managed") }), { added: ["plugin:tools:remote"], skipped: [] });
  const config = path.join(getSettings().claude.configPath, ".claude.json");
  write(config, { projects: { [project]: { disabledMcpServers: ["plugin:tools:local"] } } });
  try {
    assert.equal(supplied(claudeResourceIsolationArgs(project, ["--plugin-dir", plugin]))["plugin:tools:local"], undefined);
    assert.equal((await listMcpServers(project, path.join(root, "managed"))).find((server) => server.name === "plugin:tools:local")?.enabled, false);
  } finally { fs.rmSync(config); }
  write(path.join(plugin, "agents/nested/reviewer.md"), "---\nmcpServers: [local]\n---\nReview");
  assert.throws(() => claudeResourceIsolationArgs(project, ["--plugin-dir", plugin]), /agent frontmatter mcpServers/);
  fs.rmSync(path.join(plugin, "agents"), { recursive: true });
  write(path.join(plugin, "extra.json"), { remote: { type: "http", url: "${user_config.url}" } });
  assert.throws(() => claudeResourceIsolationArgs(project, ["--plugin-dir", plugin]), /user_config/);
});

test("strict MCP preserves helper provenance by rejecting plugin and project helpers, not managed dynamic helpers", () => {
  const plugin = path.join(root, "helper-plugin");
  write(path.join(plugin, ".claude-plugin/plugin.json"), { name: "helper" });
  write(path.join(plugin, ".mcp.json"), { mcpServers: { remote: { type: "http", url: "https://example.com/mcp", headersHelper: "./headers.sh" } } });
  assert.throws(() => claudeResourceIsolationArgs(project, ["--plugin-dir", plugin]), /plugin MCP headersHelper/);
  const config = path.join(getSettings().claude.configPath, "settings.json");
  write(config, { enabledMcpjsonServers: ["helper"] });
  write(path.join(project, ".mcp.json"), { mcpServers: { helper: { type: "http", url: "https://example.com/mcp", headersHelper: "./headers.sh" } } });
  try { assert.throws(() => claudeResourceIsolationArgs(project, []), /project MCP headersHelper/); }
  finally { fs.rmSync(config); fs.rmSync(path.join(project, ".mcp.json")); }
  const shared = path.join(root, "shared-helper.json");
  write(shared, { mcpServers: { shared: { type: "http", url: "https://example.com/mcp", headersHelper: "/managed/headers.sh" } } });
  assert.equal(supplied(claudeResourceIsolationArgs(project, ["--mcp-config", shared])).shared.headersHelper, "/managed/headers.sh");
});

test("enterprise MCP keeps native exclusive loading without conflicting flags or dynamic servers", (t) => {
  const policy = claudeEnterpriseMcpPath();
  const exists = fs.existsSync;
  const read = fs.readFileSync;
  const stat = fs.statSync;
  t.mock.method(fs, "existsSync", (file: fs.PathLike) => file === policy || exists(file));
  t.mock.method(fs, "readFileSync", (file: fs.PathOrFileDescriptor, ...args: any[]) => file === policy ? '{"mcpServers":{"admin":{"command":"admin"}}}' : (read as any)(file, ...args));
  t.mock.method(fs, "statSync", (file: fs.PathLike, ...args: any[]) => file === policy ? { isFile: () => true, size: 100 } : (stat as any)(file, ...args));
  const args = claudeResourceIsolationArgs(project, ["--plugin-dir", "/managed/plugin", "--mcp-config", "/managed/mcp.json", "--append-system-prompt-file", "/managed/instructions"]);
  assert.deepEqual(args.slice(0, 3), ["--setting-sources", "", "--settings"]);
  assert.deepEqual(args.slice(4), ["--plugin-dir", "/managed/plugin", "--append-system-prompt-file", "/managed/instructions"]);
  t.mock.method(fs, "readFileSync", (file: fs.PathOrFileDescriptor, ...args: any[]) => file === policy ? '{}' : (read as any)(file, ...args));
  assert.throws(() => claudeResourceIsolationArgs(project, []), /invalid enterprise MCP/);
});
