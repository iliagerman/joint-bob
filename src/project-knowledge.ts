import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { customAlphabet } from "nanoid";
import { writeTextAtomically } from "./global-instructions.js";

/**
 * A project's knowledge base: rules agents learned, grouped by subject, in `.agents/knowledge/`
 * of the project so they are committed with it. The folder also holds each conversation's
 * problem notes, rule proposals waiting for a person, and the log of what cleanup did.
 */
export interface KnowledgeRule { id: string; text: string; evidence: string; /** YYYY-MM-DD */ added: string }
export interface KnowledgeSubject { slug: string; description: string; rules: KnowledgeRule[] }
export interface KnowledgeProblem { subject: string; text: string }
export interface ConversationNote { conversationId: string; updatedAt: string; problems: KnowledgeProblem[]; /** Normalized rule texts a person dismissed. */ dismissed: string[] }
export type ProposalAction = "add" | "remove" | "merge";
export interface KnowledgeProposal {
  id: string; action: ProposalAction; subject: string; text: string; evidence: string;
  ruleId?: string; mergeWith?: string; created: string;
  /** A conversation id, or "cleanup". */
  source: string;
}

export class KnowledgeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const FILE_ID = /^[A-Za-z0-9_-]{1,120}$/;
const INDEX = "INDEX.md";
const LOG = "CLEANUP-LOG.md";
const DAY_MS = 24 * 3_600_000;
const newRuleId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 8);

export function knowledgeDirectory(root: string): string {
  return path.join(root, ".agents", "knowledge");
}

export function isKnowledgeSlug(value: string): boolean {
  return SLUG.test(value);
}

function slugged(value: string): string {
  if (!SLUG.test(value)) throw new KnowledgeError(400, `Invalid subject name: ${value.slice(0, 60)}`);
  return value;
}

function fileId(value: string): string {
  if (!FILE_ID.test(value)) throw new KnowledgeError(400, `Invalid id: ${value.slice(0, 60)}`);
  return value;
}

export function normalizedRuleText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?;:,\s]+$/, "");
}

function subjectFile(root: string, slug: string): string {
  return path.join(knowledgeDirectory(root), `${slugged(slug)}.md`);
}

function parseSubject(slug: string, content: string): KnowledgeSubject {
  const lines = content.split("\n");
  const firstRule = lines.findIndex((line) => /^## \S/.test(line));
  const header = (firstRule < 0 ? lines : lines.slice(0, firstRule)).filter((line) => line.trim() && !line.startsWith("#"));
  const rules: KnowledgeRule[] = [];
  if (firstRule >= 0) {
    let current: { id: string; body: string[] } | undefined;
    const finish = () => {
      if (!current) return;
      const text: string[] = [];
      let evidence = "";
      let added = "";
      for (const line of current.body) {
        const found = /^Evidence:\s*(.*?)(?:\s+·\s+Added (\d{4}-\d{2}-\d{2}))?\s*$/.exec(line);
        if (found) { evidence = evidence || found[1]; added = added || found[2] || ""; } else text.push(line);
      }
      rules.push({ id: current.id, text: text.join("\n").trim(), evidence, added });
    };
    for (const line of lines.slice(firstRule)) {
      const heading = /^## (\S+)\s*$/.exec(line);
      if (heading) { finish(); current = { id: heading[1], body: [] }; } else current?.body.push(line);
    }
    finish();
  }
  return { slug, description: header.join(" ").trim(), rules: rules.filter((rule) => rule.text) };
}

function renderSubject(subject: KnowledgeSubject): string {
  const rules = subject.rules.map((rule) => [
    `## ${rule.id}`, "", rule.text, "",
    `Evidence: ${rule.evidence}${rule.added ? ` · Added ${rule.added}` : ""}`.trimEnd(), "",
  ].join("\n"));
  return [`# ${subject.slug}`, "", ...(subject.description ? [subject.description, ""] : []), ...rules].join("\n").trimEnd() + "\n";
}

function jsonFiles(directory: string): string[] {
  try { return readdirSync(directory).filter((name) => name.endsWith(".json")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; }
  catch (error) {
    console.warn(`Skipped unreadable knowledge file ${file}`, error instanceof Error ? error.message.slice(0, 120) : "");
    return null;
  }
}

export function readSubject(root: string, slug: string): KnowledgeSubject | null {
  const file = subjectFile(root, slug);
  return existsSync(file) ? parseSubject(slug, readFileSync(file, "utf8")) : null;
}

export function readSubjects(root: string): KnowledgeSubject[] {
  const directory = knowledgeDirectory(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md") && SLUG.test(name.slice(0, -3)) && statSync(path.join(directory, name)).isFile())
    .map((name) => name.slice(0, -3))
    .sort()
    .map((slug) => parseSubject(slug, readFileSync(path.join(directory, `${slug}.md`), "utf8")));
}

/** The index is derived from the subject files, so a hand-edited or broken one heals on the next write. */
export function rebuildIndex(root: string): void {
  const subjects = readSubjects(root).filter((subject) => subject.rules.length);
  const lines = subjects.map((subject) => `- [${subject.slug}](${subject.slug}.md) — ${subject.description || subject.slug} (${subject.rules.length} ${subject.rules.length === 1 ? "rule" : "rules"})`);
  writeTextAtomically(path.join(knowledgeDirectory(root), INDEX), [
    "# Project knowledge", "", "Rules agents learned in this project. Read a subject's file when the task touches it.", "", ...lines,
  ].join("\n") + "\n");
}

export function addRule(root: string, input: { subject: string; description?: string; text: string; evidence: string }, today = new Date().toISOString().slice(0, 10)): KnowledgeRule {
  const slug = slugged(input.subject);
  const existing = readSubject(root, slug);
  const rule: KnowledgeRule = { id: `r-${newRuleId()}`, text: input.text.trim(), evidence: input.evidence.trim(), added: today };
  const subject: KnowledgeSubject = existing ?? { slug, description: input.description?.trim() ?? "", rules: [] };
  if (existing && !existing.description && input.description?.trim()) subject.description = input.description.trim();
  subject.rules.push(rule);
  writeTextAtomically(subjectFile(root, slug), renderSubject(subject));
  rebuildIndex(root);
  return rule;
}

export function removeRule(root: string, slug: string, ruleId: string): boolean {
  const subject = readSubject(root, slug);
  if (!subject?.rules.some((rule) => rule.id === ruleId)) return false;
  subject.rules = subject.rules.filter((rule) => rule.id !== ruleId);
  if (subject.rules.length) writeTextAtomically(subjectFile(root, slug), renderSubject(subject));
  else rmSync(subjectFile(root, slug), { force: true });
  rebuildIndex(root);
  return true;
}

function notePath(root: string, conversationId: string): string {
  return path.join(knowledgeDirectory(root), "notes", `${fileId(conversationId)}.json`);
}

function proposalPath(root: string, id: string): string {
  return path.join(knowledgeDirectory(root), "proposals", `${fileId(id)}.json`);
}

export function writeNote(root: string, note: ConversationNote): void {
  writeTextAtomically(notePath(root, note.conversationId), `${JSON.stringify(note, null, 2)}\n`);
}

export function readNotes(root: string): ConversationNote[] {
  const directory = path.join(knowledgeDirectory(root), "notes");
  return jsonFiles(directory).map((name) => readJson<ConversationNote>(path.join(directory, name))).filter((note): note is ConversationNote => Boolean(note?.conversationId));
}

export function writeProposal(root: string, proposal: KnowledgeProposal): void {
  writeTextAtomically(proposalPath(root, proposal.id), `${JSON.stringify(proposal, null, 2)}\n`);
}

export function readProposal(root: string, id: string): KnowledgeProposal | null {
  const file = proposalPath(root, id);
  return existsSync(file) ? readJson<KnowledgeProposal>(file) : null;
}

export function listProposals(root: string): KnowledgeProposal[] {
  const directory = path.join(knowledgeDirectory(root), "proposals");
  return jsonFiles(directory)
    .map((name) => readJson<KnowledgeProposal>(path.join(directory, name)))
    .filter((proposal): proposal is KnowledgeProposal => Boolean(proposal?.id))
    .sort((left, right) => right.created.localeCompare(left.created));
}

export function deleteProposal(root: string, id: string): boolean {
  const file = proposalPath(root, id);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

export function appendCleanupLog(root: string, lines: string[], at = new Date()): void {
  if (!lines.length) return;
  const file = path.join(knowledgeDirectory(root), LOG);
  const previous = existsSync(file) ? readFileSync(file, "utf8").trimEnd() : "# Cleanup log";
  writeTextAtomically(file, `${previous}\n\n## ${at.toISOString()}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`);
}

/** Deletes notes and proposals nobody touched for `maxAgeDays`. */
export function pruneOld(root: string, now: Date, maxAgeDays = 30): { notes: number; proposals: number } {
  const cutoff = now.getTime() - maxAgeDays * DAY_MS;
  const old = (stamp: string) => Date.parse(stamp) < cutoff;
  let notes = 0;
  let proposals = 0;
  for (const note of readNotes(root)) if (old(note.updatedAt)) { rmSync(notePath(root, note.conversationId), { force: true }); notes += 1; }
  for (const proposal of listProposals(root)) if (old(proposal.created)) { deleteProposal(root, proposal.id); proposals += 1; }
  return { notes, proposals };
}
