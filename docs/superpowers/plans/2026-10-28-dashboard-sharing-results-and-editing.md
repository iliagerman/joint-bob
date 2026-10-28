# Dashboard sharing results and editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Share dashboard definitions safely, publish results only for dashboards marked credential-free, and allow explicitly authorized edits to flow back to the owner.

**Architecture:** Keep dashboard definitions outside project files and use the existing signed, dashboard-specific peer sync. Add all-project-node sharing to explicit node/cluster targets, credential classification and optional published payload to the validated share bundle. Add owner-authorized edit submission with base-digest conflict checks; existing change notices fan accepted updates out.

**Tech Stack:** TypeScript, Node.js SQLite, Express, Zod, existing dashboard storage and cluster relay.

**Spec:** `docs/superpowers/specs/2026-10-28-dashboard-sharing-results-and-editing.md`

## Global Constraints

- Credentials and secret values never travel in dashboard bundles.
- Credential-required dashboards never export payload or run logs; refresh state remains node-local.
- Received scripts remain subject to review and approval before execution.
- Project access remains a prerequisite for dashboard sharing.
- Dashboard files remain outside project folders; dashboard-specific sync remains authoritative.
- Local recipient refreshes never flow upstream.

## Review Focus

- Legacy and omitted classification must default to credential-required; test legacy manifests and newly created definitions.
- Forged edit sender or revoked edit grant must not update owner; test route authorization.
- Stale base digest must preserve the recipient draft and leave owner unchanged; test concurrent update.
- Credential-required dashboard must not leak payload/state to twin or selected peer; test bundle response.
- Project unsharing/removal must not leave results accessible; test existing cleanup path.

---

### Task 1: Credential classification and safe result bundles

**Files:**
- Modify: `src/dashboards/contract.ts`
- Modify: `src/dashboards/files.ts`
- Modify: `src/dashboards/sharing.ts`
- Modify: `src/server/dashboard-sharing.ts`
- Test: `test/dashboards-files.test.ts`
- Test: `test/dashboards-sharing.test.ts`

**Interfaces:**
- `DashboardManifest` includes `requiresCredentials: boolean`, with legacy input interpreted as `true`.
- Owner result-bundle builder returns definition plus optional published payload only when `requiresCredentials === false`.

- [x] Add tests for omitted classification defaulting to true and credential-free classification persisted in manifest.
- [x] Run targeted tests and confirm the new assertions fail.
- [x] Add safe bundle generation. Never include payload for credential-required dashboards; include published payload for credential-free dashboards and all eligible recipients.
- [x] Run dashboard file and sharing tests.

### Task 2: Result delivery and recipient display

**Files:**
- Modify: `src/server/dashboard-sharing.ts`
- Modify: `src/dashboards/files.ts`
- Modify: `public/app/dashboards.js`
- Test: `test/dashboards-sharing.test.ts`
- Test: `test/ui/dashboards-ui.test.ts`

**Interfaces:**
- Received result bundle is installed separately from definition approval; approval still gates execution, not display of a permitted published payload.
- Credential-free shared payload is labeled as owner-published with its source timestamp; recipient refresh replaces only local payload.

- [x] Add integration assertions that twins receive credential-free payload and explicitly shared peers receive it.
- [x] Add assertions that credential-required dashboards never receive payload, including twin sync.
- [x] Implement result installation/display and preserve owner-published payload on definition-only refreshes.
- [x] Run dashboard sharing and UI tests.

### Task 3: Authorized edit-back with conflict detection

**Files:**
- Modify: `src/dashboards/store.ts`
- Modify: `src/server/dashboard-sharing.ts`
- Modify: `src/server/routes/dashboards.ts`
- Modify: `public/app/dashboards.js`
- Test: `test/dashboards-sharing.test.ts`
- Test: `test/dashboards-api.test.ts`

**Interfaces:**
- Sharing record distinguishes view/edit permission per node and cluster, plus a project-wide view grant that includes future nodes with project access.
- `POST /api/dashboards/:id/draft/save` on an editable received dashboard submits `{ baseDigest, files }` through the signed `/api/cluster/v2/dashboards/edit` route. Owner validates sender's current edit grant, validates complete definition, and accepts only if `baseDigest` equals current owner digest.
- Successful owner update creates a new immutable definition digest, clears stale approval as appropriate, and announces sync. Conflict returns HTTP 409 and does not erase receiver draft.

- [x] Add route tests for view-only rejection, editor acceptance, revoked-grant rejection, and stale-digest 409.
- [x] Run tests and verify intended failures.
- [x] Implement owner-side permission validation and optimistic concurrency check.
- [x] Add UI controls for all-project-node sharing, edit access, and submitting received drafts to the owner; retain local drafts on conflict.
- [x] Run dashboard sharing and API tests.

### Task 4: Full verification and delivery

**Files:**
- Review all changes from Tasks 1–3.

- [ ] Full `npm test` timed out after 15 minutes without a final summary; dashboard sharing/API tests, typecheck, build, and `test/ui/dashboards-ui.test.ts` passed.
- [ ] Review final diff and stage only dashboard-sharing files, leaving pre-existing edits untouched.
- [ ] Commit as `feat(dashboards): sync results and authorized edits`.
- [ ] Push `main` using the configured `iliagerman` GitHub credentials; if the release gate blocks, follow its generated version-bump flow without staging unrelated work.
