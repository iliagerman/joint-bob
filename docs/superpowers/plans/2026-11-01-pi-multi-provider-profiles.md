# Pi multi-provider profiles implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure several provider accounts inside one Pi profile or separate Pi profiles, with strict selected-profile credential isolation.

**Architecture:** Introduce the `pi` profile kind without migrating existing Claude or ChatGPT profiles. Use each profile's private SDK credential store for all its provider IDs, discover login methods from Pi, and resolve Pi-kind selections before legacy per-provider selections.

**Tech Stack:** TypeScript, Pi SDK 1.4.0 ModelRuntime, SQLite, Express, browser JavaScript, Node test runner, isolated Playwright tests.

**Spec:** `docs/superpowers/specs/2026-11-01-pi-multi-provider-profiles-design.md`

## Global constraints

- Claude profiles stay separate. Existing ChatGPT profiles keep working.
- A selected Pi profile is an exclusive credential boundary.
- New Pi-profile credentials remain node-local.
- Keep management inside Settings > Harnesses.
- No automatic account migration, new secret synchronization, automatic fallback-model guessing, custom-endpoint editor, new provider implementation, deployment, or unrelated UI refactoring.
- Preserve the earlier uncommitted model-list and profile-name fixes and all unrelated shared-checkout edits.

## Review focus

- Two profiles for the same provider must never share or overwrite credentials.
- Missing selected-profile credentials must never use environment, machine auth, or another user's account.
- Removing one provider preserves other providers and saved scope selections.
- Replicated metadata must not imply local authentication or cause API-key transfer through OAuth token routes.
- A legacy ChatGPT selection or pool must still resolve when no Pi-kind selection exists.

## File boundaries

- `src/provider-profiles/store.ts`: profile kind, existing ownership and selection persistence.
- New `src/provider-profiles/pi-credentials.ts`: provider metadata and per-profile SDK authentication; keep Claude-specific identity and twin behavior in `service.ts`.
- `src/provider-profiles/service.ts`, `pi.ts`, and `src/pi-service.ts`: profile resolution, credential hooks, model availability.
- `src/server/routes/provider-profiles.ts`: authenticated provider management endpoints.
- `src/provider-profiles/pools.ts`, `pool-execution.ts`, `pool-sharing.ts`, `context.ts`, and `src/server/harness-chat.ts`: generic Pi-member compatibility without changing legacy model fallback semantics.
- `public/app/provider-profiles.js` and a new `public/app/pi-profile-providers.js`: profile management plus focused provider editor. Existing scope/automation selectors retain their current structure.
- Corresponding store/API/execution/pool tests and a focused browser journey.

### Task 1: Store Pi profiles and manage independent provider credentials

**Files:** Modify `src/provider-profiles/store.ts`, `src/server/routes/provider-profiles.ts`; create `src/provider-profiles/pi-credentials.ts`, `test/pi-profile-credentials.test.ts`; extend `test/provider-profiles.test.ts`, `test/provider-profile-api.test.ts`.

**Interfaces:**
- Extend `ProfileProvider` with `"pi"`; do not rename existing values.
- Export `piProfileProviders(profile: ProviderProfile): Promise<Array<{ id: string; name: string; methods: Array<{ id: string; label: string }>; configured: boolean }>>`.
- Export `startPiProfileLogin(owner: string, profileId: string, providerId: string, methodId: string): Promise<ProfileLoginStatus>` using SDK login and existing safe interaction handling.
- Export `removePiProfileProvider(profile: ProviderProfile, providerId: string): Promise<void>` and `piProfileCredential(profile: ProviderProfile, providerId: string): Promise<ProfileCredential | undefined>`.
- Provider operations require an owned Pi-kind profile. Runtime credentials use the existing per-profile auth path. Do not put secrets in profile metadata.
- Add GET `/:id/providers`, POST `/:id/providers/:providerId/login`, and DELETE `/:id/providers/:providerId` below `/api/provider-profiles`. Login body is `{ methodId }`; answers/status/cancel reuse existing profile-login endpoints. Enforce existing busy checks and login serialization.

- [ ] Write failing tests that create `provider: "pi"`, configure synthetic `zai` and `openai` credentials in one profile, create a second `zai` profile, and remove only the first profile's `zai` credential. Assert the other entries remain unchanged, unauthorized owners fail, and status contains no secrets.
- [ ] Run `npm run test:file -- test/pi-profile-credentials.test.ts test/provider-profiles.test.ts test/provider-profile-api.test.ts`; confirm new assertions fail before implementation.
- [ ] Implement using the installed SDK's provider definitions and supported login methods. Read exact exported declarations before choosing persistence calls; never emulate an auth-file write with an uncoordinated read/overwrite. Keep `ModelRuntime.create` and file permissions consistent with `profileModelRuntime`.
- [ ] Extend logout/delete/status to handle an entire Pi profile without invoking Claude migration or pretending all credentials are OAuth. Explicitly reject Pi-kind requests on existing OAuth token-borrowing endpoints.
- [ ] Run the focused tests plus `npm run typecheck`. Assert API-key and OAuth prompt answers are absent from response metadata and logs, using synthetic fixture drivers rather than real provider requests.

### Task 2: Route Pi models exclusively through the selected profile

**Files:** Modify `src/provider-profiles/service.ts`, `src/provider-profiles/pi.ts`, `src/pi-service.ts`; extend `test/provider-profile-execution.test.ts`, `test/pi-profile-models.test.ts`, `test/provider-profile-access.test.ts`, and `test/automation-profile-assignment.test.ts`.

**Interfaces:**
- `projectProviderProfile(projectId, conversationId, provider)` checks a Pi-kind scope selection for Pi execution before legacy provider-specific resolution. Claude execution must not pick it accidentally; add an explicit execution-kind argument or separate Pi resolver at the call boundary.
- `piProfileCredential` is the sole credential source for every provider in a selected Pi-kind profile. Credential-list hooks list only that profile's entries. Missing entries throw a clear selected-profile/provider error before requesting the model.
- Model availability accepts API-key and OAuth entries under their actual provider IDs. Scope-aware model validation must not reject an executable selected-profile model or authorize a different account.

- [ ] Add failing tests for same-provider account separation, switching models between `zai` and `openai` inside one profile, default/workspace/project/conversation precedence, and explicit automation assignment.
- [ ] Add an ambient machine credential to the missing-provider test; assert it is not read. Assert revoked/shared-in-interactive profiles still fail closed.
- [ ] Run the targeted files via `npm run test:file --`; confirm the new expectations fail.
- [ ] Implement resolution and hooks. Preserve existing unassigned administrator behavior and legacy Claude/ChatGPT resolution when no Pi-kind selection applies.
- [ ] Run the targeted files and existing login/twin tests. Verify a replicated Pi profile without local credentials reports missing local configuration and never borrows an API key.

### Task 3: Integrate Pi profile selection with existing pools

**Files:** Modify `src/provider-profiles/pools.ts`, `pool-execution.ts`, `pool-sharing.ts`, `context.ts`, `src/server/harness-chat.ts`; extend the existing subscription-pool execution, sharing, and store tests located by `ls test/*pool*`.

**Interfaces:**
- Pool member kind can be `pi`, distinct from its requested model provider.
- A Pi member can run the current requested provider/model only through its own credentials. Missing provider credentials classify the member as unavailable before output starts, allowing the next member.
- Legacy `fallbackModels.claude` and `fallbackModels["openai-codex"]` retain their formats and behavior. No new arbitrary-provider model guessing.
- Claude harness pool attempts never select a Pi-kind member. Remote Pi-member credentials remain local; a node cannot run an unconfigured remote member by exporting its API keys.

- [ ] Add failing tests for a z.ai turn with two single-provider Pi profiles, a multi-provider Pi member, a missing-provider member followed by an eligible member, and Claude-harness exclusion.
- [ ] Add regressions for legacy mixed Claude/ChatGPT pools and signed manifests containing Pi-kind metadata without credentials.
- [ ] Run the affected pool tests and confirm new assertions fail, implement minimal compatibility updates, then rerun with harness-chat and profile execution tests.

### Task 4: Build provider management UI and run acceptance journeys

**Files:** Modify `public/app/provider-profiles.js`; create `public/app/pi-profile-providers.js`, `test/ui/ui-pi-profile-providers.test.ts`; extend `test/ui/ui-provider-profiles.test.ts`, `test/ui/ui-subscription-pools.test.ts`; modify `public/styles.css` only for necessary new controls, preserving unrelated edits.

**Interfaces:**
- The profile type selector offers Pi without removing Claude or ChatGPT.
- Pi profile rows show provider names and per-provider configured status. A searchable provider selector uses Task 1 metadata and its supported login methods. Reuse existing safe prompts for API keys, OAuth, and required provider metadata.
- Disconnect targets one provider. A saved key is never rendered again. Provider lists paginate to fit available height.
- Scope and automation selectors offer Pi profiles; unavailable saved assignments remain visible. Pool editing labels Pi members accurately without presenting `pi` as an actual model provider.

- [ ] Add a failing isolated browser journey creating one profile with z.ai plus OpenAI and two profiles with one provider each. Use synthetic auth fixtures, assert no key in rendered status, disconnect z.ai, and verify OpenAI remains configured after reload.
- [ ] Run through `npm run test:file -- test/ui/ui-pi-profile-providers.test.ts`; verify failure, then implement the focused UI.
- [ ] Run `npm run typecheck`, `npm run build`, the affected unit/API/harness/pool tests, and the three profile/pool UI tests using the documented isolated harness. Inspect exit codes and assertions before claiming completion.
- [ ] Review the diff for secret exposure, unintended migrations, unrelated changes, and preservation of previous uncommitted fixes. Use only synthetic credentials; report any verification limitations explicitly.
- [ ] Commit atomic task changes only with a private Git index after checking shared-tree safety instructions. Do not sweep unrelated hunks, create branches/worktrees, push, or deploy as part of this plan.
