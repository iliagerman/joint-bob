<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
- 2026-08-28T11:33:29Z — treated the zero-Unit bugfix as one plan rooted in Requirements Analysis and the brownfield workspace; no Unit DAG or synthetic Unit path exists
- 2026-08-28T11:33:29Z — treated current `.sync-conflict-*` filtering as a partial working-tree fix rather than completed recovery; it hides duplicates but does not satisfy canonical selection or preservation
- 2026-08-28T12:43:20Z — implemented coherence as ordered preservation of every valid canonical event identity; recency only ranks candidates after this preservation check
- 2026-08-28T12:43:20Z — treated destination `owned` at source epoch plus one as the sole transfer commit boundary; source `transferring` remains fail-closed across lost acknowledgements

## Deviations
- 2026-08-28T11:33:29Z — did not plan a new test configuration file despite the generic stage checklist; the existing file-scoped Node and tsx runner is already runnable and a new config would add no capability
- 2026-08-28T12:43:20Z — production-node deployment checks remain for Build and Test because this dispatch supplied neither the two commands nor their pass criteria; all local focused, typecheck, suite, and build checks passed

## Tradeoffs
- 2026-08-28T11:33:29Z — selected Node built-ins, existing SQLite replication, and current WebSocket paths over new dependencies or services; this is the smallest durable brownfield change
- 2026-08-28T11:33:29Z — retained the existing Syncthing cache-ignore implementation and planned verification only; rewriting code already present in HEAD would create unrelated churn
- 2026-08-28T12:43:20Z — selected the lowest fixed-member node as ownership claim coordinator so concurrent claims serialize without adding a consensus service; any unavailable captured member blocks the claim

## Open questions
- 2026-08-28T11:33:29Z — requirements review is NOT-READY on transcript completeness and ownership failure semantics; Part 2 needs explicit approval of the plan's coherence and epoch-idempotent transfer rules before source generation
- 2026-08-28T11:33:29Z — NFR8 does not name production-node deployment checks or success criteria; Build and Test needs those commands before final delivery
- 2026-08-28T12:43:20Z — beecomm still needs its operational Syncthing rescan/status verification on both production nodes

## Revision notes
- 2026-08-28T13:51:03Z — moved transcript recovery out of listing; explicit recovery now fences every captured node, refuses any open local Pi session, and compares a canonical SHA-256 snapshot immediately before replacement
- 2026-08-28T13:51:03Z — replaced one-step claim replication with all-member compare-and-set preparation plus exact-state owner commit; stale records reject and same-epoch owner disagreement persists `conflict`
- 2026-08-28T13:51:03Z — bound destination transfer to machine authentication, source identity, and a replicated source-authored `transferring` record; added path-preserving Claude transfer and idempotent lost-acknowledgement handling
- 2026-08-28T13:51:03Z — separated read-only open from mutation ownership; legacy ownerless conversations claim through the same all-member protocol only when a mutation or invocation begins
- 2026-08-28T13:51:03Z — replaced the simulated mesh test with two real server processes and HTTP/WebSocket coverage; final local verification passed all five focused commands, typecheck, 272 tests, and build
- 2026-08-28T14:20:00Z — bound machine bearer credentials to persisted peer identities; ownership apply and transfer receive now derive source authorship from authentication and reject Pi and Claude spoof assertions
- 2026-08-28T14:20:00Z — held process-isolated Pi and Claude owner stub turns open while non-owner continuations were rejected; each boundary proves exactly one engine invocation and two-record transcript mutation
- 2026-08-28T14:20:00Z — marked FR5.3 and NFR8 `Deferred`, the validator's accepted unmet status, until Build and Test runs beecomm and installed-node checks
