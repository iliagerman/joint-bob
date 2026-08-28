# Requirements Analysis Questions

## Q1. Existing Syncthing conflict copies

How should Joint Bob handle existing transcript conflict copies while restoring the complete conversation?

A. Preserve every file, group copies by Pi session ID, and display the most complete coherent transcript (recommended)
B. Automatically merge events from every copy into one canonical transcript
C. Preserve every file but show each copy as a separate conversation
D. Move conflict copies to an archive after selecting the canonical transcript
X. Other (please specify)

[Answer]: X use the most recent one, move the others to temp so the system will clean them up

## Q2. Preventing future transcript conflicts

How should Joint Bob prevent two nodes from writing the same conversation concurrently?

A. Enforce one execution-node owner per conversation; changing nodes requires the existing transfer action (recommended)
B. Allow either node to continue and attempt automatic transcript merging
C. Make the node that created the conversation its permanent writer
D. Stop synchronizing Pi transcripts between nodes
X. Other (please specify)

[Answer]:A

## Q3. Required regression coverage

Which verification is required for this fix? (select all that apply)

A. A synchronized conflict copy never appears as a duplicate conversation
B. The complete canonical transcript displays the Wolt analysis and later test/deployment messages
C. Concurrent prompts from different nodes cannot create divergent transcript writers
D. Existing Pi/Claude discovery, transfer, streaming, review-state, and Syncthing tests remain green
E. A two-node integration test reproduces conflict creation and proves prevention
X. Other (please specify)

[Answer]:E

## Consolidated Summary Confirmation

- Existing transcript conflicts: use the most recent transcript and move the other copies to temporary storage for system cleanup.
- Future prevention: enforce one execution-node owner per conversation; changing nodes requires the existing transfer action.
- Regression coverage: require a two-node integration test that reproduces conflict creation and proves prevention.

Does this all look correct before I generate the requirements artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
