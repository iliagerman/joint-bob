# Machine-local quality analytics

Status: approved for implementation by the user's instruction to continue through completion. Implemented in the current checkout; production collection remains off.

## Intent and agreed scope

The user wants to know whether replies improve over time, whether feedback produces useful lessons, which issue types recur or first appear, and which become less frequent after a lesson is adopted. The Homeserver is the intended collector.

There is **one machine-local aggregation setting, off by default**. Enabling it analyzes conversations already on that machine, including conversations delivered through existing authorized sync. It neither changes another machine's settings nor requests additional sharing, downloads missing conversations, takes ownership, or changes source conversations. This replaces the earlier relay-level proposal; there is no relay analytics setting or analytics replication protocol.

Persist lessons, explanations, issue classifications and numerical metrics, **not full transcripts or tool-output archives**. A source reference is an identifier, not an archived transcript. Source content is read locally for analysis and sent only to the requested Claude/Jev inference services under the existing scoped model credentials. Do not enable production collection during development; the user will turn the setting on.

## Verified starting point

Read-only checks on 2026-11-08 found 76.8 GiB free on the Homeserver, 1,882 logical conversation records across 24 projects, and a 40-day conversation retention setting. These are record counts, not a guarantee that every transcript survives locally. Its feedback records included 73 completed and 808 failed closeouts.

Existing code provides:

- `src/server/conversation-turns.ts`: local transcript loading across conversation segments. The current work includes a fix for the 50-row listing cap.
- `src/server/closeout-models.ts`: generative explanation/rule drafting followed by decision-model judgments.
- `src/server/conversation-closeout.ts`: owner-only closeout, which mutates Done/feedback and shared project proposals. **Do not invoke this workflow to backfill analytics.**
- `src/project-knowledge.ts`: accepted rules and pending proposals stored in project files; these can sync to other machines.
- `src/settings.ts`: machine settings distinct from personal settings.
- `src/relay/relay-server.ts`: an opaque transport, not authority to read passing conversations. No changes are needed there.

## Collection and storage

The following are implementation choices, not additional user requirements:

1. Add local-only SQLite tables to the node database, outside its replication/publication mechanisms. Store the toggle as a node-local setting, not a personal setting or shared resource. Do not add another database service.
2. On enable and process startup when enabled, enumerate all authorized, registered local conversations without the display-list cap. Group harness segments under the logical conversation identifier. Empty/internal analysis conversations are not user reply samples.
3. Resume a persistent local queue with one analysis job at a time. New completed turns, changed feedback and completed transcript arrival enqueue work through existing change notifications. A file arriving through sync is eligible regardless of which machine owns the conversation. Do not add a cluster polling loop or scan other machines.
4. Use content/revision fingerprints and stable reply/segment identifiers to avoid repeated calls and duplicate counting. File mtime alone is not evidence of a new reply. Do not evaluate an incomplete streaming reply. Reopened or appended conversations update the relevant observations rather than adding a second copy of prior results.
5. Disabling stops new analysis, attempts to cancel active inference using supported mechanisms, and keeps already collected results. An in-flight request may already incur provider cost. Re-enabling resumes unfinished work. Do not discard collected history on restart, source transcript expiry, or automatic source cleanup.
6. Missing, incomplete, unreadable and model-blocked inputs have visible coverage/job states. Do not fabricate a successful outcome or fetch a missing transcript. Newly arriving local evidence can make an unavailable item eligible later. Use bounded retries for transient failures, with no immediate retry storm for missing credentials.

Keep durable observations with source/project/segment/turn identifiers, source activity timestamps, evaluation timestamps, evaluator/prompt/schema versions, actual model identities, human-versus-inferred provenance, judgments/probabilities, issue identifiers, bounded reason summaries and lessons. Keep numerical usage/cost only when actually reported; unknown is not zero. Maintain processed coverage independently of retained source files.

Do not copy prompts, transcripts, tool outputs, credentials or full inference request bodies into these tables, background-job logs, model-run traces or backups of analytics data. Audit the chosen Claude execution path for native transcript persistence; an internal/hidden session name alone is not a no-persistence guarantee. Reject the integration if it cannot avoid leaving source-bearing analysis artifacts. Temporary bounded input material is released after analysis.

## Claude and Jev

Use the locally configured Claude model for generation and the existing project-authorized Jev credentials for judgments. Do not silently substitute Pi, Kiro or another decision model when one is unavailable. An unavailable model blocks only affected work and is visible to the user. Reuse existing credential scoping, usage accounting and limits; do not export or widen access to secrets.

- Claude identifies feedback-supported issues and drafts concise reasons and reusable lessons. Analysis sessions have no tools and no permission to change files or execute transcript instructions.
- Jev judges evidence/outcomes and assigns issues to existing types, including a genuine new/other option. Batch related questions sharing the same evidence in one request. Fetch current Jev documentation before integration; do not invent API fields or thresholds.
- Analyze bounded windows across long conversations rather than silently using only their last few messages. Persist coverage of the windows, not their source text.
- Human ratings and explicit corrections remain separate from inferred judgments. An assistant claiming success, conversation inactivity, or absent feedback is not proof of success. A conversation-level rating is not copied onto every reply as though each had explicit feedback.
- Keep stable issue identities. Claude can propose a new type, while Jev checks whether an existing type describes the evidence. Preserve evaluation/version provenance when categories evolve; do not silently relabel historical judgments.

Existing shared-rule learning continues unchanged. The collector records derived lessons and can associate them with **already accepted, locally visible** project rules. It does not add, accept, dismiss or rewrite shared proposals/rules. Installing new lessons remains the existing explicit project-knowledge action, outside automatic collection. Thus switching analytics on cannot change another machine's behavior.

## Metrics and access

The initial release reports quality trends, issue-type trends and collection health, not a new infrastructure-monitoring product.

Use evaluated completed replies as the denominator for reply issue rates; count a reply once for the overall issue rate even if it has multiple issues. Show human conversation ratings separately with their own denominator. Record the total eligible replies, evaluated replies, unknown outcomes and failed/missing coverage so a sparse dataset cannot appear healthy. Measure trends by source activity time, not by the day the historical backfill ran. Separate evaluator versions and distinguish human evidence from model inference.

For each issue type, expose first/last observed dates, recurrence rate, reasons, related lessons and source identifiers. Where known, associate an accepted rule's actual adoption date and show comparable before/after recurrence with sample sizes. If adoption timing is unknown, say so. Less recurrence is evidence of improvement, not proof that a rule caused it; no recent observations means 'not recently observed', not automatically 'resolved'.

Use existing Settings conventions for the toggle and collection state, and existing in-app dashboard/navigation conventions for paginated trend and issue drill-down views. Do not create extra modal management flows or an infinitely scrolling issue list. The user can filter by time, project and source model/harness. Exact visual layout is left to implementation; no mockup is approved by this document.

Enable/disable is restricted to the node's authorized administrator. Reads enforce existing account/project access for both individual lessons and aggregate queries: derived text and totals can disclose information too. Local availability is not permission to share metrics with another user. No public endpoint, relay feed, automatic upload or cross-machine export is added. Loss of source access must not leave its derived records visible to unauthorized viewers; normal transcript expiry alone is not an access revocation.

## Verification and delivery

Tests must demonstrate default-off and disabled behavior, no replication or remote transcript fetching, synced/non-owned conversation inclusion, more than 50 records, multi-segment deduplication, append/feedback updates, startup resume, disable-during-inference, missing evidence, unavailable models, and source-retention independence. Verify every aggregation respects access boundaries and that analysis leaves no raw source-bearing artifacts. Use deterministic fake models for automated tests.

Metric fixtures must prove that backfill dates do not distort trends, unknown outcomes do not become success, multiple issues do not multiply reply counts, new issue types remain visible, and accepted-rule correlations are not presented as proven resolution. UI tests cover filtering, pagination, coverage and visible failures.

After approval: plan and implement in the current shared checkout using targeted edits; preserve active work and do not pull/stash/reset or create a branch/worktree. Validate the model integration on a small authorized sample before any full backfill, report cost/coverage where available, and leave the production toggle off. The full historical run starts only when the user enables it.

## Not included

Relay aggregation, new syncing/sharing grants, central transcript archives, changing source retention, automatic installation of shared knowledge, cross-machine lesson distribution, reconstructed missing transcripts, a separate analytics database server, and host/CPU/network monitoring.
