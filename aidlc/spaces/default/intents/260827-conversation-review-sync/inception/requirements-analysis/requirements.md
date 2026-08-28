# Requirements Analysis

## Intent Analysis

The administrator needs conversations to remain complete, unique, steerable, and correctly reviewed across synchronized Joint Bob nodes. The immediate priority is to recover the newest coherent Pi transcript, prevent multiple nodes from writing the same conversation, and prove the prevention with a two-node regression.

The workflow's active project description explicitly includes delayed streaming, mark-all-reviewed rollback, and the Syncthing generated-cache error. The confirmed Q&A narrows decisions for the newly discovered transcript-conflict portion; it does not remove the three original bug-fix concerns. This is therefore a minimal-depth brownfield fix spanning conversation discovery, node execution ownership, browser streaming, review persistence, and Syncthing policy.

## Functional Requirements

### Canonical transcript recovery and discovery

- **FR1:** Joint Bob shall expose exactly one conversation for all transcript files belonging to the same Pi session.
- **FR1.1:** Joint Bob shall recognize Syncthing `.sync-conflict-*` transcript names and associate them with the canonical Pi session identifier.
- **FR1.2:** A candidate is valid only when every nonblank line parses as JSON, the first record is a supported Pi `session` header whose `id` matches the filename's session identifier, every event timestamp used for ordering is a valid ISO instant, and Pi's `SessionManager` can load the file. If no candidate is valid, Joint Bob shall leave every file in place, expose no recovered conversation, and report an explicit recovery error.
- **FR1.3:** Joint Bob shall rank valid candidates by the greatest event `timestamp` in the transcript. Equal timestamps shall prefer the unsuffixed canonical path; any remaining tie shall use lexical absolute-path order. When the selected file is a conflict copy, Joint Bob shall atomically replace the canonical path with that selected transcript.
- **FR1.4:** After canonical replacement succeeds, Joint Bob shall move all non-selected conflict copies out of the synchronized transcript tree into a Joint Bob subdirectory of the operating-system temporary directory, allowing normal system cleanup instead of deleting them directly.
- **FR1.5:** Recovery shall preserve the complete selected transcript. For the reported conversation, the displayed history shall include the Wolt analysis and the later test and production-deployment messages.
- **FR1.6:** Session listing, review state, watches, and resume operations shall use only the selected canonical path after recovery.

### Single execution-node ownership

- **FR2:** Exactly one Joint Bob node shall hold execution ownership for a conversation at a time.
- **FR2.1:** The authoritative ownership record shall be application-replicated state keyed by engine and session ID, containing the owner node ID, a monotonically increasing epoch, and an `owned` or `transferring` status. Conversation reads may occur on any paired node, but a node may write only when its persisted record names that node at the highest observed epoch with status `owned`.
- **FR2.2:** The node creating a new conversation shall persist epoch 1 ownership before creating the transcript. Claiming an existing unowned conversation shall require a compare-and-set acknowledgement from every active cluster member; if any member is unavailable or reports an owner, the claim shall fail without transcript modification.
- **FR2.3:** A non-owner execution attempt shall not invoke Pi or Claude or modify the transcript and shall return a conflict response naming the current owner and the explicit transfer action.
- **FR2.4:** Changing nodes shall use the existing transfer action. The source shall persist `transferring` and stop writes before the destination can persist the next `owned` epoch. The destination commit is the observable transfer boundary. Source or destination unavailability shall fail closed without granting destination ownership.
- **FR2.5:** Ownership shall survive restart through persisted replicated records. Higher epochs supersede lower epochs; conflicting owners at one epoch are invalid state and shall block all writes with a diagnostic error rather than choosing a winner. A source that has committed transfer shall remain non-owner after restart.

### Stream visibility and steering

- **FR3:** For both Pi and Claude, the first nonempty agent text delta shall become browser-visible before that turn's completion event.
- **FR3.1:** For both engines, a prompt submitted while a turn is active shall be acknowledged immediately, shown as queued, and executed once after the active turn. Pi may use its native `followUp` queue; Claude shall use Joint Bob's server-side one-at-a-time queue. Abort remains an immediate command and is not queued.
- **FR3.2:** Turn finalization shall not duplicate or discard text already rendered from deltas. Unsupported active-turn commands shall return an explicit error and shall not alter the queue.

### Review-state correctness

- **FR4:** Mark-all-reviewed shall classify activity against the per-session activity watermark visible when the administrator clicks the action.
- **FR4.1:** The browser shall submit each selected session path with its displayed `updatedAt` watermark. In one server transaction, `reviewed_at` shall advance only through that submitted watermark while `last_activity_at` retains the greatest server-observed activity.
- **FR4.2:** Activity at or before the submitted watermark shall be reviewed; any greater server-observed activity shall remain `needs_review`. Single-conversation review shall use the same watermark rule.

### Syncthing generated-cache reconciliation

- **FR5:** Joint Bob shall reconcile the managed Python `__pycache__` ignore rule to Syncthing delete-allowed semantics.
- **FR5.1:** The obsolete managed form shall be removed without changing unrelated managed or user-authored ignore rules.
- **FR5.2:** Delete-allowed semantics shall not be applied to credentials, environment files, logs, source files, or arbitrary user ignores.
- **FR5.3:** Reconciliation shall clear the reported blocked-delete condition for the `beecomm` synchronized folder.

## Non-Functional Requirements

- **NFR1 — Reliability:** A two-node integration test shall reproduce the prior divergent-writer scenario and demonstrate that the second writer is rejected or routed through explicit transfer without creating a `.sync-conflict-*` transcript.
- **NFR2 — Data integrity:** Transcript recovery and ownership transfer shall use atomic filesystem or persistence operations so interruption cannot leave a partially written canonical transcript or two authorized writers.
- **NFR3 — Preservation:** Non-selected transcript copies shall first be moved outside the synchronized tree; recovery shall not silently delete transcript data.
- **NFR4 — Performance:** Canonical discovery shall perform one directory enumeration and parse only files belonging to groups with conflict candidates. An automated 1,000-path fixture shall complete without super-linear growth: doubling paths from 500 to 1,000 shall take no more than 2.5 times the median duration in the same test process.
- **NFR5 — Security:** Existing authentication, project-path boundaries, private-network restrictions, and machine credential handling shall remain unchanged.
- **NFR6 — Observability:** Rejected writes, ownership transitions, recovery moves, and recovery failures shall emit structured server diagnostics containing event name, engine, session ID, local node ID, owner node ID when known, and error reason, but no transcript content or credentials.
- **NFR7 — Compatibility:** Regression coverage shall include Pi and Claude listing/resume tests, session-transfer API tests, WebSocket delta and queued-follow-up tests, single and bulk conversation-review API tests, and Syncthing managed-ignore tests.
- **NFR8 — Verification:** `npm run typecheck`, `npm test`, and `npm run build` shall pass before delivery. Relevant deployment checks shall pass on both production nodes.

## User and Error Scenarios

1. The administrator opens a project containing a canonical transcript and older conflict copies; one complete conversation appears and older copies leave the synchronized tree.
2. The newest valid transcript is itself a conflict copy; it becomes canonical without losing its later messages.
3. Two nodes attempt to continue one conversation; only the owner writes, and the other node receives an actionable ownership/transfer response.
4. The administrator explicitly transfers the conversation; the destination becomes the sole writer and can continue from the canonical transcript.
5. A transcript copy is malformed; it is not selected over a valid coherent transcript merely because its filesystem timestamp is newer, and recovery reports the failure explicitly.
6. The administrator marks all conversations reviewed while discovery activity changes; only activity after the operation becomes pending.
7. Syncthing reconciles generated-cache ignores without broadening delete permission to protected or user-authored ignores.

## Constraints

- Pi and Claude own their transcript formats; Joint Bob must preserve engine-compatible canonical files.
- SQLite application state remains node-local under `~/.joint-bob`; repositories and transcripts remain filesystem-owned.
- Syncthing continues to synchronize approved transcript content outside the Joint Bob process.
- Production runs from `~/.local/share/joint-bob/app`, not the source checkout.
- Existing project conventions require minimal changes, explicit error handling, and no speculative fallback behavior.
- Frontend shell changes require a `public/sw.js` cache-name bump and verification of every app-shell asset.

## Assumptions

- **A1 (derived implementation rule):** "Most recent" is resolved by the maximum valid Pi event timestamp with deterministic canonical-path and lexical tie-breakers. This operationalizes the confirmed request while avoiding filesystem timestamps changed by synchronization.
- **A2 (confirmed direction):** Temporary storage is outside every synchronized transcript root and is eligible for operating-system cleanup.
- **A3 (confirmed direction):** The existing conversation transfer action is the only supported way to change execution ownership.
- **A4 (evidence-based):** The identified canonical Beecomm transcript is valid and contains the requested Wolt, test, and deployment history.
- **A5 (technical):** A stable Pi session identifier can be derived from canonical and Syncthing conflict filenames without rewriting transcript events.

## Out of Scope

- Automatically merging event streams from divergent transcript copies.
- Displaying each conflict copy as a separate conversation.
- Permanently binding a conversation to its creation node.
- Disabling transcript synchronization between nodes.
- Replicating per-user review state cluster-wide.
- Applying Syncthing delete-allowed semantics to general ignored content.
- Re-architecting Joint Bob into separate services.

## Open Questions

None. The confirmed answers select newest-valid recovery, temporary relocation of older copies, single-owner execution with explicit transfer, and mandatory two-node integration coverage.

## Upstream Traceability

- The active project description supplies the bug-fix intent; the optional `intent-statement` artifact was skipped for this minimal workflow.
- Scope is the configured brownfield `bugfix`; the optional `scope-document` artifact was skipped.
- `business-overview.md` establishes the administrator workflow, transcript ownership, review semantics, and Syncthing safety boundary.
- `architecture.md` establishes the modular-monolith, node-local SQLite, filesystem transcript, WebSocket, and peer-node boundaries.
- `code-structure.md` identifies `pi-service.ts`, `session-paths.ts`, `conversation-reviews.ts`, `syncthing.ts`, `server.ts`, `watcher.ts`, `public/app.js`, and the test layout as affected surfaces.
- Repository `AGENTS.md` files provide the applicable `team-practices`: preserve filesystem ownership, keep state node-local, make minimal changes, and run typecheck, tests, and build before delivery.

## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-product-lead-agent
**Date:** 2026-08-28T10:54:31Z
**Iteration:** 1

### Findings

| # | Severity | Location | Finding | Recommendation |
|---|---|---|---|---|
| 1 | Critical | FR1.2–FR1.5 | The selector proves parseability and loadability, not completeness or coherence. A valid but truncated conflict copy with one newer event wins under FR1.3, can replace a fuller canonical transcript, and violates the stated recovery goal plus FR1.5. | Define a measurable completeness/coherence rule and require the selected candidate to preserve the canonical history before replacement; add a fixture where the newest valid copy is truncated. |
| 2 | Major | FR2.2 | Requiring acknowledgement from “every active cluster member” is an unconfirmed product constraint and leaves “active” and the membership snapshot undefined. One unavailable paired node can block claims indefinitely, which is stricter than the confirmed single-owner-with-transfer decision. | Confirm the availability tradeoff and define the exact membership set, timeout, and user-visible recovery path, or use the existing transfer authority without adding an all-member quorum requirement. |
| 3 | Major | FR2.4–FR2.5 | The ownership transfer requirements do not define recovery when the destination commits the new epoch but its acknowledgement is lost, or when either node restarts while `transferring`. Developers and QA cannot determine the required retry, idempotency, or terminal ownership behavior. | Specify the transfer state transitions and observable outcomes for lost acknowledgement, retry, restart, timeout, and abort, including which node may write after each case. |
| 4 | Minor | NFR8 | “Relevant deployment checks” is not a pass/fail criterion because the checks and expected results are unnamed. | Name the production-node checks or reference a specific existing smoke-test command and success criteria. |

### Summary

The requirements cover all reported concern areas, but canonical recovery can still discard the most complete transcript, and execution ownership has unresolved availability and failure semantics. Engineering would need to guess at data-preservation and transfer behavior.
