import type { HarnessModelSettings } from "../runtime.js";

type RecordValue = Record<string, unknown>;
interface Connection { request(method: string, params: unknown): Promise<unknown> }
interface Choice { value: string; name: string }
interface ConfigOption { id: string; currentValue: string; options: Choice[] }

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Kiro V3 response");
  return value as RecordValue;
}
function choices(value: unknown): Choice[] {
  if (!Array.isArray(value)) throw new Error("Invalid Kiro V3 configuration choices");
  return value.flatMap(item => {
    const choice = record(item);
    if (Array.isArray(choice.options)) return choices(choice.options);
    if (typeof choice.value !== "string" || typeof choice.name !== "string") throw new Error("Invalid Kiro V3 configuration choice");
    return [{ value: choice.value, name: choice.name }];
  });
}
export function kiroV3Configuration(value: unknown): ConfigOption[] {
  if (!Array.isArray(value)) throw new Error("Kiro V3 did not return configuration options");
  return value.flatMap(item => {
    const option = record(item);
    if (option.type !== "select" || !["mode", "model", "effortLevel", "autopilot"].includes(String(option.id))) return [];
    if (typeof option.currentValue !== "string") throw new Error("Invalid Kiro V3 current configuration value");
    return [{ id: String(option.id), currentValue: option.currentValue, options: choices(option.options) }];
  });
}

/** V3 owns model selection and native sessions; no V2 command or filesystem protocol is used. */
export class KiroV3Protocol {
  private readonly extensions: Set<string>;
  constructor(private readonly connection: Connection, capabilities: RecordValue) {
    const methods = (capabilities._meta as { kiro?: { extensionMethods?: unknown } } | undefined)?.kiro?.extensionMethods;
    if (methods !== undefined && (!Array.isArray(methods) || methods.some(method => typeof method !== "string"))) throw new Error("Invalid Kiro V3 extension advertisement");
    this.extensions = new Set(methods as string[] | undefined);
  }

  async open(cwd: string, modeId: string, settings: HarnessModelSettings, nativeSessionId: string | null) {
    const response = record(await this.connection.request(nativeSessionId ? "session/load" : "session/new", {
      ...(nativeSessionId ? { sessionId: nativeSessionId } : {}), cwd, mcpServers: [],
      // The generated profile contains the full refreshed MCP configuration and allowed resources.
      _meta: { kiro: { modeId, effortLevel: settings.reasoning, ...(settings.modelId === "default" ? {} : { modelId: settings.modelId }) } },
    }));
    const sessionId = nativeSessionId ?? response.sessionId;
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Kiro V3 did not return a session ID");
    let config = kiroV3Configuration(response.configOptions);
    const mode = record(response.modes).currentModeId;
    if (mode !== modeId) throw new Error("Kiro V3 did not load the Joint Bob agent profile; refusing inherited resources");
    for (const [id, value] of [["model", settings.modelId], ["effortLevel", settings.reasoning], ["autopilot", "off"]]) {
      if (id === "model" && value === "default") continue;
      const option = config.find(option => option.id === id);
      if (!option || !option.options.some(choice => choice.value === value)) throw new Error(`Kiro V3 does not advertise ${id}=${value} for this account`);
      if (option.currentValue === value) continue;
      const updated = record(await this.connection.request("session/set_config_option", { sessionId, configId: id, value }));
      config = kiroV3Configuration(updated.configOptions);
      if (config.find(option => option.id === id)?.currentValue !== value) throw new Error(`Kiro V3 did not apply ${id}`);
    }
    return { sessionId, config };
  }

  async compact(sessionId: string, instructions?: string): Promise<void> {
    if (!this.extensions.has("_kiro/session/compact")) throw new Error("This Kiro V3 server does not advertise compaction");
    if (instructions?.trim()) throw new Error("Custom compaction instructions are not supported by the Kiro V3 adapter; compact without instructions");
    await this.connection.request("_kiro/session/compact", { sessionId });
  }
}

/** Only host-provided consent capabilities are used, never tool titles or MCP behavior hints. */
export function kiroV3ToolAllowed(request: RecordValue, enabled: string[]): boolean {
  const consent = (request._meta as { kiro?: { consent?: { capability?: unknown; resource?: unknown } } } | undefined)?.kiro?.consent;
  if (!consent || typeof consent.capability !== "string") return false;
  const categories: Record<string, string> = { fs_read: "read", fs_write: "write", shell: "shell", web_fetch: "web", web_search: "web", subagent: "subagent" };
  if (consent.capability === "mcp" && typeof consent.resource === "string") return enabled.includes(`@${consent.resource}`);
  const category = categories[consent.capability];
  return category !== undefined && enabled.includes(category);
}
