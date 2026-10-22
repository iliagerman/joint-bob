import { getDifficultyClassifier } from "../classifiers/registry.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { type ConversationDigest, type DigestModel, type DigestSkills, coveredMessages, digestIsStale, digestMaterial, digestMessages, digestPrompt, keptSuggestions, parseDigestReply, saveDigest, storedDigest, turnCount, usedSkills } from "../conversation-digest.js";
import { effectiveSummaryPolicy, type EffectiveSummaryPolicy, nodeSummaryInstructions, summaryWriterLabel } from "../conversation-summary-policy.js";
import { type ConversationModel, routedSummaryModel, type SummaryRun } from "../conversation-summary-routing.js";
import { getHarness } from "../harnesses.js";
import { listDiscoveredHarnesses } from "../harnesses/registry.js";
import { resourceOwner } from "../ownership.js";
import { relaySummaryPolicies } from "../relay/resource-policy.js";
import { activeRoutingConfig, routingConfigDatabase } from "../routing-configs.js";
import { type RoutingMapping } from "../routing-policy.js";
import { resourceInventory } from "../resource-inventory.js";
import { genericSecretEnvironment } from "../secrets.js";
import { getSettings } from "../settings.js";
import { getProject } from "../store.js";
import type { ChatMessage, HarnessId, ProjectRecord } from "../types.js";
import { loadConversationMessages } from "./conversation-turns.js";
import { runGitReview } from "./git-review-run.js";
import { harnessSessions, onConversationMessage, type SharedHarnessSession } from "./harness-sessions.js";
import { iconHarnessId } from "./label-icon.js";
import { send } from "./realtime.js";

export class DigestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Messages often arrive in bursts (an answer, then the turn's end); one write covers them.
const AUTO_DELAY_MS = 2_500;
const CLASSIFIER_INPUT_LIMIT = 8_000;

export async function summaryPolicyNow(): Promise<EffectiveSummaryPolicy> {
  return effectiveSummaryPolicy(relaySummaryPolicies(await clusterV2Database()));
}

/** What the page shows about the policy: when summaries update and who writes them. */
export function summaryPolicyView(policy: EffectiveSummaryPolicy) {
  return { updates: policy.updates, writer: summaryWriterLabel(policy.writer), from: policy.from.kind === "relay" ? `relay ${policy.from.relay}` : "this machine" };
}

function canRunHere(harnessId: string): boolean {
  return listDiscoveredHarnesses().some((adapter) => adapter.id === harnessId && adapter.runtime && getSettings().conversationDefaults[adapter.id]);
}

/** The newest answer that recorded which agent and model wrote it. */
function lastAttribution(messages: ChatMessage[]): ConversationModel | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const attribution = messages[index].role === "assistant" ? messages[index].attribution : undefined;
    if (attribution) return { harnessId: attribution.harnessId, provider: attribution.provider, modelId: attribution.modelId };
  }
  return undefined;
}

/** Asks the project's routing classifier which of its tiers should write this summary. */
async function classifiedRun(project: ProjectRecord, own: ConversationModel, material: string): Promise<SummaryRun | null> {
  try {
    const config = activeRoutingConfig(routingConfigDatabase(), resourceOwner("project", project.id));
    const levels = config?.policy.harnesses[own.harnessId]?.levels;
    const options = Object.entries(levels ?? {})
      .filter((entry): entry is [string, RoutingMapping] => Boolean(entry[1]))
      .map(([level, mapping]) => ({ level: Number(level), description: mapping.description }))
      .sort((left, right) => left.level - right.level);
    if (!config || !options.length) return null;
    const classifier = getDifficultyClassifier(config.policy.classifierId);
    const apiKey = classifier ? genericSecretEnvironment(project.id)[classifier.variableName] : undefined;
    if (!classifier || !apiKey) return null;
    const task = `Task: update a short running summary of a conversation with its newest messages.\n\n${material.slice(-CLASSIFIER_INPUT_LIMIT)}`;
    const classification = await classifier.classify(task, apiKey, { options });
    return routedSummaryModel(levels, classification, config.policy.confidenceThreshold, own, getHarness(own.harnessId as HarnessId).configuration?.fixedProvider);
  } catch (error) {
    console.warn("Summary classification failed", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
    return null;
  }
}

/**
 * Who writes the summary. A fixed writer from Settings or the relay; otherwise the routing
 * classifier's pick when routing is on (automatic), else the conversation's own agent and
 * model at that agent's default effort. A conversation agent that cannot run on this
 * machine falls back to the first one that can; a fixed writer that cannot is an error.
 */
export async function summaryRun(policy: EffectiveSummaryPolicy, project: ProjectRecord, live: ConversationModel | undefined, messages: ChatMessage[], lastHarness: string, material: string): Promise<SummaryRun> {
  const writer = policy.writer;
  if (writer.source === "fixed") {
    if (!canRunHere(writer.harnessId)) throw new DigestError(400, `${writer.harnessId} cannot run on this machine; choose another summary writer in Settings → Conversations`);
    return { harnessId: writer.harnessId, provider: writer.provider ?? "", modelId: writer.modelId, thinkingLevel: writer.thinkingLevel, source: "setting" };
  }
  const own = live ?? lastAttribution(messages) ?? { harnessId: lastHarness };
  if (!canRunHere(own.harnessId)) return { harnessId: iconHarnessId(), provider: "", modelId: "", thinkingLevel: "", source: "fallback" };
  if (writer.source === "automatic") {
    const routed = await classifiedRun(project, own, material);
    if (routed) return routed;
  }
  return { harnessId: own.harnessId, provider: own.provider ?? "", modelId: own.modelId ?? "", thinkingLevel: "", source: "conversation" };
}

async function conversationTranscript(project: ProjectRecord, conversationId: string) {
  try {
    return await loadConversationMessages(project, conversationId);
  } catch (error) {
    throw new DigestError(404, error instanceof Error ? error.message : "Conversation not found");
  }
}

/** The stored summary, how many messages it covers, and whether newer answered messages exist. */
export async function digestState(project: ProjectRecord, conversationId: string): Promise<{ digest: ConversationDigest | null; stale: boolean; turns: number }> {
  const digest = storedDigest(project.id, conversationId) ?? null;
  const said = digestMessages((await conversationTranscript(project, conversationId)).messages);
  return { digest, stale: digestIsStale(digest ?? undefined, said), turns: turnCount(said) };
}

/** The skills the conversation's agent can load in this project, which the writer may suggest. */
async function skillCatalog(project: ProjectRecord, conversationId: string, harnessId: string): Promise<DigestSkills["catalog"]> {
  try {
    const { skills } = await resourceInventory({ projectPath: project.path, projectId: project.id, conversationId });
    const seen = new Set<string>();
    return skills
      .filter((skill) => skill.harnesses.includes(harnessId as HarnessId) && skill.activation?.[harnessId as HarnessId]?.enabled !== false)
      .filter((skill) => !seen.has(skill.name) && Boolean(seen.add(skill.name)))
      .map((skill) => ({ name: skill.name, description: skill.description }));
  } catch (error) {
    console.warn("Summary skill catalog unavailable", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
    return [];
  }
}

async function writeDigest(project: ProjectRecord, conversationId: string, live: ConversationModel | undefined, onWriting: () => void): Promise<ConversationDigest> {
  const { messages, lastHarness } = await conversationTranscript(project, conversationId);
  const said = digestMessages(messages);
  const previous = storedDigest(project.id, conversationId);
  if (!digestIsStale(previous, said)) {
    if (previous) return previous;
    throw new DigestError(409, "Nothing to summarize yet");
  }
  const material = digestMaterial(said, coveredMessages(previous, said));
  onWriting();
  const used = usedSkills(messages);
  const skills: DigestSkills = { catalog: await skillCatalog(project, conversationId, live?.harnessId ?? lastAttribution(messages)?.harnessId ?? lastHarness), used, suggestions: keptSuggestions(previous?.suggestions, used) };
  const instructions = digestPrompt(previous?.summary, skills, nodeSummaryInstructions());
  const run = await summaryRun(await summaryPolicyNow(), project, live, messages, lastHarness, material);
  const model: DigestModel = { harnessId: run.harnessId, provider: run.provider, modelId: run.modelId, source: run.source };
  const override = process.env.JOINT_BOB_DIGEST_GENERATOR;
  let answer: string;
  if (override) {
    answer = await (await import(override) as { default: (input: { instructions: string; material: string; run: SummaryRun }) => Promise<string> }).default({ instructions, material, run });
  } else {
    const result = await runGitReview({
      // The home folder, not the project: project instruction files have no place in a summary.
      projectId: project.id, cwd: getSettings().projects.homePath, harnessId: run.harnessId as HarnessId, provider: run.provider, modelId: run.modelId, thinkingLevel: run.thinkingLevel,
      selection: { scope: "context", label: "conversation messages" }, question: "", diff: material, instructions,
    });
    answer = result.answer;
    model.provider = result.provider;
    model.modelId = result.modelId;
  }
  const reply = parseDigestReply(answer, skills);
  if (!reply.summary) throw new DigestError(502, "The agent returned an empty summary; try again");
  const digest: ConversationDigest = { summary: reply.summary, messages: said.length, turns: turnCount(said), updatedAt: new Date().toISOString(), model, suggestions: reply.suggestions ?? skills.suggestions };
  saveDigest(project.id, conversationId, digest);
  return digest;
}

/** Sends a summary event to every page that has this conversation open on this node. */
function broadcast(projectId: string, conversationId: string, event: Record<string, unknown>): void {
  for (const shared of harnessSessions.values()) {
    if (shared.projectId !== projectId || shared.conversationId !== conversationId) continue;
    for (const client of shared.clients) send(client, { type: "conversationDigest", ...event });
  }
}

const running = new Map<string, Promise<ConversationDigest>>();
const again = new Map<string, ConversationModel | undefined>();

/**
 * Brings a conversation's summary up to date, reading only the messages it has not seen.
 * One write per conversation at a time: a request during a write shares it, and is run
 * once more afterwards so messages that arrived meanwhile are not left out. Open pages
 * hear "writing", then the summary or why it could not be written.
 */
export function requestDigest(project: ProjectRecord, conversationId: string, live?: ConversationModel): Promise<ConversationDigest> {
  const key = `${project.id}:${conversationId}`;
  const current = running.get(key);
  if (current) {
    again.set(key, live ?? again.get(key));
    return current;
  }
  const job = (async () => {
    try {
      const digest = await writeDigest(project, conversationId, live, () => broadcast(project.id, conversationId, { state: "writing" }));
      broadcast(project.id, conversationId, { state: "done", digest });
      return digest;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The summary could not be written";
      if (error instanceof DigestError && error.status === 409) broadcast(project.id, conversationId, { state: "empty" });
      else broadcast(project.id, conversationId, { state: "error", error: message, digest: storedDigest(project.id, conversationId) ?? null });
      throw error;
    }
  })().finally(() => {
    running.delete(key);
    if (!again.has(key)) return;
    const next = again.get(key);
    again.delete(key);
    void requestDigest(project, conversationId, next).catch(() => undefined);
  });
  running.set(key, job);
  return job;
}

export function digestRunning(projectId: string, conversationId: string): boolean {
  return running.has(`${projectId}:${conversationId}`);
}

/** The agent and model a running conversation is configured with right now. */
export function conversationLiveModel(shared: SharedHarnessSession): ConversationModel {
  try {
    const settings = shared.session.settings();
    return { harnessId: shared.engine, provider: settings.provider, modelId: settings.modelId };
  } catch {
    return { harnessId: shared.engine };
  }
}

/** Requests a write in the background, logging rather than throwing. */
export function requestDigestQuietly(project: ProjectRecord, conversationId: string, live?: ConversationModel): void {
  void requestDigest(project, conversationId, live).catch((error) => {
    if (!(error instanceof DigestError)) console.warn("Conversation summary failed", error instanceof Error ? error.message.slice(0, 300) : error);
  });
}

const pendingAuto = new Map<string, NodeJS.Timeout>();

let started = false;

/**
 * Writes summaries after each answer in a conversation this node runs, when the policy says so.
 * Scheduled runs are not summarized. Started with the server rather than on import: this module
 * and the shared sessions import each other, so registering at load time could run too early.
 */
export function startConversationDigests(): void {
  if (started) return;
  started = true;
  onConversationMessage((shared) => {
    if (shared.scheduledTurn) return;
    const key = `${shared.projectId}:${shared.conversationId}`;
    if (pendingAuto.has(key)) return;
    pendingAuto.set(key, setTimeout(() => {
      pendingAuto.delete(key);
      void (async () => {
        if ((await summaryPolicyNow()).updates !== "each-message") return;
        const project = await getProject(shared.projectId);
        if (project) requestDigestQuietly(project, shared.conversationId, conversationLiveModel(shared));
      })().catch((error) => console.warn("Conversation summary scheduling failed", error));
    }, AUTO_DELAY_MS).unref());
  });
}

