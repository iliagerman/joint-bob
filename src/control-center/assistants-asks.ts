import { randomUUID } from "node:crypto";
import { AskRefusal, startAskOn, waitForAsk } from "../assistant-collaboration/ask.js";
import { ownerAssistants, type HelperView } from "../assistant-collaboration/directory.js";
import { askAllowedBySwitch, BOB_ASKER_NAME, BOB_ASK_TURN_PREFIX, bobAsks, setAskSwitch, type AskRecord } from "../assistant-collaboration/store.js";
import { getClusterNode } from "../cluster.js";
import { listPersonalAssistantTopics, runningPersonalAssistantTurn } from "../personal-assistants.js";
import { socialProfile } from "../social/directory.js";
import { askedMessage, type AskOutcome, type BobHelper } from "./assistants.js";

/** A refusal the person can read, with the status a request gets for it. */
export class BobAssistantError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** How many of Bob's recent asks are read to describe the assistants and to show one's history. */
const RECENT_ASKS = 300;
/** An ask still marked running after this long has lost its helper; it is not shown as "answering Bob" forever. */
const STALE_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const HISTORY = 30;

/**
 * Bob's side of the per-pair "may ask" switch is the person's default assistant: one switch, the same one the
 * assistants' own Resources show. A person with no default assistant gets a switch of Bob's own.
 */
export async function bobAskerId(accountId: string): Promise<string> {
  return (await socialProfile(accountId)).defaultAssistantId ?? `bob-of:${accountId}`;
}

/** Every assistant of the person on any of their machines, with whether Bob may ask it now and why not. Bob's chat is the person's alone, so only the helper's side can be shared. */
export async function bobHelperViews(accountId: string): Promise<HelperView[]> {
  const asker = await bobAskerId(accountId);
  return Promise.all((await ownerAssistants(accountId)).map(async (helper) => {
    const enabled = await askAllowedBySwitch(asker, helper.id);
    const reason = !enabled ? "Bob may not ask it: the switch is off."
      : !helper.private ? `${helper.name} is in a shared project, so Bob can't ask it: its answers could reach the people it is shared with.`
        : null;
    return { ...helper, enabled, available: reason === null, reason };
  }));
}

export const toBobHelper = (view: Pick<HelperView, "id" | "name" | "about" | "has">): BobHelper => ({ id: view.id, name: view.name, about: view.about, has: view.has });

const secondsBetween = (from: string, to: number): number => Math.max(1, Math.round((to - Date.parse(from)) / 1000));

export interface AskOptions {
  /** How long to wait for the answer; past it the ask goes on and is recorded when it ends. */
  waitMs: number;
  /** Called once the ask is recorded and the helper is working. */
  onStarted?: () => void;
}

/**
 * Bob asks one assistant, as the person: the same ask the person's assistants make (recorded, run as the owner with the
 * helper's own logins and tools, on its machine). The switch and the privacy rule are checked now, on every ask.
 * A refusal or a helper that cannot be reached is a failed outcome, not an error: the other answers still count.
 */
export async function askAsBob(accountId: string, helper: BobHelper, message: string, purpose: string, options: AskOptions): Promise<AskOutcome> {
  const began = Date.now();
  const lost = (error: string, askId: string | null = null): AskOutcome => ({ helper, purpose, askId, status: "failed", answer: null, error, seconds: Math.max(1, Math.round((Date.now() - began) / 1000)) });
  try {
    const view = (await bobHelperViews(accountId)).find((candidate) => candidate.id === helper.id);
    if (!view) throw new AskRefusal(`${helper.name} is no longer one of your assistants.`);
    if (!view.available) throw new AskRefusal(view.reason!);
    const askerId = await bobAskerId(accountId);
    const record = await startAskOn(view, { accountId, askerId, askerName: BOB_ASKER_NAME, askerTurnRequestId: `${BOB_ASK_TURN_PREFIX}${randomUUID()}`, message, purpose });
    options.onStarted?.();
    const done = await waitForAsk(record.id, askerId, options.waitMs);
    const seconds = secondsBetween(done.startedAt, done.finishedAt ? Date.parse(done.finishedAt) : Date.now());
    if (done.status === "completed") return { helper, purpose, askId: done.id, status: "completed", answer: done.answer ?? "", error: null, seconds };
    if (done.status === "failed") return { helper, purpose, askId: done.id, status: "failed", answer: null, error: done.error ?? "It did not answer.", seconds };
    return { helper, purpose, askId: done.id, status: "running", answer: null, error: null, seconds };
  } catch (error) {
    if (error instanceof AskRefusal) return lost(error.message);
    console.warn(`Bob could not ask ${helper.name}`, error instanceof Error ? error.message : error);
    return lost(error instanceof Error ? error.message : "Asking failed.");
  }
}

/** The ask as the person reads it: the question as Bob put it to them, not the framing the assistant got. */
export interface AskView {
  id: string; helperId: string; helperName: string; purpose: string; status: AskRecord["status"];
  question: string; answer: string | null; error: string | null;
  startedAt: string; finishedAt: string | null; seconds: number | null;
}

function askView(record: AskRecord): AskView {
  return {
    id: record.id, helperId: record.helperId, helperName: record.helperName, purpose: record.purpose, status: record.status,
    question: askedMessage(record.question), answer: record.answer, error: record.error,
    startedAt: record.startedAt, finishedAt: record.finishedAt, seconds: record.finishedAt ? secondsBetween(record.startedAt, Date.parse(record.finishedAt)) : null,
  };
}

/** What Bob asked one assistant, newest first. */
export async function bobAsksOf(accountId: string, helperId: string): Promise<AskView[]> {
  return (await bobAsks(accountId, RECENT_ASKS)).filter((record) => record.helperId === helperId).slice(0, HISTORY).map(askView);
}

export interface AssistantCard {
  id: string; name: string; machine: string; nodeId: string;
  /** It runs on this machine, so its chat can be opened here. */
  local: boolean;
  state: "idle" | "busy" | "answering-bob";
  /** What it has attached, from the summary the owner's assistants share. */
  has: string[];
  about: string;
  /** Bob's side of the switch is this assistant's own: Bob speaks for the person as their default assistant would. */
  isDefault: boolean;
  /** The "Bob may ask" switch. */
  mayAsk: boolean;
  askable: boolean;
  /** Its project is shared with others, so Bob can't ask it and the switch can't be turned on. */
  shared: boolean;
  reason: string | null;
  lastAsk: AskView | null;
  askedLastDay: number;
}

async function stateOf(accountId: string, view: HelperView, local: string, running: Set<string>): Promise<AssistantCard["state"]> {
  if (running.has(view.id)) return "answering-bob";
  if (view.nodeId !== local) return "idle";
  const topics = await listPersonalAssistantTopics(accountId, view.id);
  return topics && await runningPersonalAssistantTurn(view.id, topics.map((topic) => `${topic.engine}:${topic.sessionId}`)) ? "busy" : "idle";
}

/** Every assistant the person owns, as a card, name order. */
export async function listAssistantCards(accountId: string): Promise<AssistantCard[]> {
  const [views, recent, profile, local] = await Promise.all([bobHelperViews(accountId), bobAsks(accountId, RECENT_ASKS), socialProfile(accountId), getClusterNode()]);
  const now = Date.now();
  const running = new Set(recent.filter((record) => record.status === "running" && now - Date.parse(record.startedAt) < STALE_MS).map((record) => record.helperId));
  const cards = await Promise.all(views.map(async (view): Promise<AssistantCard> => {
    const asks = recent.filter((record) => record.helperId === view.id);
    return {
      id: view.id, name: view.name, machine: view.machineName, nodeId: view.nodeId, local: view.nodeId === local.id,
      state: await stateOf(accountId, view, local.id, running), has: view.has, about: view.about,
      isDefault: profile.defaultAssistantId === view.id, mayAsk: view.enabled, askable: view.available, shared: !view.private, reason: view.reason,
      lastAsk: asks[0] ? askView(asks[0]) : null, askedLastDay: asks.filter((record) => now - Date.parse(record.startedAt) < DAY_MS).length,
    };
  }));
  return cards.sort((a, b) => a.name.localeCompare(b.name));
}

/** Turns Bob's switch for one assistant on or off. A shared project's assistant can't be turned on until it stops being shared. */
export async function setBobMayAsk(accountId: string, helperId: string, enabled: boolean): Promise<AssistantCard> {
  const view = (await bobHelperViews(accountId)).find((candidate) => candidate.id === helperId);
  if (!view) throw new BobAssistantError(404, "Assistant not found");
  if (enabled && !view.private) throw new BobAssistantError(409, `${view.name} is in a shared project, so Bob can't ask it.`);
  await setAskSwitch(await bobAskerId(accountId), helperId, enabled);
  return (await listAssistantCards(accountId)).find((card) => card.id === helperId)!;
}
