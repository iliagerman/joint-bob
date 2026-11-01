import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { getClusterNode } from "../../cluster.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import type { GuardianAgentIdentity } from "../../guardian/agent-token.js";
import { checkGuardian } from "../../guardian/check.js";
import { layaStatus, startLayaInstall } from "../../guardian/laya.js";
import { guardianRelayPolicySchema, toolCategory, type GuardianRelayPolicy, type GuardianSettings } from "../../guardian/rules.js";
import { getGuardianSettings, guardianGroups, updateGuardianSettings } from "../../guardian/settings.js";
import { relayServerInstance } from "../../relay/index.js";
import { publishedRelayPolicy, publishRelayPolicy } from "../../relay/resource-policy.js";
import { servingSettings } from "../../relay/store.js";
import { requireAdmin } from "../admin.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

function failed(response: Response, next: NextFunction, error: unknown): void {
  if (error instanceof z.ZodError) { sendError(response, 400, error.issues[0] ? `${error.issues[0].path.join(".")} ${error.issues[0].message}`.trim() : "Invalid Guardian settings"); return; }
  if (error instanceof Error && (error as Error & { status?: number }).status) { sendError(response, (error as Error & { status: number }).status, error.message); return; }
  next(error);
}

/** The rules a relay this machine serves would impose, from this machine's own settings. */
function relayPolicyFrom(settings: GuardianSettings): GuardianRelayPolicy {
  if (settings.model === "laya-local") throw Object.assign(new Error("Relay members cannot reach Laya on this machine. Use Jev or a Laya server address for relay rules."), { status: 409 });
  const rules = settings.rules.filter((rule) => rule.enabled);
  const scripted = rules.find((rule) => rule.fix.kind !== "remove-secrets");
  if (scripted) throw Object.assign(new Error(`The rule "${scripted.name}" fixes with a ${scripted.fix.kind === "script" ? "script" : "helper agent"}. A relay never runs those on its members' machines; use the built-in secret removal.`), { status: 409 });
  if (!rules.length) throw Object.assign(new Error("Turn on at least one rule to enforce it on the relay"), { status: 409 });
  return guardianRelayPolicySchema.parse({ model: settings.model, layaUrl: settings.layaUrl, rules });
}

async function relayView(): Promise<{ serving: boolean; enforced: boolean }> {
  const db = await clusterV2Database();
  if (!servingSettings(db).enabled) return { serving: false, enforced: false };
  return { serving: true, enforced: Boolean(publishedRelayPolicy(db, (await getClusterNode()).id).body.guardian) };
}

/** `policy` undefined republishes from the current settings when the relay already enforces them. */
async function publishGuardianToRelay(policy: GuardianRelayPolicy | null): Promise<void> {
  const db = await clusterV2Database();
  if (!servingSettings(db).enabled) throw Object.assign(new Error("This machine does not serve a relay"), { status: 409 });
  const nodeId = (await getClusterNode()).id;
  const current = publishedRelayPolicy(db, nodeId).body;
  publishRelayPolicy(db, nodeId, current.rules, { settings: current.settings, enabled: current.enabled, skillDigests: current.skillDigests }, undefined, policy);
  relayServerInstance()?.broadcastSkillPolicy();
}

async function guardianView() {
  const groups = await guardianGroups();
  return {
    settings: getGuardianSettings(),
    relays: groups.filter((group) => group.relay).map(({ source, model, rules }) => ({ source, model, rules })),
    relay: await relayView(),
    laya: await layaStatus(),
  };
}

app.get("/api/guardian", requireAdmin, async (_request, response, next) => {
  try { response.json(await guardianView()); } catch (error) { failed(response, next, error); }
});

app.put("/api/guardian", requireAdmin, async (request, response, next) => {
  try {
    const { settings } = z.object({ settings: z.unknown() }).strict().parse(request.body);
    const saved = updateGuardianSettings(settings);
    // A relay that enforces this machine's rules gets the new version at once.
    if ((await relayView()).enforced) await publishGuardianToRelay(relayPolicyFrom(saved));
    response.json(await guardianView());
  } catch (error) { failed(response, next, error); }
});

app.put("/api/guardian/relay-policy", requireAdmin, async (request, response, next) => {
  try {
    const { enforce } = z.object({ enforce: z.boolean() }).strict().parse(request.body);
    await publishGuardianToRelay(enforce ? relayPolicyFrom(getGuardianSettings()) : null);
    response.json(await guardianView());
  } catch (error) { failed(response, next, error); }
});

// Installs Laya in the background; the Classifiers tab polls the status.
app.post("/api/guardian/laya/install", requireAdmin, async (_request, response, next) => {
  try {
    await startLayaInstall();
    response.status(202).json(await layaStatus());
  } catch (error) { failed(response, next, error); }
});

app.get("/api/guardian/laya", requireAdmin, async (_request, response, next) => {
  try { response.json(await layaStatus()); } catch (error) { failed(response, next, error); }
});

const hookRequest = z.object({ tool: z.string().min(1).max(200), input: z.record(z.unknown()) }).strict();

/** The Claude PreToolUse hook. The token names the conversation; the call waits while the person reviews. */
app.post("/api/guardian/agent", async (request, response, next) => {
  const identity = response.locals.guardianAgent as GuardianAgentIdentity | undefined;
  if (!identity) { sendError(response, 401, "Unauthorized"); return; }
  const stopped = new AbortController();
  // Claude ending the hook (the turn was stopped) answers any open review with "block".
  response.on("close", () => stopped.abort());
  try {
    const { tool, input } = hookRequest.parse(request.body);
    const verdict = await checkGuardian({ ...identity, harness: "claude", canReplaceTool: true, signal: stopped.signal }, { kind: "tool", tool, category: toolCategory(tool), input });
    response.json({ verdict });
  } catch (error) { failed(response, next, error); }
});
