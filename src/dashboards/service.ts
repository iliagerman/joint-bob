import { multiUserTurnedOn } from "../account-runtime.js";
import { reviewAccountIds } from "../server/git-review-run.js";
import { runtimeForProject } from "../project-runtime.js";
import { agentEnvironment, genericSecretEnvironment, type SecretConversation } from "../secrets.js";
import { getSettings } from "../settings.js";
import { runDashboardAgentTurn } from "./agent-turn.js";
import { runAiRefresh } from "./ai-run.js";
import { buildCreatorInstructions } from "./creator-prompt.js";
import type { DashboardManifest } from "./contract.js";
import type { EntityContext } from "./entity.js";
import {
  appendCreatorMessage, checkDraft, draftDirectory, draftExists, prepareDraft, readCreatorMessages, readDraftFiles,
  readLiveDefinition, stateDirectory, type PayloadTarget,
} from "./files.js";
import { runScriptRefresh, type RefreshResult } from "./script-run.js";
import { recordRefresh, type DashboardRecord } from "./store.js";

// Building a dashboard can mean exploring a database and testing a script several times.
const CREATOR_TURN_TIMEOUT_MS = 30 * 60_000;

export class DashboardBusyError extends Error {
  readonly expose = true;
  readonly status = 409;
}

interface RunActivity { tool: string; target?: string; at: string }
/** A job and what it has done so far: the agent's tool steps and its answer as it writes it. */
interface Run { kind: "creator" | "refresh"; target?: PayloadTarget; startedAt: string; step?: string; activity: RunActivity[]; text: string; controller: AbortController }
// What the view shows of a long turn: the latest steps and the end of the answer so far.
const ACTIVITY_SHOWN = 40;
const TEXT_SHOWN = 6000;
const running = new Map<string, Run>();
/** The last test refresh of a draft; the live refresh is kept on the record. */
const draftRefreshes = new Map<string, { at: string; ok: boolean; error: string | null }>();

/**
 * On a multi-user node a person's agents and scripts must run as their own OS account, and the
 * dashboard's files would have to be reachable from it. Until that exists, nothing runs here.
 */
function assertSingleUserNode(): void {
  if (multiUserTurnedOn()) throw Object.assign(new Error("Dashboards cannot run agents or scripts on a multi-user node yet"), { expose: true, status: 409 });
}

export function runningState(id: string): Omit<Run, "controller"> | null {
  const run = running.get(id);
  if (!run) return null;
  return {
    kind: run.kind, startedAt: run.startedAt, ...(run.target ? { target: run.target } : {}), ...(run.step ? { step: run.step } : {}),
    activity: run.activity.slice(-ACTIVITY_SHOWN), text: run.text.slice(-TEXT_SHOWN),
  };
}

function recordActivity(run: Run, tool: string, target?: string): void {
  run.activity.push({ tool, ...(target ? { target } : {}), at: new Date().toISOString() });
  if (run.activity.length > ACTIVITY_SHOWN) run.activity.splice(0, run.activity.length - ACTIVITY_SHOWN);
  run.step = target ? `${tool}: ${target}` : tool;
}

export function lastDraftRefresh(id: string) {
  return draftRefreshes.get(id) ?? null;
}

export function forgetDraftRefresh(id: string): void {
  draftRefreshes.delete(id);
}

/** One job per dashboard at a time; the job runs after the request has been answered. */
function startJob(id: string, run: Pick<Run, "kind" | "target">, work: (run: Run) => Promise<void>): void {
  if (running.has(id)) throw new DashboardBusyError("The dashboard is already working; wait for it to finish");
  const job: Run = { ...run, startedAt: new Date().toISOString(), activity: [], text: "", controller: new AbortController() };
  running.set(id, job);
  void work(job).catch((error: unknown) => console.warn(`Dashboard ${id} job failed`, error)).finally(() => running.delete(id));
}

export function stopJob(id: string): void {
  running.get(id)?.controller.abort();
}

function secretConversation(context: EntityContext): SecretConversation | undefined {
  return context.conversation ? { engine: context.conversation.engine, sessionId: context.conversation.sessionId } : undefined;
}

function secretNames(context: EntityContext): string[] {
  return Object.keys(genericSecretEnvironment(context.project.id, secretConversation(context))).sort();
}

/** What the creator agent is told about its conversation, project or workspace. */
export function levelContext(context: EntityContext): string {
  const lines: string[] = [];
  if (context.conversation) {
    lines.push(`Conversation "${context.conversation.title}" in project "${context.project.name}".`, `Transcript: ${context.conversation.transcriptPath}`);
  }
  if (context.workspace) {
    lines.push(`Workspace "${context.workspace.label}". Its projects:`, ...context.workspace.projects.map((project) => `- ${project.name}: ${project.path}`));
    lines.push(`The dashboard runs in the workspace's project "${context.project.name}".`);
  }
  lines.push(`Project "${context.project.name}" at ${context.project.path}.`);
  const names = secretNames(context);
  lines.push(names.length ? `Secret variables available to you and to the refresh script (names only): ${names.join(", ")}.` : "No secret accounts are attached.");
  return lines.join("\n");
}

function creatorPrompt(record: DashboardRecord, context: EntityContext, text: string): string {
  const history = readCreatorMessages(record.id).slice(0, -1).map(({ role, text: said }) => ({ role, text: said }));
  const files = readDraftFiles(record.id).map((file) => `${file.path} (${file.content.length} bytes)`);
  return [
    buildCreatorInstructions({
      level: record.entity.kind, context: levelContext(context), draftDirectory: draftDirectory(record.id),
      stateDirectory: stateDirectory(record.id), workingDirectory: context.project.path,
    }),
    "## Draft files now",
    files.length ? files.join("\n") : "(empty: this is a new dashboard)",
    "## Earlier messages about this dashboard",
    history.length ? JSON.stringify(history) : "(none)",
    "## The person's request",
    text,
  ].join("\n\n");
}

async function creatorTurn(record: DashboardRecord, context: EntityContext, text: string, run: Run): Promise<void> {
  try {
    const answer = await runDashboardAgentTurn({
      projectId: context.project.id, cwd: context.project.path, settings: getSettings().dashboards,
      prompt: creatorPrompt(record, context, text), timeoutMs: CREATOR_TURN_TIMEOUT_MS, signal: run.controller.signal,
      onActivity: ({ tool, target }) => recordActivity(run, tool, target),
      onText: (soFar) => { run.text = soFar; },
      ...(context.conversation ? { conversationId: context.entity.id, accountIds: await reviewAccountIds(context.project.id, context.entity.id) } : {}),
    });
    const check = checkDraft(record.id);
    appendCreatorMessage(record.id, { role: "assistant", text: check.ok ? answer : `${answer}\n\nThe draft cannot be saved yet: ${check.error}` });
    // A finished script draft shows real data at once; an AI refresh costs money, so it waits for the person.
    if (check.ok && check.manifest.refresh.method === "script") await testDraft(record, context, run);
  } catch (error) {
    appendCreatorMessage(record.id, { role: "assistant", text: `The dashboard agent stopped: ${(error as Error).message}` });
  }
}

async function testDraft(record: DashboardRecord, context: EntityContext, run: Run): Promise<void> {
  recordActivity(run, "Test refresh", "the draft's script");
  const result = await refreshOnce(record, context, "draft", definitionFor(record, "draft"), run)
    .catch((error: unknown) => ({ ok: false as const, error: (error as Error).message }));
  draftRefreshes.set(record.id, { at: new Date().toISOString(), ok: result.ok, error: result.ok ? null : result.error });
}

/** Sends the person's request to the dashboard agent, who edits the draft. */
export function startCreatorTurn(record: DashboardRecord, context: EntityContext, text: string): void {
  assertSingleUserNode();
  if (running.has(record.id)) throw new DashboardBusyError("The dashboard is already working; wait for it to finish");
  prepareDraft(record.id);
  appendCreatorMessage(record.id, { role: "user", text });
  startJob(record.id, { kind: "creator" }, (run) => creatorTurn(record, context, text, run));
}

function definitionFor(record: DashboardRecord, target: PayloadTarget): { manifest: DashboardManifest; directory: string } {
  if (target === "draft") {
    const check = checkDraft(record.id);
    if (!check.ok) throw Object.assign(new Error(check.error), { expose: true, status: 409 });
    return { manifest: check.manifest, directory: draftDirectory(record.id) };
  }
  const live = readLiveDefinition(record.id);
  if (!live) throw Object.assign(new Error("Save the dashboard before refreshing it"), { expose: true, status: 409 });
  // Only the exact files that were approved may run here.
  if (live.digest !== record.approvedDigest) throw Object.assign(new Error("Approve this dashboard before it runs on this node"), { expose: true, status: 403 });
  return { manifest: live.manifest, directory: live.directory };
}

async function refreshOnce(record: DashboardRecord, context: EntityContext, target: PayloadTarget, definition: ReturnType<typeof definitionFor>, run: Run): Promise<RefreshResult> {
  const conversation = secretConversation(context);
  if (definition.manifest.refresh.method === "script") {
    return runScriptRefresh({
      id: record.id, command: definition.manifest.refresh.command, cwd: context.project.path, definitionDirectory: definition.directory, target,
      env: { ...process.env, ...agentEnvironment(context.project.id, conversation) }, runtime: await runtimeForProject(context.project.id),
    });
  }
  return runAiRefresh({
    id: record.id, prompt: definition.manifest.refresh.prompt, projectId: context.project.id, cwd: context.project.path,
    settings: getSettings().dashboards, signal: run.controller.signal, target,
    ...(context.conversation ? { conversationId: context.entity.id, accountIds: await reviewAccountIds(context.project.id, context.entity.id) } : {}),
  });
}

/** Refreshes once, now. A received dashboard runs only when its current definition is approved. */
export function startRefresh(record: DashboardRecord, context: EntityContext, target: PayloadTarget, afterPublish?: () => Promise<void>): void {
  assertSingleUserNode();
  if (target === "live" && record.approvedDigest !== record.definitionDigest) {
    throw Object.assign(new Error("Approve this dashboard before it runs on this node"), { expose: true, status: 403 });
  }
  if (target === "draft" && !draftExists(record.id)) throw Object.assign(new Error("There is no draft to test"), { expose: true, status: 409 });
  const definition = definitionFor(record, target);
  startJob(record.id, { kind: "refresh", target }, async (run) => {
    const result = await refreshOnce(record, context, target, definition, run).catch((error: unknown) => ({ ok: false as const, error: (error as Error).message }));
    const outcome = { at: new Date().toISOString(), ok: result.ok, error: result.ok ? null : result.error };
    if (target === "live") {
      recordRefresh(record.id, outcome);
      if (outcome.ok && record.origin === "own" && !definition.manifest.requiresCredentials) await afterPublish?.();
    } else draftRefreshes.set(record.id, outcome);
  });
}
