# Requirements — Scoped Secrets

**Intent**: `260830-scoped-secrets`
**Scope**: express · **Depth**: Minimal · **Test Strategy**: Minimal
**Repository**: `joint-bob` (brownfield)

## Sources

- Initial description: the intent's verbatim five-point description recorded at
  `## Project Information` → `**Project**` in
  `aidlc/spaces/default/intents/260830-scoped-secrets/aidlc-state.md`.
- Workflow-selected scope: `express`.
- `business-overview` — `aidlc/spaces/default/codekb/joint-bob/business-overview.md`
  (the credential domain, the two overlapping credential systems, the business
  rules a redesign must preserve).
- `architecture` — `aidlc/spaces/default/codekb/joint-bob/architecture.md`
  (single-shot spawn injection, three replication pipelines, the architectural
  constraints a change must respect).
- `code-structure` — `aidlc/spaces/default/codekb/joint-bob/code-structure.md`
  (module inventory and the code patterns a change must follow).
- `requirements-analysis-questions.md` — the answered clarifying and follow-up
  questions in this directory, including the confirmed consolidated summary.
- `intent-statement` and `scope-document` are **not available**: the Ideation
  phase is SKIP under the `express` scope, so no intent or scope artifact was
  produced. The initial description above stands in for both.
- `team-practices` are **not available**: `practices-discovery` is SKIP under the
  `express` scope, and `aidlc/spaces/default/memory/team.md` is an unpopulated
  template, so the framework defaults in `org.md` apply (test-after ordering,
  Minimal test volume, trunk-based squash merge).

## Intent Analysis

**What the user is trying to achieve.** Today `joint-bob` carries two credential
systems that overlap but share no model: GitHub credential groups (9 tables, a
four-tier resolution chain, its own replication pipeline) and generic secret
accounts (2 tables, a two-tier merge, deliberately node-local). The goal is
**one** credential model. GitHub stops being special: its push token becomes an
ordinary secret variable inside an ordinary secret account, and `git push`
resolves it from the same environment as everything else.

The second half of the goal is **the right grouping**. A "project type" is
currently a filesystem-coupled category that a credential group can hang off. The
user's mental model is a **workspace** — a logical glue between related projects
(`personal`, `work`) — and that workspace is the broad tier of secret scoping,
which is what makes the GitHub group concept redundant rather than merely
renamed.

The third is **reach**: scoping gains a conversation tier, so one conversation can
authenticate as a different identity from the rest of its project.

Success is: an agent does authenticated work (`git push`, `gh`, `aws`) with no key
ever visible to the agent or the browser, the identity it uses is predictable from
one resolution rule, and no credential is stranded by a rename, merge or delete.

## Functional Requirements

### FR1 — Workspaces replace project types

- **FR1.1** Every occurrence of the "project type" concept is renamed to
  "workspace" in the UI, the HTTP API paths and payloads, the client code, the
  server code, and the database schema (table and column names) via a schema
  migration.
- **FR1.2** On-disk directory names and Syncthing folder configuration are **not**
  changed by the rename: no directory is moved and no Syncthing folder is
  reconfigured as a result of FR1.1.
- **FR1.3** Existing rows survive the rename with their identity intact: the two
  entities currently shown in Settings as project types (`personal`, `work`) appear
  afterwards as workspaces with the same ids, labels and project memberships.
- **FR1.4** A project belongs to exactly one workspace, as it belongs to exactly
  one project type today.
- **FR1.5** The existing safe-rename property is preserved: a workspace's id is
  stable, so changing its label never breaks a project membership or a secret
  attachment.

### FR2 — The GitHub credential group concept is removed

- **FR2.1** The GitHub credential group model is removed in full: its tables, its
  server module (`src/github-auth.ts`), its HTTP routes, and its dedicated
  replication pipeline.
- **FR2.2** The GitHub UI surfaces are removed: the `githubGroupDialog` and
  `githubSyncDialog`, the group picker on project-type rows, and the per-project
  "GitHub access" override.
- **FR2.3** Nothing in the resolution path is special-cased by provider after this
  change: a GitHub token is resolved by the same code path as an AWS or Google
  variable.
- **FR2.4** The four-tier group chain (project token override → project group →
  project-type group → default group) ceases to exist and is replaced by FR4's
  three-tier resolution.

### FR3 — Secret accounts attach at three scopes

- **FR3.1** A secret account can be attached to a **workspace**, a **project**, or
  a **conversation**.
- **FR3.2** A conversation is identified per engine by its session id, as already
  established in `src/conversation-ownership.ts`.
- **FR3.3** A secret account is **inert** until it is attached to at least one
  workspace, project or conversation: an unattached account contributes nothing to
  any agent environment.
- **FR3.4** One account may be attached at several scopes and to several entities
  at once.
- **FR3.5** Attachments record which account is attached to which entity; they do
  not copy the account's variables.

### FR4 — Resolution is most-specific-wins, per variable name

- **FR4.1** Resolution merges the attached accounts of the three scopes in the
  order workspace → project → conversation, and the merge is performed **per
  variable name**.
- **FR4.2** A conversation-scoped value overrides a project-scoped value of the
  same variable name; a project-scoped value overrides a workspace-scoped one.
- **FR4.3** A variable defined at only one scope resolves to that scope's value
  regardless of what other variables the other scopes define.
- **FR4.4** When two accounts attached at the **same** scope to the same entity
  define the same variable name, the outcome is deterministic and documented (see
  Open Questions OQ1).

### FR5 — The `git push` environment contract

- **FR5.1** A `github`-provider secret account exposes **fixed** variable names
  that the user does not type.
- **FR5.2** The single resolved GitHub token value is exported to the agent process
  as `GH_TOKEN`, `GITHUB_TOKEN` and `PI_GITHUB_TOKEN` simultaneously.
- **FR5.3** The same resolved value generates the `GIT_ASKPASS` helper script used
  by `git push`, so the `gh` CLI and `git push` always authenticate as the same
  identity.
- **FR5.4** `GIT_TERMINAL_PROMPT` continues to be set as it is today, so a missing
  credential fails rather than blocking on an interactive prompt.
- **FR5.5** When no GitHub token resolves for a project, no `GIT_ASKPASS` helper is
  generated and the GitHub variables are absent from the environment.

### FR6 — Migration from the existing credentials

- **FR6.1** The migration runs once per node, is idempotent, and follows the
  existing per-module marker-table convention used by every prior schema change in
  this repository.
- **FR6.2** Each existing GitHub credential group becomes one secret account, named
  after the group's label, of provider `github`, holding that group's token.
- **FR6.3** A group assigned to a project type becomes an attachment of that
  group's account on the corresponding workspace.
- **FR6.4** A group assigned to a project becomes an attachment of that group's
  account on that project.
- **FR6.5** A per-project token override becomes its own project-scoped secret
  account attached to that project.
- **FR6.6** The default group's account is attached to every workspace that does
  not already resolve a token of its own after FR6.3–FR6.5, so that every project
  authenticating today still authenticates afterwards with the same token.
- **FR6.7** Group tokens that were previously replicated to other cluster nodes
  keep working: each node migrates its own local copy in place, so a token that
  already reached a peer remains usable on that peer.
- **FR6.8** The migration is verifiable: for every project, the token that resolves
  after migration is the token that resolved before it.

### FR7 — Per-account replication

- **FR7.1** Each secret account carries a replication setting: replicate to paired
  nodes, or stay node-local.
- **FR7.2** A node-local account never leaves the node under any pipeline.
- **FR7.3** A replicating account's material is encrypted at rest on both sides and
  is re-encrypted with the receiving node's own key on arrival, as the current
  GitHub credential pipeline already does.
- **FR7.4** A receiving node may overwrite a received account with its own version;
  the local version wins after such an overwrite.
- **FR7.5** The replication setting defaults to node-local for accounts created
  after this change.

### FR8 — Attachment lifecycle and cleanup

- **FR8.1** Attachments are re-keyed when two projects are merged by alias, so a
  merge never strands an attachment (fixes the defect at `store.ts:249`, where
  `rekeyProjectState` re-keys tasks, handoffs, names and GitHub project auth but
  not `secret_assignments`).
- **FR8.2** Deleting a project deletes its attachments.
- **FR8.3** Deleting a workspace deletes its attachments.
- **FR8.4** Deleting a secret account deletes all of its attachments at every
  scope.
- **FR8.5** A dangling attachment never blocks resolution: it is ignored, and
  resolution falls through to the remaining scopes.

### FR9 — User interface

- **FR9.1** The user can attach an existing secret account at all three levels by
  selecting from the list of available accounts.
- **FR9.2** Workspace attachments are managed from the workspace's settings row.
- **FR9.3** Project attachments are managed from the project's settings.
- **FR9.4** Conversation attachments can be chosen in the **new-conversation
  dialog**, so a brand-new conversation carries its secrets from its first turn.
- **FR9.5** Attaching or detaching on a conversation that is already running is
  saved but takes effect the next time that conversation runs; the running agent
  process is not restarted.
- **FR9.6** Every attachment surface shows which account is attached and at which
  scope, and allows detaching.
- **FR9.7** Secret **values** are never sent to the browser at any of the three
  scopes: the client renders account names, variable names and kinds only.

## Non-Functional Requirements

- **NFR1 — Secrecy at rest.** Every secret value remains AES-256-GCM encrypted at
  rest with the node's `secret.key`, and file-kind material keeps mode `0600`
  inside a `0700` directory. No plaintext secret is written to the database, to a
  log, or to an audit event.
- **NFR2 — Secrecy in transit to the browser.** No HTTP response to the client
  contains a secret value. Verifiable by asserting that every secrets endpoint's
  response body contains metadata fields only.
- **NFR3 — No accidental egress.** A node-local account is never transmitted to a
  peer. Verifiable by asserting that a node-local account produces no outbound
  replication row.
- **NFR4 — Resolution determinism.** For a given (workspace, project,
  conversation) triple and a given set of attachments, the resolved environment is
  identical on every evaluation. Verifiable by a repeated-resolution test.
- **NFR5 — Migration safety.** The migration is idempotent: running it twice
  produces the same rows as running it once, and it never deletes credential
  material it has not successfully converted.
- **NFR6 — No regression in existing behaviour.** The existing test suite remains
  green after the change (`org.md` § Testing Posture, `express` scope: minimal new
  tests, existing suite green).
- **NFR7 — Backward tolerance across node builds.** A paired node running an older
  build must not be corrupted by the change; incompatible wire input is rejected
  rather than half-applied.

## Constraints

- **C1 — Single-shot injection.** An agent's environment is composed once, at
  spawn, at four call sites fed by `agentEnvironment()` (`src/secrets.ts:235`).
  There is no mechanism to change a running process's environment. FR9.4 and FR9.5
  exist precisely because of this constraint.
- **C2 — The environment is the credential contract.** Everything downstream
  (`gh`, `git push`, `aws`, `gcloud`) depends only on what those four spawn sites
  put in the child environment.
- **C3 — No migration owner exists.** There is no schema version and no central
  migration runner; a schema change must follow the existing per-module
  marker-table convention.
- **C4 — Project identity is aliased.** `resolveProjectId` / `resolveProjectAlias`
  is implemented three times, and alias merges re-key project state. Attachment
  storage must participate in that re-keying (FR8.1).
- **C5 — Workspaces stay filesystem-coupled.** A workspace id is still a real
  directory name under the managed home; FR1.2 keeps this out of scope for the
  rename, so the coupling itself is unchanged.
- **C6 — Peers may run different builds** (`architecture.md` § Architectural
  constraints), which is what NFR7 responds to.
- **C7 — Single-user product.** There is no tenant, organisation or role model;
  scoping is not an authorization feature.
- **C8 — Trunk-based delivery** with squash merge to `main`, per
  `aidlc/spaces/default/memory/org.md` § Way of Working.

## Assumptions

- **A1** The default group's account is attached only to workspaces that do not
  already resolve a token of their own (FR6.6). Rationale: this is the faithful
  translation of today's four-tier fall-through into the three-tier model, and it
  preserves each project's current identity. Confirmed by the user at the
  consolidated summary.
- **A2** "Workspace" is a rename and re-purposing of the existing project-type
  entity, not a new entity alongside it. Rationale: the user identified today's
  `personal` and `work` project types as the workspaces themselves.
- **A3** The conversation tier uses the session id already derived per engine in
  `src/conversation-ownership.ts`; no new conversation identity is introduced.
- **A4** Provider categories (`aws`, `google`, `github`, `custom`) survive the
  change; only `github`'s privileged status disappears, and its fixed variable
  names (FR5.1) are a property of the provider, not a special code path.
- **A5** The embedded terminal continues to receive no credentials, as today; this
  change does not extend the environment contract to `terminal-session.ts`.

## Out of Scope

- Moving on-disk directories or reconfiguring Syncthing folders as part of the
  rename (FR1.2).
- Extending credential injection to the embedded terminal (A5).
- Any multi-user, role or permission model around secrets (C7).
- Changing how secrets are encrypted, or where the node key lives.
- Re-designing the generic replication outbox; FR7 reuses the existing
  credential-pipeline mechanics rather than replacing them.
- Automatic, non-opt-in replication of credentials to every peer.

## Open Questions

- **OQ1** When two accounts are attached at the same scope to the same entity and
  both define the same variable name, which wins? A deterministic rule is required
  by FR4.4 (candidates: most recently attached wins, or attachment order is
  user-orderable). To be settled in Code Generation if not raised earlier.
- **OQ2** Whether a replicating account's arrival on a peer should be visible in
  that peer's UI as "received from <node>", or silently merged. Affects FR7.4's
  overwrite gesture only.
- **OQ3** Whether the removal of `src/github-auth.ts` should also drop its
  tombstone and inbox tables immediately, or leave them until a later cleanup so a
  mid-upgrade peer can still deliver in-flight events (relates to NFR7).
