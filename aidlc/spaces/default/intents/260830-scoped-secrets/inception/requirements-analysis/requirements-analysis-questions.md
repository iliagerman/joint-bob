# Requirements Analysis — Clarifying Questions

**Stage**: requirements-analysis
**Intent**: 260830-scoped-secrets
**Depth**: Minimal (answer only what is needed to proceed)

These questions come from reading the code knowledge base at
`aidlc/spaces/default/codekb/joint-bob/` against your description of the change.
Each one is a fork the implementation cannot guess.

Fill in each `[Answer]:` tag with the option letter (for example `[Answer]: B`).
For `X` write your own answer after the letter.

---

## Q1. Conversation-scoped secrets vs. one-shot injection at spawn

Secrets are injected into an agent process **once, at spawn**
(`agentEnvironment()` at `src/secrets.ts:235`, four spawn sites). There is no way
to change a running agent's environment afterwards, and a **brand-new Pi
conversation has no session id yet** at the moment it is spawned — so a
conversation-scoped secret cannot possibly apply to the first turn of a new
conversation.

How should conversation scope behave?

- A. Conversation-scoped secrets apply from the **next spawn onwards** — attach to
  an existing conversation, and it picks them up when it is resumed or continued.
  The first turn of a brand-new conversation only sees workspace + project scope.
- B. Attaching or detaching a secret account on a conversation **restarts the
  agent process** for that conversation so the new environment takes effect
  immediately.
- C. Conversation attachments can only be made on a conversation that **already
  exists** (has an id); the UI hides the option until then. Same effective
  behaviour as A but the constraint is explicit in the UI.
- D. A and C together: attachment is only offered on existing conversations, and
  it takes effect at the next spawn.
- X. Other (please specify)

[Answer]: when creating new conversatoin, form the same dialog shuld be possible to set secrers

---

## Q2. What the migration should produce from today's GitHub credentials

Today there are: named **GitHub groups** (each holding one token, exactly one
marked default), **project type → group** assignments, **project → group**
assignments, and **per-project token overrides**. All of that must land in the
new generic model without breaking `git push`.

What should the migration create?

- A. **One secret account per existing group** (named after the group's label,
  provider `github`, holding `GH_TOKEN`). The default group's account attaches at
  **workspace** scope; every project/project-type assignment becomes a matching
  attachment; each per-project token override becomes its **own project-scoped
  account**.
- B. Same as A, but per-project token overrides are folded into the existing
  per-project attachment rather than creating extra accounts (the override token
  wins and becomes that project's account).
- C. **One secret account per project** that currently resolves a token, holding
  whatever token that project resolves today — flattest possible result, no shared
  accounts, no workspace-level default.
- D. Migrate only the **default group** to a workspace-scoped account and drop the
  rest; re-attach the others by hand afterwards.
- X. Other (please specify)

[Answer]: the env var is injected to the exection with the lowest value, workspace>project>conversation conversation wins

---

## Q3. Do secret accounts replicate to paired nodes?

This is the sharpest behaviour difference between the two systems being merged.
GitHub group tokens **do** cross to paired nodes, but only when you explicitly ask
(Settings → GitHub → Sync); generic secret accounts **never** replicate and are
node-local by design. Your description says tokens already replicated to other
nodes must keep working.

After the merge:

- A. Secret accounts stay **node-local**; the migration converts each node's own
  copy in place, so an already-replicated token keeps working on the node it
  reached, and there is no ongoing sync.
- B. Keep an **explicit, opt-in sync** for secret accounts (the same "push these
  credentials to that peer" gesture that exists for groups today), now covering
  any secret account rather than only GitHub ones.
- C. Secret accounts **replicate automatically** to all paired nodes like names,
  locks, tasks and conversation ownership do.
- D. Node-local for now (A), with the explicit sync (B) recorded as a follow-up
  for a later change.
- X. Other (please specify)

[Answer]: it shuold be configurable, the can be set to replicate or not, each node can chose to overwrite them

---

## Q4. The `git push` environment contract after the change

`git push` works today only because a generated `GIT_ASKPASS` helper script feeds
git the token, alongside `PI_GITHUB_TOKEN`. Meanwhile a generic `github` account
already sets `GH_TOKEN` and `GITHUB_TOKEN` — which is exactly how the `gh` CLI and
`git push` can end up as two different identities today.

Once `GH_TOKEN` is an ordinary secret variable, what should the environment
contain?

- A. **`GH_TOKEN` is the single source.** The resolved `GH_TOKEN` also drives the
  generated `GIT_ASKPASS` helper, and `GITHUB_TOKEN` + `PI_GITHUB_TOKEN` are
  exported as aliases of the same value for compatibility.
- B. `GH_TOKEN` drives `GIT_ASKPASS`, and `GITHUB_TOKEN` is aliased, but
  **`PI_GITHUB_TOKEN` is dropped** as part of removing GitHub special-casing.
- C. **No aliasing at all** — only the variables a secret account actually
  defines are exported, and `GIT_ASKPASS` is generated whenever a variable named
  `GH_TOKEN` resolves.
- D. Any variable named `GH_TOKEN` **or** `GITHUB_TOKEN` can drive `GIT_ASKPASS`,
  with `GH_TOKEN` winning when both resolve.
- X. Other (please specify)

[Answer]: The env value from the built in secret is the one to take place, they should be hard coded the env vars.

---

## Q5. How deep does the "project type → workspace" rename go?

A project type's id is a **real directory name** under the managed home, and
changing a project's type physically relocates the directory and reconfigures its
Syncthing folder. So "rename" can mean anything from a label change to a data
migration.

- A. **UI wording only** — the screen says "Workspaces", the database table,
  columns, API paths and on-disk directories stay `project_type`.
- B. **UI + API + code naming** change to workspace; the database table/column
  names and the on-disk directory layout stay as they are (no data migration, no
  files moved).
- C. **Everything renames**, including the database table/columns and the API
  routes, but the on-disk directories keep their current names.
- D. **Everything renames including the on-disk layout** — existing project-type
  directories are moved under a new workspaces path and Syncthing folders are
  reconfigured.
- X. Other (please specify)

[Answer]:inside the settings we have currently two entites called projects persnoal and work project types, these are workspace personal and work not project types.
---

## Q6. Three existing defects that live in the tables you are changing

The scan found three real bugs in `secret_assignments`, all in the exact code this
change rewrites: assignments are **not re-keyed when two projects are merged by
alias**, **not deleted when a project is deleted**, and **not deleted when a
project type is deleted**. Each one silently strands a credential attachment.

- A. **Fix all three** as part of this change — the new scoped model should own
  its own cleanup and re-keying from the start.
- B. Fix only the **delete** cases (project and project type); leave alias
  re-keying for later.
- C. **Do not fix them now**; record them as known issues and keep this change
  focused on the model swap.
- X. Other (please specify)

[Answer]:A

---

## Follow-Up Questions

These resolve ambiguity found in the answers to Q2, Q4, Q5 and Q1.

### F1. What the one-time migration creates (follow-up to Q2)

Q2's answer described the resolution order rather than the migration output.

- A. One secret account per existing group; default group attaches at the broadest
  scope; project / project-type assignments become matching attachments; per-project
  token overrides become their own project-scoped accounts.
- B. Same as A but overrides fold into the existing per-project attachment.
- C. One secret account per project that resolves a token today.
- D. Default group only; re-attach the rest by hand.
- X. Other (please specify)

[Answer]: X. We should not have groups any more; we should have workspace as a logical glue between common projects.

### F2. What "hard-coded env vars" means (follow-up to Q4)

- A. Fixed variable names for a `github`-provider secret; the one value is exported as
  `GH_TOKEN`, `GITHUB_TOKEN` and `PI_GITHUB_TOKEN` together and also generates the
  `GIT_ASKPASS` helper, so `gh` and `git push` can never be different identities.
- B. Same but `PI_GITHUB_TOKEN` is dropped.
- C. User-named variables only; `GIT_ASKPASS` generated when a variable named `GH_TOKEN` resolves.
- X. Other (please specify)

[Answer]: A

### F3. How deep the project type -> workspace rename reaches (follow-up to Q5)

- A. UI + API + code naming; database and on-disk names unchanged.
- B. Also rename the database table and columns (schema migration); on-disk directories keep their current names.
- C. Rename everything including the on-disk layout and Syncthing folders.
- D. UI wording only.
- X. Other (please specify)

[Answer]: B

### F4. Attaching or detaching on an already-running conversation (follow-up to Q1)

- A. Takes effect the next time that conversation runs; the running agent keeps its current environment.
- B. Restart the agent process immediately.
- C. Block the change while the agent is running.
- X. Other (please specify)

[Answer]: A

---

## Consolidated Summary Confirmation

- Q1 / F4 — Conversation scope: secrets can be chosen in the new-conversation dialog, so a brand-new conversation carries them from its first turn. Attaching or detaching on an already-running conversation is saved but takes effect the next time that conversation runs.
- Q2 / F1 — GitHub credential groups are removed entirely. A workspace is the logical grouping between related projects, and it replaces the group as the broad tier. Migration turns each existing group's token into an ordinary secret account, and re-attaches it at the tier that preserves today's behaviour: a group used by a project type becomes an attachment on that workspace, a group assigned to a project becomes an attachment on that project, a per-project token override becomes a project-scoped account, and the default group's account is attached to every workspace that does not already resolve a token of its own.
- Q3 — Replication is a per-account switch: an account can be marked to replicate to paired nodes or stay node-local, and each node can overwrite what it receives.
- Q4 / F2 — A `github`-provider secret has fixed variable names you do not type. Its single value is exported as `GH_TOKEN`, `GITHUB_TOKEN` and `PI_GITHUB_TOKEN`, and generates the `GIT_ASKPASS` helper, so `gh` and `git push` always authenticate as the same identity.
- Q5 / F3 — "Project types" become "workspaces" in the UI, the API, the code and the database (table and column rename via schema migration). On-disk directory names keep their current spelling; no files move and no Syncthing folder is reconfigured.
- Q6 — All three existing `secret_assignments` defects are fixed as part of this change: re-key on project alias merge, delete on project delete, delete on workspace delete.
- Resolution order — most specific wins, per variable name: conversation overrides project, project overrides workspace.
- Inert until attached — a secret account has no effect until it is attached to at least one workspace, project or conversation.
- UI — existing secret accounts can be attached at all three levels by picking from the list of available accounts.

Does this all look correct before I generate the requirements artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
