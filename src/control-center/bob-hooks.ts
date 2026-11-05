import type { AuthSession } from "../auth.js";
import type { BobSettings } from "./bob-store.js";
import type { BobProjectOption } from "./decisions.js";

/** What Bob knows about the message it is answering. */
export interface BobTurn {
  session: AuthSession;
  message: string;
  recentChat: string[];
  /** The project the message is about, when it is known. */
  project: { id: string; name: string } | null;
  options: BobProjectOption[];
  settings: BobSettings;
}

export interface BobContribution {
  /** Added to what Bob's agent is shown before it answers. */
  text: string;
  /** A short note for the line under Bob's reply, such as "Asked Work assistant". */
  via?: string;
}

export type BobContextProvider = (turn: BobTurn) => Promise<BobContribution | null>;
export type BobExchangeObserver = (turn: BobTurn, reply: string) => Promise<void>;

const providers = new Map<string, BobContextProvider>();
const observers = new Map<string, BobExchangeObserver>();

/** A feature adds what Bob should know before answering (memory topics, other assistants' answers). */
export function registerBobContextProvider(name: string, provider: BobContextProvider): void { providers.set(name, provider); }

/** A feature watches finished exchanges (learning what is worth remembering). */
export function registerBobExchangeObserver(name: string, observer: BobExchangeObserver): void { observers.set(name, observer); }

/** Runs every provider at the same time. One that fails is skipped: Bob answers without it. */
export async function collectBobContext(turn: BobTurn): Promise<{ text: string; via: string[] }> {
  const results = await Promise.all([...providers].map(async ([name, provider]) => {
    try { return await provider(turn); } catch (error) { console.warn(`Bob context provider ${name} failed`, error instanceof Error ? error.message : error); return null; }
  }));
  const found = results.filter((entry): entry is BobContribution => entry !== null && Boolean(entry.text.trim()));
  return { text: found.map((entry) => entry.text.trim()).join("\n\n"), via: found.flatMap((entry) => entry.via ? [entry.via] : []) };
}

/** Tells every observer about a finished exchange without making the person wait for them. */
export function notifyBobExchange(turn: BobTurn, reply: string): void {
  for (const [name, observer] of observers) {
    void observer(turn, reply).catch((error) => console.warn(`Bob exchange observer ${name} failed`, error instanceof Error ? error.message : error));
  }
}
