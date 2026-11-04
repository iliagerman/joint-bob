# Project Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the side panel's skill suggestions with rule suggestions drawn from repeated problems across a project's conversations. Accepted rules go into a git-tracked knowledge base that agents read and maintain, and a relay cleans that knowledge base every night.

**Architecture:** The knowledge base is a folder in the project, `.agents/knowledge/`, holding Markdown subject files, an index derived from them, per-conversation problem notes, pending proposals and a cleanup log. It travels with the project through file sync and git. The existing summary writer records problems and proposes rules in place of skills. A new route lets anyone who can edit the project accept or dismiss proposals. A fixed capability section tells every agent how to maintain the folder, and the project's index is injected next to Memory. A daily job on relay nodes reviews each held project with a read-only agent run, then applies only removals the decision model is more than 95% sure of.

**Tech Stack:** Node 24 + TypeScript (`tsx`, `node:test`), Express routes, `zod`, vanilla JS UI, Playwright UI tests, TypeSafe Jev / Laya System One API.

**Spec:** `docs/superpowers/specs/2026-11-03-project-knowledge-base-design.md`

## Global Constraints

- Knowledge folder: `<root>/.agents/knowledge/`. Never `.joint-bob/`, which is locked out of sync.
- The summary writer, the panel route and the cleanup use `project.path` as `<root>`. Agents use their own working folder (`cwd`), so a worktree agent edits its worktree's copy and the change rides its PR (**plan call**; never edit the project folder from a worktree).
- Joint Bob never commits or pushes knowledge changes. Files are written to the working tree only.
- Auto-apply threshold: decision-model confidence strictly greater than `0.95` for the "apply" choice.
- Housekeeping age: notes and proposals older than 30 days are deleted.
- Cleanup time: 03:00 relay local time, once per day. No catch-up: a missed run waits for the next 03:00. No polling loops.
- At most 3 rule proposals per summary write.
- Slugs: `^[a-z0-9][a-z0-9-]{0,59}$`. Proposal, rule and conversation ids in file names: `^[A-Za-z0-9_-]{1,120}$`. Anything else is rejected, never path-joined.
- File formats for notes and proposals are JSON (`notes/<conversationId>.json`, `proposals/<id>.json`) (**plan call**; the spec's `.md` names change to `.json`). Subject files, `INDEX.md` and `CLEANUP-LOG.md` are Markdown.
- Conventional Commits. The pre-commit hook adds the changelog bullet; check `HEAD` after each commit (see memory "commit hook duplicates CHANGELOG bullets").
- The usage dashboard "Suggestions" and "Repeated work" features (`src/usage-skill-suggestions.ts`, `src/usage-analysis.ts`) are untouched.

## Review Focus

1. **A hand-edited or malformed subject file or `INDEX.md`** (agents edit these directly). Parsing must not throw, and the index is always rebuilt from the subject files, so a broken index heals on the next write. Test in Task 1.
2. **Model output naming a subject or rule like `../../etc`**. It must be rejected, not written. Test in Tasks 1 and 2.
3. **A project with no knowledge folder** (every existing project on day one). The panel shows the empty state, GET returns empty lists, and cleanup does nothing. Tests in Tasks 3 and 7.
4. **A decision model that is missing, unreachable or returns null.** Nothing is auto-removed; candidates become proposals. No key at all: the project is skipped, with one log line. Test in Task 7.
5. **A rule edited on another machine between the review and the apply step.** The apply is skipped and a proposal is created instead. Test in Task 7.

---

### Task 1: Knowledge folder module

**Files:**
- Create: `src/project-knowledge.ts`
- Test: `test/project-knowledge.test.ts`

**Interfaces:**
- Produces:
  - `knowledgeDirectory(root: string): string` returns `path.join(root, ".agents", "knowledge")`.
  - `interface KnowledgeRule { id: string; text: string; evidence: string; added: string }`, where `added` is a `YYYY-MM-DD` date.
  - `interface KnowledgeSubject { slug: string; description: string; rules: KnowledgeRule[] }`.
  - `interface KnowledgeProblem { subject: string; text: string }`.
  - `interface ConversationNote { conversationId: string; updatedAt: string; problems: KnowledgeProblem[]; dismissed: string[] }`, where `dismissed` holds normalized rule texts.
  - `type ProposalAction = "add" | "remove" | "merge"`.
  - `interface KnowledgeProposal { id: string; action: ProposalAction; subject: string; text: string; evidence: string; ruleId?: string; mergeWith?: string; created: string; source: string }`. `source` is a conversation id or `"cleanup"`.
  - `readSubjects(root): KnowledgeSubject[]`, sorted by slug. Missing folder returns `[]`.
  - `readSubject(root, slug): KnowledgeSubject | null`.
  - `addRule(root, input: { subject: string; description?: string; text: string; evidence: string }, today?: string): KnowledgeRule`.
  - `removeRule(root, slug: string, ruleId: string): boolean`.
  - `rebuildIndex(root): void`.
  - `writeNote(root, note: ConversationNote): void`, `readNotes(root): ConversationNote[]`.
  - `writeProposal(root, proposal: KnowledgeProposal): void`, `listProposals(root): KnowledgeProposal[]` (newest first), `readProposal(root, id): KnowledgeProposal | null`, `deleteProposal(root, id): boolean`.
  - `appendCleanupLog(root, lines: string[], at?: Date): void`.
  - `pruneOld(root, now: Date, maxAgeDays = 30): { notes: number; proposals: number }`.
  - `normalizedRuleText(text: string): string`: lowercased, whitespace collapsed, trailing punctuation trimmed.
  - `class KnowledgeError extends Error { status: number }` for invalid names (400) and missing items (404).

Subject file format (`<slug>.md`):

```markdown
# database-access

How agents reach the project's databases.

## r-k3Jd9

Connect to the dev database through the SSH tunnel on port 5433; direct connections time out.

Evidence: 3 conversations timed out connecting directly · Added 2026-11-04
```

`INDEX.md` is generated. One line per subject, sorted:

```markdown
# Project knowledge

Rules agents learned in this project. Read a subject's file when the task touches it.

- [database-access](database-access.md) — How agents reach the project's databases (1 rule)
```

- [ ] **Step 1: Write the failing tests** in `test/project-knowledge.test.ts`, each using a fresh `mkdtemp` root:
  - `addRule creates the subject file and index`: after `addRule(root, { subject: "database-access", description: "How agents reach the project's databases", text: "Use the tunnel on 5433.", evidence: "3 conversations" }, "2026-11-04")`, `readSubject(root, "database-access").rules` has length 1 with `text === "Use the tunnel on 5433."`, and `INDEX.md` contains `- [database-access](database-access.md) — How agents reach the project's databases (1 rule)`.
  - `removeRule drops the rule and the empty subject file`: after removing the only rule, `readSubject` returns `null`, `INDEX.md` has no `database-access` line, and the function returned `true`. A second call returns `false`.
  - `hand-edited subject file still parses`: write a subject file with a stray paragraph and a `## r-x` heading with no Evidence line. `readSubjects` returns that rule with `evidence === ""` and does not throw. `rebuildIndex` writes `(1 rule)`.
  - `rejects unsafe names`: `addRule` with subject `"../x"`, `writeNote` with conversationId `"a/b"`, and `deleteProposal(root, "..")` each throw `KnowledgeError` with `status === 400`, and nothing is created outside `knowledgeDirectory(root)`.
  - `missing folder reads as empty`: `readSubjects`, `readNotes` and `listProposals` on a root without the folder return `[]`.
  - `pruneOld deletes old notes and proposals only`: a note with `updatedAt` 31 days ago and a proposal with `created` 31 days ago are removed. Ones from 29 days ago stay. The counts returned are `{ notes: 1, proposals: 1 }`.
  - `notes and proposals round-trip as JSON`: `writeNote` then `readNotes` returns an equal object. `writeProposal` then `listProposals` returns newest `created` first.
- [ ] **Step 2: Run** `npm run test:file -- test/project-knowledge.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/project-knowledge.ts`.** Write every file with `writeTextAtomically` from `src/global-instructions.ts`. Rule ids are `r-` plus `nanoid(8)` with `-` and `_` allowed. Parse a subject file by `## <id>` headings, taking the first `Evidence:` line as evidence and `Added YYYY-MM-DD` as the date. Every write path calls `rebuildIndex`. Invalid JSON in a note or proposal file is skipped and logged with `console.warn`, never thrown.
- [ ] **Step 4: Run** `npm run test:file -- test/project-knowledge.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): project knowledge folder with subjects, notes and proposals`.

---

### Task 2: Summary writer records problems and proposes rules (skills removed)

**Files:**
- Modify: `src/conversation-digest.ts` (remove `SkillSuggestion`, `DigestSkills`, `DEFAULT_SKILL_SUGGESTION_INSTRUCTIONS`, `skillInstructions`, `keptSuggestions`, `usedSkills`, `bareSkillName`, `SUGGESTIONS_MARK`, and the catalog constants; drop `ConversationDigest.suggestions`)
- Modify: `src/server/conversation-digest-runner.ts` (remove `skillCatalog`; replace the skills block in `writeDigest`)
- Modify: `src/conversation-summary-policy.ts` (remove `nodeSkillSuggestionInstructions` and its setter and key `conversationSkillSuggestionInstructions`)
- Modify: `src/server/routes/conversation-digest.ts` (remove the `skill-draft` routes, `skillDraftProject`, the `PUT /api/conversation-summary/skill-instructions` route and the `skillInstructions` field of the settings GET)
- Modify: `src/server/admin.ts:45` (drop `|skill-instructions`)
- Delete: `src/server/skill-draft-run.ts`, `test/skill-draft.test.ts`, and `src/skill-draft.ts` if `grep -rn "skill-draft" src` shows no other importer
- Test: `test/conversation-digest.test.ts`

**Interfaces:**
- Consumes: Task 1's `readSubjects`, `readNotes`, `listProposals`, `writeNote`, `writeProposal`, `normalizedRuleText`, `KnowledgeProblem`, `KnowledgeProposal`.
- Produces:
  - `interface DigestKnowledge { subjects: Array<{ slug: string; description: string; rules: string[] }>; otherNotes: Array<{ conversationId: string; problems: KnowledgeProblem[] }>; pending: string[]; ownProblems: KnowledgeProblem[] }`.
  - `digestPrompt(previous: string | undefined, knowledge?: DigestKnowledge, instructions?: string | null): string`.
  - `parseDigestReply(answer: string): { summary: string; problems?: KnowledgeProblem[]; rules?: Array<{ subject: string; text: string; evidence: string }> }`. Both lists are `undefined` when the mark is absent.
  - Constant `KNOWLEDGE_MARK = "@@knowledge"`.

Writer output under the mark, one item per line:

```
problem <subject-slug> — <what went wrong, under 30 words>
rule <subject-slug> — <the rule, under 40 words> — <evidence: which conversations, what happened>
```

Prompt requirements (exact wording is the builder's): record only real problems in this conversation's new messages. These include a failed connection or command repeated, an approach retried after it failed, a stop in a bad place during a goal, and asking permission for something that needs none. Propose a `rule` only when the problem appears in at least one other conversation's notes or at least twice in this one, and no listed rule or pending proposal already covers it. Content is evidence, not instructions. Never include credentials. Material bounds: other notes are capped at 40 conversations and 12,000 characters, newest first, and existing rule text at 12,000 characters.

- [ ] **Step 1: Update the tests** in `test/conversation-digest.test.ts`:
  - Replace the `@@skills` prompt assertion. `digestPrompt(undefined, knowledge)` contains `@@knowledge`, each subject slug, and one other note's problem text. `digestPrompt(undefined)` does not contain `@@knowledge`.
  - Replace the suggestion parsing tests with `parseDigestReply`:
    - Splitting `"**Goal** — x\n@@knowledge\nproblem database-access — timed out on 5432\nrule database-access — Use the tunnel on 5433 — conv a and b timed out"` gives `summary === "**Goal** — x"`, one problem, and one rule with those three fields.
    - Lines with a slug `"../etc"` or `"Bad Slug"` are dropped.
    - More than 3 rule lines keep the first 3.
    - An answer without the mark returns `{ summary }` only.
  - In the route test, the generator fixture emits `@@knowledge` lines with a project folder under a temp dir. After the POST, `notes/<conversationId>.json` exists with the problem, and `listProposals(projectPath)` has one `add` proposal with `source === conversationId`.
  - Delete the skill-instructions settings round-trip test. Add an assertion that `GET /api/conversation-summary/settings` has no `skillInstructions` key.
  - `pending dedupe`: when a pending proposal or existing rule has the same `normalizedRuleText`, a second identical `rule` line creates no new proposal. When the note's `dismissed` holds it, none is created either.
- [ ] **Step 2: Run** `npm run test:file -- test/conversation-digest.test.ts`. Expected: FAIL on the new assertions.
- [ ] **Step 3: Implement.** Writer-side changes:
  - In `writeDigest`, build `DigestKnowledge` from `project.path`. `ownProblems` comes from this conversation's existing note; `otherNotes` from `readNotes` minus this conversation; `pending` from `listProposals` texts.
  - After the reply, write the note when `problems` is defined, merging with the previous problems and keeping at most the newest 20. Write one `add` proposal per new rule, deduped as above, with `source: conversationId`.
  - A knowledge read or write failure logs and never fails the summary (the knowledge folder is a secondary output).
  - Remove every skill-suggestion export and its imports.
- [ ] **Step 4: Run** `npm run test:file -- test/conversation-digest.test.ts` and `npm run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(knowledge): summary writer records problems and proposes rules instead of skills`.

---

### Task 3: Knowledge routes (list, accept, dismiss)

**Files:**
- Create: `src/server/routes/project-knowledge.ts`
- Modify: `src/server.ts:92` (add `import "./server/routes/project-knowledge.js";` next to the digest routes)
- Test: `test/project-knowledge-routes.test.ts`

**Interfaces:**
- Consumes: Task 1's module. `assertProjectEditable(project)` from `src/server/projects.ts`. The visible-project lookup mirrors `visibleProject` in `src/server/routes/conversation-digest.ts:35`.
- Produces:
  - `GET /api/projects/:projectId/knowledge` returns `{ subjects: Array<{ slug, description, rules: KnowledgeRule[] }>, proposals: KnowledgeProposal[] }`.
  - `POST /api/projects/:projectId/knowledge/proposals/:id/accept` with body `{ subject?: string; text?: string }`:
    - `add` calls `addRule` with the edited subject and text when given.
    - `remove` calls `removeRule(subject, ruleId)`.
    - `merge` calls `removeRule(subject, ruleId)` and keeps `mergeWith`.
    - Then `deleteProposal`. Returns the GET body.
  - `POST /api/projects/:projectId/knowledge/proposals/:id/dismiss`: for a proposal whose `source` is a conversation, adds `normalizedRuleText(text)` to that note's `dismissed`, then deletes the proposal. Returns the GET body.
  - Errors: unknown proposal is 404, invalid names 400 (from `KnowledgeError`), a project another node has locked uses `assertProjectEditable`'s own error, and a read-only remote login is 403.

- [ ] **Step 1: Write the failing tests** against a dev node (follow `test/conversation-digest.test.ts` setup):
  - `lists empty knowledge for a project without the folder`: the GET returns `{ subjects: [], proposals: [] }`.
  - `accepting an add proposal writes the rule and removes the proposal`: after accept with body `{ text: "Edited rule" }`, the subject file holds `Edited rule` and `proposals/` is empty.
  - `accepting a remove proposal deletes the rule`.
  - `dismissing records the dismissal in the source note`.
  - `unknown proposal is 404` and `proposal id "../x" is 400`.
- [ ] **Step 2: Run** `npm run test:file -- test/project-knowledge-routes.test.ts`. Expected: FAIL (404 routes).
- [ ] **Step 3: Implement** the three routes with `zod` body parsing (`subject` slug, `text` 1–600 chars) and `assertProjectEditable` before any write.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): routes to list, accept and dismiss rule proposals`.

---

### Task 4: Side panel "Rule suggestions" card (skill UI removed)

**Files:**
- Modify: `public/index.html:358-359,403-406` (section `<details id="activityRules" class="activity-section" open>` with summary "Rule suggestions", `#activityRulesStatus` and `#activityRulesBody`; drop the skill-suggestion comment) and `:1184-1186` (remove the skill instructions textarea, status and reset)
- Modify: `public/app/elements.js:35-37,45-47` (replace the suggestion elements with `activityRulesStatus` and `activityRulesBody`; remove the skill-instruction elements)
- Modify: `public/app/activity-panel.js` (replace `renderSuggestions` and `bareSkill` with `renderRules()`; keep `skillCounts` for Statistics)
- Modify: `public/app/summary-model-settings.js:17-40,112-113` (remove the skill instruction code)
- Modify: `public/styles.css:1952-1964` (`.activity-suggestion*` becomes `.activity-rule*`; drop `.activity-skill-draft`)
- Modify: `public/sw.js:2` (drop `/app/activity-skill-draft.js`)
- Delete: `public/app/activity-skill-draft.js`
- Modify: `promo-video/landing/features.js:296-307` (describe rule suggestions instead of skill suggestions)
- Test: `test/ui/ui-activity-panel.test.ts`

**Interfaces:**
- Consumes: Task 3's routes.
- Produces (DOM contract the UI test pins):
  - Card `data-testid="activity-rule"` with an action badge (`Add`, `Remove`, `Merge`), the subject, the rule text in an editable `textarea` for `add`, and the evidence.
  - Buttons `data-testid="activity-rule-accept"` labelled **Add to knowledge** (for `add`; **Apply** for remove and merge) and `data-testid="activity-rule-dismiss"` labelled **Dismiss**.
  - Empty states:
    - no conversation open: "Rule suggestions appear once a conversation is open."
    - nothing pending: "No rule suggestions for this project."
  - Status count: the number of pending proposals.

Refresh: `renderRules()` fetches `GET /api/projects/:id/knowledge` on `activityReady`, on `activityDigestEvent` with state `done`, when the panel is opened, and after accept or dismiss. There is no timer.

- [ ] **Step 1: Update the UI test** in `test/ui/ui-activity-panel.test.ts`:
  - Replace the `@@skills` fixture lines with `@@knowledge` lines that produce one rule proposal.
  - Replace `:233` and `:240` with the `activityRules` section and its placeholder.
  - Replace `:265-316`:
    - The card shows the subject and evidence.
    - Editing the textarea and clicking **Add to knowledge** removes the card. The project folder's `.agents/knowledge/<subject>.md` then contains the edited text.
    - A second proposal dismissed with **Dismiss** disappears.
  - Delete `:393-409` (skill instructions in Settings) and assert `#summarySkillInstructions` (or the current id) is absent.
- [ ] **Step 2: Run** `npm run test:file -- test/ui/ui-activity-panel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the card and removals. Build DOM nodes with `textContent`, never `innerHTML`, because rule text is model output.
- [ ] **Step 4: Run** the UI test and `grep -rn "skill-draft\|activitySuggestions\|skillInstructions" public src`. Expected: PASS and no matches.
- [ ] **Step 5: Commit** `feat(knowledge): rule suggestions replace skill suggestions in the side panel`.

---

### Task 5: Agents see the index and know how to maintain it

**Files:**
- Create: `src/project-knowledge-agent.ts`
- Modify: `src/agent-capabilities.ts:113-185` (add capability `{ id: "project-knowledge", instructions: { path: "/virtual/JOINT_BOB_KNOWLEDGE.md", content: projectKnowledgeAgentInstructions }, environment: () => ({}) }` after `git-policy`)
- Modify: `src/agent-instructions.ts:62-90` (append `knowledgeInstructionFile(options.cwd)` when `options.cwd` is set and the file is non-null, for every harness, regardless of strict isolation)
- Test: `test/agent-instructions.test.ts`

**Interfaces:**
- Consumes: Task 1's `knowledgeDirectory`.
- Produces:
  - `projectKnowledgeAgentInstructions: string`, starting `# Project knowledge base`.
  - `knowledgeInstructionFile(cwd: string): InstructionFile | null`. It returns `null` when `<cwd>/.agents/knowledge/INDEX.md` is missing; otherwise `{ path, label: "Project knowledge", content }`, where content is the folder path plus the first 200 lines of `INDEX.md`.

The fixed section must state:
- the folder is `.agents/knowledge/` in the working folder and is committed with the project
- read `INDEX.md`, then open a subject file before work it touches
- the subject file format (copy Task 1's example)
- add a rule when the user corrects a repeated mistake; update instead of duplicating
- ask the user before removing or rewriting a rule someone else added
- never edit `notes/`, `proposals/` or `CLEANUP-LOG.md` by hand
- `INDEX.md` is regenerated from the subject files, so after a hand edit, update its line to match
- don't commit unless asked

- [ ] **Step 1: Write the failing tests** in `test/agent-instructions.test.ts`:
  - `knowledge index joins the instructions when present`: with `<cwd>/.agents/knowledge/INDEX.md` written, `agentInstructionFiles(paths, "claude", { cwd })` contains a file labelled `Project knowledge` whose content includes the index line. Repeat for `"pi"` and `"kiro"`, with strict isolation both on and off.
  - `no knowledge folder adds nothing`: without the folder, no file is labelled `Project knowledge`.
  - `capability section is listed`: `agentCapabilityInstructionFiles()` contains a file whose content starts with `# Project knowledge base`.
- [ ] **Step 2: Run** `npm run test:file -- test/agent-instructions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both pieces.
- [ ] **Step 4: Run** the test file and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): agents read the knowledge index and maintain it`.

---

### Task 6: Read-only tools for background review runs

**Files:**
- Modify: `src/server/git-review-run.ts:24-43,152` (add `readOnlyTools?: boolean` to `RunGitReviewInput`; when set, call `session.setTools(readOnlyChatTools(input.harnessId))` instead of `[]`; `readOnlyChatTools` comes from `src/server/conversation-chat-agent.ts:8`)
- Test: `test/git-review-run.test.ts` (create if missing; otherwise add to the existing review-run test)

**Interfaces:**
- Produces: `RunGitReviewInput.readOnlyTools?: boolean`. It is mutually exclusive with `useTools`; passing both throws `Error("useTools and readOnlyTools are exclusive")`.

- [ ] **Step 1: Write the failing test** with a stub harness session that records `setTools` calls:
  - `readOnlyTools` receives `readOnlyChatTools(harnessId)`.
  - The default receives `[]`.
  - Both options together throw.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(review-run): read-only tool option for background reviews`.

---

### Task 7: Nightly knowledge cleanup on relay nodes

**Files:**
- Create: `src/server/knowledge-cleanup.ts`
- Modify: `src/server.ts:168` (call `startKnowledgeCleanupScheduler()` next to `startHarnessUpdateScheduler()`)
- Test: `test/knowledge-cleanup.test.ts`

**Interfaces:**
- Consumes:
  - Task 1's module, and Task 6's `readOnlyTools`.
  - `servingSettings(db).enabled` from `src/relay/store.ts:90`, with `clusterV2Database()`.
  - `listProjects()` from `src/store.ts:490`.
  - The classifier: `activeRoutingConfig(routingConfigDatabase(), resourceOwner("project", id))?.policy.classifierId`, `getDifficultyClassifier`, and `genericSecretEnvironment(id)[classifier.variableName]`, as in `classifiedRun` (`src/server/conversation-digest-runner.ts:56-75`).
  - `decisionModelTarget` (`src/classifiers/conversation-routing.ts:47`) and `askSystemOneChoices` (`src/classifiers/typesafe.ts:134`).
- Produces:
  - `interface CleanupVerdict { ruleId: string; verdict: "keep" | "remove" | "merge"; mergeWith?: string; reason: string }`.
  - `interface CleanupDeps { review(project: ProjectRecord, subject: KnowledgeSubject): Promise<CleanupVerdict[]>; decide(project: ProjectRecord, subject: KnowledgeSubject, verdict: CleanupVerdict): Promise<{ apply: boolean; confidence: number } | null>; hasDecisionModel(project: ProjectRecord): boolean }`.
  - `cleanProjectKnowledge(project: ProjectRecord, deps: CleanupDeps, now?: Date): Promise<{ applied: number; flagged: number; skipped: boolean }>`.
  - `runKnowledgeCleanup(now?: Date): Promise<void>` runs every local project with a knowledge folder, one at a time, using the real deps.
  - `millisecondsUntilNextRun(now: Date): number`, the time to the next local 03:00 (strictly in the future).
  - `startKnowledgeCleanupScheduler(): void` uses a self-rescheduling `setTimeout(...).unref()`. At fire time it checks `servingSettings(db).enabled` and does nothing on a non-relay node. It is guarded against double start.

Real `review`:
- Calls `runGitReview` with `cwd: project.path`, `readOnlyTools: true` and `selection: { scope: "context", label: "knowledge cleanup" }`.
- Harness: the fixed summary writer when `policy.writer.source === "fixed"`, otherwise `iconHarnessId()` with empty provider and model.
- The prompt lists the subject's rules with ids and the other subjects' rule texts. It asks for one JSON object per line `{"ruleId","verdict","mergeWith","reason"}`, checking each rule against the current code and the other rules. Unparseable lines are dropped.

Real `decide`:
- One Choice question with criteria:
  - `apply`: "The rule is redundant with the named rule or contradicts the current code, so removing it loses nothing."
  - `keep`: "The rule may still be useful or the evidence is not conclusive."
- State: the rule, the reviewer's reason, the merge target text and the subject, fitted to `target.stateCharacters`.
- Returns `{ apply: choice === "apply", confidence }`, or `null` when the API returns null.

`cleanProjectKnowledge` flow:
1. Run `pruneOld`.
2. If `!deps.hasDecisionModel(project)`, append the log line `Skipped: no decision model secret for this project` and return `skipped: true`.
3. For each subject, get verdicts. For each `remove` or `merge` verdict:
   - Ask `decide`. When `apply && confidence > 0.95`, re-read the subject. If the rule's text is unchanged, apply `removeRule` and log `Removed <ruleId> from <subject> (<confidence>): <reason>`.
   - Otherwise (unchanged-check failed, null, or ≤ 0.95), write a `remove` or `merge` proposal with `source: "cleanup"` and log `Flagged <ruleId> ...`. Skip it if a pending proposal for the same `ruleId` exists.
4. Write the whole run's log lines with one `appendCleanupLog` call.

- [ ] **Step 1: Write the failing tests** with fake `CleanupDeps` and a temp project root:
  - `applies a removal above 0.95`: decide returns `{ apply: true, confidence: 0.97 }`. The rule is gone and `CLEANUP-LOG.md` has a `Removed` line.
  - `flags at exactly 0.95`: confidence `0.95` keeps the rule and creates one `remove` proposal with `source === "cleanup"`.
  - `flags when the decision model returns null`.
  - `skips a project without a decision model`: `hasDecisionModel` returns false. The rule stays, there are no proposals, the log has the `Skipped` line, and the result is `{ skipped: true }`.
  - `skips apply when the rule changed meanwhile`: the fake `decide` edits the rule text on disk before returning `0.99`. The rule keeps its new text and a proposal is created.
  - `does not duplicate a pending cleanup proposal`: two runs leave one proposal for the rule.
  - `millisecondsUntilNextRun`: from 02:59 local the result is 60,000. From 03:00:00 it is 24 hours.
  - `project without a knowledge folder does nothing`: the result is `{ applied: 0, flagged: 0, skipped: false }` and no folder is created.
- [ ] **Step 2: Run** `npm run test:file -- test/knowledge-cleanup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/server/knowledge-cleanup.ts` and wire the scheduler.
- [ ] **Step 4: Run** the test file and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): nightly relay cleanup of project knowledge`.

---

### Task 8: Documentation and full verification

**Files:**
- Create: `docs/project-knowledge.md`. It covers what gets suggested, where files live, accepting and dismissing, what agents do, and the nightly cleanup with its 95% rule and its need for a decision-model secret attached and replicated to the relay.
- Modify: `docs/index.json` and `docs/index.html` (add the page, following the existing entries)
- Modify: `docs/superpowers/specs/2026-11-03-project-knowledge-base-design.md` (notes and proposals are `.json`)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run** `npm run typecheck`, `npm test` and `npm run test:ui`. Expected: no new failures compared with `main` (see memory "worktree test baseline" for known environmental failures).
- [ ] **Step 3: Commit** `docs: project knowledge base`.
