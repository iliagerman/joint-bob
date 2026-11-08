import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AuthSession } from "../auth.js";
import { decisionModelTarget } from "../classifiers/conversation-routing.js";
import { askSystemOneChoices } from "../classifiers/typesafe.js";
import { BOB_INSTRUCTIONS, bobContext, bobMaterial } from "../control-center/bob-context.js";
import { appendBobMessage, bobDatabase, listBobMessages, readBobSettings, rememberBobAccount, type BobMessage, type BobSettings } from "../control-center/bob-store.js";
import { actingAccountFromSession, runAsAccount } from "../account-context.js";
import { BobActionError, bobSays, registerBobAction } from "../control-center/bob-actions.js";
import { collectBobContext, notifyBobExchange, type BobTurn } from "../control-center/bob-hooks.js";
import { harnessFromMessage } from "../control-center/harness-override.js";
import { listHarnesses } from "../harnesses.js";
import { listDiscoveredHarnesses } from "../harnesses/registry.js";
import { bobWantsAutoRespond } from "../control-center/auto-respond.js";
import { chooseConversation, decideForBob, needsAgentDecision, type BobDecision, type BobProjectOption } from "../control-center/decisions.js";
import { handleBobMoveRequest } from "../control-center/moves-bob.js";
import { getClusterNode } from "../cluster.js";
import { genericSecretEnvironment } from "../secrets.js";
import type { ProjectRecord } from "../types.js";
import { loadBoard } from "./control-center-board.js";
import { saveBobAttachments, startBobConversation, titleOf, type BobAttachments } from "./control-center-start.js";
import { promptTextWithAttachments } from "./chat.js";
import { handleBobAutomation } from "./control-center-automation-chat.js";
import { handleBobOrganize } from "./control-center-organize.js";
import { askDisplayAgent, type AppearanceContext, type AppearanceSettings } from "./control-center-display.js";
import { bobDashboardRequest } from "./control-center-dashboard-request.js";
import { GitReviewRunError, runGitReview } from "./git-review-run.js";
import { iconHarnessId } from "./label-icon.js";
import { agentFor } from "../background-agent.js";
import { assertProjectEditable, projectsWithSharedNames } from "./projects.js";
import { isLeased } from "../control-center/leases.js";
import { storedDigest } from "../conversation-digest.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { listMoveNodes } from "../control-center/moves-runtime.js";
import { queueConversationPrompt } from "./conversation-prompt.js";
import { sharedProjectSessions } from "./sessions-helpers.js";

export { GitReviewRunError };

const HEADLINES = 5;
const RECENT_CHAT_LINES = 6;

async function projectOptions(projects: ProjectRecord[], session: AuthSession): Promise<BobProjectOption[]> {
  return Promise.all(projects.map(async (project) => {
    const sessions = await sharedProjectSessions(project, session.userId, session.accountId);
    const recent = [...sessions].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, HEADLINES);
    return { id: project.id, name: project.name, headlines: recent.map((entry) => entry.title).filter(Boolean) };
  }));
}

/** The decision model Bob uses: the person's choice of TypeSafe or Laya, with a key from the first project that has one attached. */
export async function bobDecisionModel(projects: ProjectRecord[], settings: BobSettings) {
  const variable = settings.classifier === "typesafe" ? "TYPESAFE_AI_API_KEY" : "LAYA_API_KEY";
  for (const project of projects) {
    const key = genericSecretEnvironment(project.id)[variable] ?? "";
    if (!key && settings.classifier === "typesafe") continue;
    const target = await decisionModelTarget(settings.classifier, key);
    if (target) return target;
  }
  return null;
}

/**
 * A task that belongs to one of the project's recent conversations goes there instead of starting a new one, when the
 * decision model is sure which. Only a conversation this machine runs and the person has not taken over can be continued;
 * the message says why when it cannot, and Bob then starts a new conversation as usual. Null means: start a new one.
 */
async function continueExisting(args: { session: AuthSession; settings: BobSettings; project: ProjectRecord; message: string; attachments: BobAttachments; recentChat: string[]; model: NonNullable<Awaited<ReturnType<typeof bobDecisionModel>>> }): Promise<{ text: string } | { skipped: string } | null> {
  const sessions = (await sharedProjectSessions(args.project, args.session.userId, args.session.accountId))
    .filter((entry) => !entry.readOnly && !entry.draft).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, 8);
  if (!sessions.length) return null;
  const options = sessions.map((entry) => ({ id: entry.conversationId ?? entry.id, title: entry.title, summary: storedDigest(args.project.id, entry.conversationId ?? entry.id)?.summary ?? null }));
  const chosen = await chooseConversation({
    message: args.message, recentChat: args.recentChat, options, stateCharacters: args.model.target.stateCharacters,
    ask: (state, questions) => askSystemOneChoices(args.model.target, state, questions, args.model.apiKey),
  });
  if (!chosen?.conversationId || chosen.confidence < args.settings.threshold) return null;
  const target = sessions.find((entry) => (entry.conversationId ?? entry.id) === chosen.conversationId)!;
  if (target.executionNodeId && target.executionNodeId !== (await getClusterNode()).id) return { skipped: `"${target.title}" runs on another machine, so I started a new conversation instead.` };
  if (isLeased(args.project.id, chosen.conversationId)) return { skipped: `You are in control of "${target.title}", so I started a new conversation instead of interrupting it.` };
  await queueConversationPrompt({ projectId: args.project.id, engine: target.harnessId, sessionId: target.id, message: args.message, ...args.attachments, requestId: randomUUID(), label: "Bob", until: "started" });
  return { text: `Sent to "${target.title}" in ${args.project.name}, since it is the same work.` };
}

/** Auto respond runs where the conversation is owned, so it is turned on only for work that started on this node. Says what happened either way. */

function viaText(reason: string | null, decision: BobDecision | null, projectName: string | null): string {
  if (!decision) return reason === "no-decision-model" ? "No decision model set up, so Bob's agent decided" : "The decision model could not answer, so Bob's agent decided";
  const sure = `${Math.round(decision.confidence * 100)}%`;
  const where = projectName ? ` · ${projectName}` : "";
  return reason === "low-confidence" ? `Decision model ${sure} is under the threshold, so Bob's agent decided` : `Decision model ${sure}${where} · ${decision.kind} · ${decision.size}`;
}

/**
 * Bob's own agent answers from what is running and each project's recent work; with a project in view it can also read that
 * project's files. What the person attached is saved in the project and named in the question, with read-only tools to open it.
 */
export async function answerWithAgent(args: { message: string; attachments: BobAttachments; recentChat: string[]; project: ProjectRecord | undefined; projectChosen: boolean; projects: ProjectRecord[]; options: BobProjectOption[]; settings: BobSettings; session: AuthSession; turn: BobTurn }): Promise<{ text: string; via: string[] }> {
  const { cards } = await loadBoard(args.session);
  if (!args.project) return { text: "There are no projects yet, so there is nothing for me to look at.", via: [] };
  const contributed = await collectBobContext(args.turn);
  const agent = agentFor(args.settings);
  const source = jointBobSource(args.projects);
  // A question about no project in particular is often about Joint Bob itself: Bob runs in its source then, where its docs are.
  const project = args.projectChosen || !source ? args.project : source;
  const saved = await saveBobAttachments(project, args.attachments);
  const message = promptTextWithAttachments(args.message, saved.filter((item) => item.kind === "image"), saved.filter((item) => item.kind === "file"));
  const [machines, local] = await Promise.all([listMoveNodes(), getClusterNode()]);
  const facts = { localNodeId: local.id, machineName: (id: string) => machines.find((machine) => machine.id === id)?.name ?? "another machine", jointBobSource: source ? { name: source.name, path: source.path } : null };
  const result = await runGitReview({
    projectId: project.id, cwd: project.path, ...agent,
    selection: { scope: "context", label: "Bob" }, question: args.message, diff: bobMaterial({ message, recentChat: args.recentChat, context: bobContext(cards, args.options, facts), contributed: contributed.text }),
    images: args.attachments.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })),
    // Read-only tools always: Bob looks things up (a transcript, Joint Bob's docs) to explain them, and can change nothing.
    instructions: BOB_INSTRUCTIONS, readOnlyTools: true,
  });
  return { text: result.answer.trim(), via: contributed.via };
}

/** The person's project that holds Joint Bob's own source: its package is joint-bob and it has the docs. Bob reads it to explain Joint Bob. */
export function jointBobSource(projects: ProjectRecord[]): ProjectRecord | undefined {
  return projects.find((project) => {
    const manifest = path.join(project.path, "package.json");
    if (!existsSync(manifest) || !existsSync(path.join(project.path, "docs"))) return false;
    try { return (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name === "joint-bob"; }
    catch (error) { if (error instanceof SyntaxError) return false; throw error; }
  });
}

interface TaskRun {
  session: AuthSession; settings: BobSettings; project: ProjectRecord; message: string; attachments: BobAttachments; recentChat: string[];
  model: Awaited<ReturnType<typeof bobDecisionModel>>; decision: BobDecision; via: string; turn: BobTurn;
}

/**
 * Work for a project: handed to the conversation it belongs to, when the decision model finds one, or started as a new one with
 * Bob's agent (or the one the message names) and what Bob knows about how the person works. `started` is false when nothing ran.
 */
async function runTask(task: TaskRun): Promise<{ text: string; via: string; started: boolean; sessionId: string | null }> {
  const { session, settings, project, message } = task;
  await assertProjectEditable(project);
  // Bob's own agent, unless the person named another in the message ("do it with Pi").
  const named = harnessFromMessage(message, listHarnesses().map((adapter) => ({ id: adapter.id, label: adapter.label })));
  if (named && !listDiscoveredHarnesses().some((adapter) => adapter.id === named && adapter.runtime)) {
    return { text: `I cannot run ${named} on this machine, so I did not start anything. Say which agent to use, or leave it to me.`, via: task.via, started: false, sessionId: null };
  }
  const harnessId = named ?? (settings.harnessId || iconHarnessId());
  const continued = task.model ? await continueExisting({ session, settings, project, message, attachments: task.attachments, recentChat: task.recentChat, model: task.model }) : null;
  if (continued && "text" in continued) return { text: continued.text, via: task.via, started: true, sessionId: null };
  const skipped = continued && "skipped" in continued ? ` ${continued.skipped}` : "";
  // What Bob knows about how the person works goes into the brief, the way they would write it themselves.
  const known = await collectBobContext(task.turn);
  const brief = known.text ? `${message}\n\n---\nNotes about how I work, kept by my assistant:\n${known.text}` : message;
  const started = await startBobConversation({ session, settings, project, title: titleOf(message), brief, harnessId, autoRespond: bobWantsAutoRespond(settings, task.decision), attachments: task.attachments });
  return {
    text: `Started in ${project.name}. It is on the board now; I'll show what it is doing there.${started.autoRespondNote}${skipped}`,
    via: [task.via, ...known.via].join(" · "), started: true, sessionId: started.sessionId,
  };
}

const START_TASK = "bob.start-task";
const PROJECTS_OFFERED = 4;
const QUOTED = 160;

/** "Which project?" with a button for the likeliest projects (the decision model's guess first, then the most recently worked on) and one for any other. */
function askWhichProject(db: DatabaseSync, session: AuthSession, message: string, decision: BobDecision, options: BobProjectOption[]): BobMessage {
  const ordered = [...options].sort((left, right) => Number(right.id === decision.projectId) - Number(left.id === decision.projectId));
  const quoted = message.length > QUOTED ? `${message.slice(0, QUOTED - 1)}…` : message;
  return appendBobMessage(db, session.accountId, {
    role: "bob", importance: "needs-you", via: `Decision model ${Math.round(decision.kindConfidence * 100)}% · task · project unclear`,
    text: `Which project should I start this in?\n“${quoted}”`,
    actions: [
      // A message's buttons are told apart by id, so each project's button has its own.
      ...ordered.slice(0, PROJECTS_OFFERED).map((option, index) => ({ id: `${START_TASK}.${index}`, label: option.name, data: { projectId: option.id, message, autoRespond: decision.autoRespond } })),
      // Opens the New conversation form in the page, with the request in it: any project, machine and agent.
      { id: "bob.new-conversation", label: "Another project…", data: { create: { content: message } } },
    ],
  });
}

const startTaskData = z.object({ projectId: z.string().min(1), message: z.string().min(1), autoRespond: z.boolean() });

// The person picked the project: the request starts there as if they had named it.
const startChosenTask: Parameters<typeof registerBobAction>[1] = async ({ db, session, action }) => runAsAccount(actingAccountFromSession(session), async () => {
  const { projectId, message, autoRespond } = startTaskData.parse(action.data);
  const settings = readBobSettings(db, session.accountId);
  const projects = await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new BobActionError(404, "That project is not here anymore");
  const options = await projectOptions(projects, session);
  const turn: BobTurn = { session, message, recentChat: [], project: { id: project.id, name: project.name }, options, settings };
  const decision: BobDecision = { kind: "task", size: "long", projectId, autoRespond, confidence: 1, kindConfidence: 1 };
  const done = await runTask({ session, settings, project, message, attachments: { images: [], files: [] }, recentChat: [], model: await bobDecisionModel(projects, settings), decision, via: `You chose ${project.name}`, turn });
  if (done.started) notifyBobExchange(turn, done.text);
  return [bobSays(db, session, done.text, { importance: done.started ? "done" : "fyi", projectId: project.id, projectName: project.name, via: done.via })];
});
for (let index = 0; index < PROJECTS_OFFERED; index += 1) registerBobAction(`${START_TASK}.${index}`, startChosenTask);

/** `appearance` is the page's new display settings, when Bob's display agent changed them; the page applies them. */
export interface BobReply { action: "started" | "answer"; user: BobMessage; reply: BobMessage; projectId: string | null; sessionId?: string | null; appearance?: AppearanceSettings }

/**
 * Bob's front door. The person's message and Bob's reply are both kept in Bob's timeline, labelled with the project and
 * how much it matters. The decision model decides what the message is, which project it is about and how big the job is,
 * in one batched request; a confident task starts as a conversation in that project, anything else is answered by Bob's agent.
 */
export async function handleBobMessage(session: AuthSession, input: { message: string; projectId?: string; answerOnly?: boolean; images?: BobAttachments["images"]; files?: BobAttachments["files"]; appearance?: AppearanceContext }): Promise<BobReply> {
  const db = await bobDatabase();
  // Attachments reach the agent that reads the message: Bob's when he answers, or the conversation he starts or continues.
  const attachments: BobAttachments = { images: input.images ?? [], files: input.files ?? [] };
  const attachedNames = [...attachments.images, ...attachments.files].map((attachment) => attachment.name);
  // Talking to Bob, from the chat or from Telegram, is also how he learns who to tell about things that happen later.
  rememberBobAccount(db, actingAccountFromSession(session));
  const settings = readBobSettings(db, session.accountId);
  const recent = listBobMessages(db, session.accountId, { limit: 20 }).filter((entry) => entry.role !== "system").slice(-RECENT_CHAT_LINES).map((entry) => entry.text);
  const projects = await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
  const chosen = input.projectId ? projects.find((candidate) => candidate.id === input.projectId) : undefined;
  const model = await bobDecisionModel(projects, settings);
  // "Move my running jobs to the homeserver" is about machines, not a project or a task: it never reaches the decision below.
  const moves = input.answerOnly ? null : await handleBobMoveRequest({ session, message: input.message, recentChat: recent, settings, projects, model });
  if (moves) return moves;
  const options = await projectOptions(projects, session);
  let decision: BobDecision | null = null;
  if (model) {
    decision = await decideForBob({
      message: input.message, recentChat: recent, projects: options, fixedProjectId: chosen?.id,
      stateCharacters: model.target.stateCharacters, ask: (state, questions) => askSystemOneChoices(model.target, state, questions, model.apiKey),
    });
  }
  const sure = needsAgentDecision(decision, settings.threshold) ? null : decision;
  const project = chosen ?? projects.find((candidate) => candidate.id === sure?.projectId);
  const shown = attachedNames.length ? `${input.message}\n\nAttached: ${attachedNames.join(", ")}` : input.message;
  const user = appendBobMessage(db, session.accountId, { role: "user", text: shown, projectId: project?.id ?? null, projectName: project?.name ?? null });

  // How the app looks goes to Joint Bob's display agent, on a lighter model; its change is applied in the page the person wrote from.
  const display = input.answerOnly ? null : await askDisplayAgent({ message: input.message, recentChat: recent, decision, settings, projects, context: input.appearance });
  if (display) {
    const reply = appendBobMessage(db, session.accountId, {
      role: "bob", text: display.reply, via: display.via, importance: display.kind === "changed" ? "done" : "fyi", projectId: null, projectName: null,
      ...(display.kind === "changed" ? { actions: [{ id: "display.undo", label: "Undo", data: { appearance: display.previous } }] } : {}),
    });
    notifyBobExchange({ session, message: input.message, recentChat: recent, project: null, options, settings }, reply.text);
    return { action: "answer", user, reply, projectId: null, ...(display.kind === "changed" ? { appearance: display.settings } : {}) };
  }

  // A request for a dashboard for a project or for the person goes to the dashboard-creator agent, not to a project conversation.
  const dashboards = input.answerOnly ? null : await bobDashboardRequest({ session, db, settings, message: input.message, recentChat: recent, project, projects, decision: sure, model });
  if (dashboards) return { action: "answer", user, reply: dashboards, projectId: project?.id ?? null };

  const turn: BobTurn = { session, message: input.message, recentChat: recent, project: project ? { id: project.id, name: project.name } : null, options, settings };
  // Listing, pausing, resuming, deleting or creating a scheduled task, webhook or Bob report is carried out in control-center-automation-chat.ts.
  const automation = input.answerOnly ? null : await handleBobAutomation(turn, decision);
  if (automation) return { action: "answer", user, reply: automation, projectId: null };
  // Creating, renaming, moving, closing or deleting a workspace, project or conversation is carried out in control-center-organize.ts.
  const organized = input.answerOnly ? null : await handleBobOrganize(turn, decision);
  if (organized) return { action: "answer", user, reply: organized, projectId: organized.projectId };

  if (!input.answerOnly && sure && sure.kind === "task" && project) {
    const done = await runTask({ session, settings, project, message: input.message, attachments, recentChat: recent, model, decision: sure, via: viaText(null, sure, project.name), turn });
    const reply = appendBobMessage(db, session.accountId, { role: "bob", text: done.text, via: done.via, projectId: project.id, projectName: project.name });
    if (!done.started) return { action: "answer", user, reply, projectId: project.id };
    notifyBobExchange(turn, reply.text);
    return { action: "started", user, reply, projectId: project.id, sessionId: done.sessionId };
  }

  // Work Bob is sure was asked for, in a project he cannot tell: he asks where instead of guessing, and the buttons keep the
  // request, so pressing one starts it as written. Attachments cannot ride on a button, so a message with them is answered.
  if (!input.answerOnly && !project && !attachedNames.length && decision?.kind === "task" && decision.kindConfidence >= settings.threshold) {
    const reply = askWhichProject(db, session, input.message, decision, options);
    notifyBobExchange(turn, reply.text);
    return { action: "answer", user, reply, projectId: null };
  }

  const reason = !model ? "no-decision-model" : !decision ? "no-answer" : sure ? sure.kind : "low-confidence";
  const answerProject = project ?? projects[0];
  const answered = await answerWithAgent({ message: input.message, attachments, recentChat: recent, project: answerProject, projectChosen: Boolean(project), projects, options, settings, session, turn });
  const via = [viaText(reason, decision, project?.name ?? null), ...answered.via].join(" · ");
  const reply = appendBobMessage(db, session.accountId, { role: "bob", text: answered.text || "I have nothing to add.", via, projectId: project?.id ?? null, projectName: project?.name ?? null });
  notifyBobExchange(turn, reply.text);
  return { action: "answer", user, reply, projectId: project?.id ?? null };
}
