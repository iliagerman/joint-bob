# Code generation summary

## Completion-gate repairs

- Machine authentication resolves the peer identity by matching the bearer credential to persisted cluster membership. Ownership apply and transfer receive derive their source from that identity and reject mismatched body assertions. Caller-controlled `X-Joint-Bob-Node-Id` is no longer used. Pi and Claude spoof regressions cover both routes.
- Pi listing and discovery are read-only. Recovery runs only through an explicit owner-only API after every captured peer accepts a `recovering` fence and no local session is open. The canonical SHA-256 snapshot is checked immediately before atomic replacement. Failed coordination leaves writes fenced.
- Ownership claims use a two-phase all-captured-member compare-and-set. Every member returns `{ accepted, current }`; the coordinator commits only after every member reports the exact `claiming` epoch, then synchronously publishes the exact `owned` state. Lower epochs reject. Same-epoch different owners persist `conflict`, which blocks every write.
- The process-isolated mesh regression holds each owner Pi and Claude stub turn open, submits the non-owner continuation before release, and proves one engine invocation plus one transcript mutation. It also covers transfer, lost acknowledgement, restart persistence, and absence of `.sync-conflict-*` files.

## Other implemented scope

- Coherent Pi conflict selection preserves canonical event identity order and keeps malformed or truncated candidates from replacing complete history.
- Pi and Claude streaming paint the first delta before finalization. Claude follow-ups run through one FIFO queue; Pi keeps native `followUp`.
- Review writes use displayed click watermarks and preserve newer server activity.
- Syncthing keeps the existing delete-allowed `__pycache__` reconciliation.
- `public/sw.js` remains `joint-bob-v39`; every `APP_SHELL` asset exists.

## Verification

Passed after the repair:

- All five exact focused commands from `unit-test-instructions.md`.
- `npm run typecheck`.
- `npm test`.
- `npm run build`.
- The focused ownership command includes authenticated-source spoof rejection and concurrent real-process Pi and Claude engine-stub boundaries.

## Remaining operational handoff

Production-node deployment checks were not run because the approved inputs still provide no commands or pass criteria. The beecomm Syncthing rescan/status check also remains unperformed. `FR5.3` and `NFR8` are `Deferred` to Build and Test until those installed-node checks produce evidence.

## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-08-28T14:24:05Z
**Iteration:** 1

### Findings

| # | Severity | Location | Finding | Recommendation |
|---|---|---|---|---|
| 1 | Critical | `source-manifest.json:4-5` | The strict source-manifest schema requires `version: 1` and permits only `stage`, `unit`, `version`, and `writes`. This artifact uses `version: 3` and the unknown `repair_iteration` field, so completion cannot bind the reviewed source set. | Restore the exact strict schema and validate it through the engine's source-manifest reader before requesting another review. |
| 2 | Major | `traceability.json` path | The actual traceability sensor returns `pass: false` because it cannot derive a construction Unit from `construction/code-generation/traceability.json`. The `Deferred` values for `FR5.3` and `NFR8` are individually valid and truthful, with nonempty Build and Test targets, but the artifact as placed does not pass its validator. | Put the artifact at the validator-supported Unit path or repair the approved zero-Unit path contract, then rerun the actual sensor. |

### Validation

| Check | Result | Evidence |
|---|---|---|
| Authenticated peer identity binding | PASS | Machine bearer credentials resolve through persisted cluster membership. Ownership apply and Pi/Claude transfer receive reject asserted-source mismatch. Focused mesh coverage passed. |
| Two-process Pi and Claude race | PASS | Real child servers held each owner engine stub turn open. The non-owner prompt raced before release. Assertions proved one owner invocation, one transcript mutation, explicit rejection, transfer, lost-ack reconciliation, restart persistence, and no sync-conflict file. |
| Recovery, claim CAS, transfer, and read-only regressions | PASS | Focused recovery and ownership commands passed. Inspection confirmed explicit recovery fencing and canonical hash recheck, all-member claim CAS, exact transfer fencing, owner checks before mutations/invocations, and non-owner listing/open without ownership claim. |
| `FR5.3` and `NFR8` deferrals | PASS | Status spelling belongs to the closed set, targets are nonempty, and both checks remain unperformed, so `Deferred` is truthful. |
| Actual traceability sensor | FAIL | `bun .claude/tools/aidlc-sensor-traceability.ts --stage code-generation --output-path .../traceability.json` returned `pass: false`: `cannot derive the construction unit from output path`. |
| Strict source-manifest schema | FAIL | `version` is `3`, and `repair_iteration` is not an allowed top-level field. |
| `npm run typecheck` | PASS | Exit 0. |
| Focused transcript recovery command | PASS | 17 tests passed. |
| Focused ownership command | PASS | 4 tests passed, including the real two-process mesh regression. |
| Focused streaming command | PASS | 10 tests passed. |
| Focused review-watermark command | PASS | 3 tests passed. |
| Focused Syncthing command | PASS | 12 tests passed. |

### Summary

Requested ownership, transfer, race, recovery, CAS, and read-only repairs now hold under inspection and focused tests. Delivery remains blocked by invalid review metadata: the source manifest violates its strict schema, and traceability does not pass the actual validator at its current zero-Unit path.
