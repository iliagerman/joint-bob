import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { InstructionFile } from "./agent-instructions.js";
import { knowledgeDirectory } from "./project-knowledge.js";

/** As much of the index as agents read into a conversation. */
const INDEX_LINES = 200;

/** The same text for every project; the project's own index follows in {@link knowledgeInstructionFile}. */
export const projectKnowledgeAgentInstructions = `# Project knowledge base

A project may keep rules learned from earlier conversations in \`.agents/knowledge/\` in your working folder. They are committed with the project, so they apply to everyone who works on it.

- When a "Project knowledge" section lists subjects, open the subject's file before work it touches. Do not load every file.
- \`INDEX.md\` lists the subjects. One file per subject, \`<subject>.md\` (a short kebab-case slug), holds its rules in this format:

\`\`\`markdown
# database-access

How agents reach the project's databases.

## r-k3Jd9

Connect to the dev database through the SSH tunnel on port 5433; direct connections time out.

Evidence: 3 conversations timed out connecting directly · Added 2026-11-04
\`\`\`

- Add a rule when the user corrects a mistake that keeps happening, or asks you to remember how something must be done in this project. Add it under the matching subject, or create a new subject file. Change an existing rule instead of writing a second one about the same thing.
- Give each rule a unique id starting with \`r-\`, one clear instruction, and an Evidence line.
- Ask the user before removing or rewriting a rule someone else added.
- After you add, change or remove a rule, update the subject's line in \`INDEX.md\`: \`- [slug](slug.md) — description (N rules)\`. Delete a subject's file and its line when its last rule goes.
- Do not edit \`notes/\`, \`proposals/\` or \`CLEANUP-LOG.md\` in that folder; Joint Bob manages them.
- Do not commit these files unless the user asks.`;

/** The project's subjects, which the agent reads before it decides what to open; null when the project has none. */
export function knowledgeInstructionFile(cwd: string): InstructionFile | null {
  const indexFile = path.join(knowledgeDirectory(cwd), "INDEX.md");
  if (!existsSync(indexFile)) return null;
  const index = readFileSync(indexFile, "utf8").split("\n").slice(0, INDEX_LINES).join("\n").trimEnd();
  if (!index) return null;
  return {
    path: indexFile,
    label: "Project knowledge",
    content: `This project's rules are in \`${knowledgeDirectory(cwd)}\`. Open a subject's file when the task touches it.\n\n${index}`,
  };
}
