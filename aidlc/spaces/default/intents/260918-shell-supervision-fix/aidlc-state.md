# AI-DLC State Tracking

## Project Information
- **Project**: Harness-wide fix for shell command supervision and background tasks in Joint Bob. Problem (verified in transcripts and code): every shell command run by Claude, Pi, and Kiro goes through bin/joint-bob-bash.mjs -> scripts/supervised-shell.mjs runSupervisedShell, which waits at most 5 seconds (waitMs capped at 5000) and then returns "still running, tracked in Tasks" exit 0, turning the command into a background task. Each finished task then enqueues a completion wake-up prompt (src/server/background-completions.ts acceptCompletion) that starts a new model turn. Agents cannot await tests/builds, they poll, poll loops become more tasks, context fills, compaction loops. Required change: (1) supervised shell must run commands to completion with no time limit by default; a node-level setting (Settings UI + src/settings.ts) may set a maximum execution time, unlimited when unset; the same behavior must apply to every existing harness (Claude via CLAUDE_CODE_SHELL, Pi via createBashTool shellPath, Kiro via KIRO_CHAT_SHELL) and any future harness that receives JOINT_BOB_TASK_SHELL from src/agent-capabilities.ts, so the fix belongs in the shared shim/supervisor path, not per harness. (2) Keep the background task mechanism strictly as a view-only tracker: commands still register with the supervisor so the Tasks panel can list them, show live output, and stop them; but completions must no longer enqueue wake-up prompts, no internal completion turns, no BACKGROUND_COMPLETION delivery. The explicit `node $JOINT_BOB_TASK_CLI start` remains available for detached jobs but must also not wake the conversation. (3) Update the model-facing task instructions in src/agent-capabilities.ts (remove the five-second rule and the "completions enqueue an automatic follow-up" text). (4) Remove or neutralize now-dead code paths and stale regexes (src/conversation-segments.ts BACKGROUND_COMPLETION_NOTICE, background completion outbox polling) as appropriate, keeping tests green and adding tests per TESTING.md. Out of scope for this intent: the Claude context-window gauge (200k vs 1M) and post-compaction resume; those are separate follow-ups.
- **Project Type**: Brownfield
- **Scope**: express
- **Start Date**: 2026-09-18T20:35:10Z
- **State Version**: 8
- **Active Agent**: aidlc-developer-agent
- **Worktree Path**:
- **Bolt Refs**:
- **Practices Affirmed Timestamp**:

## Scope Configuration
- **Stages to Execute**: 0.1, 0.2, 0.3, 2.1, 2.3, 3.5, 3.6, 4.1, 4.3, 4.4
- **Stages to Skip**: 1.1 (intent-capture), 1.2 (market-research), 1.3 (feasibility), 1.4 (scope-definition), 1.5 (team-formation), 1.6 (rough-mockups), 1.7 (approval-handoff), 2.2 (practices-discovery), 2.4 (user-stories), 2.5 (refined-mockups), 2.6 (domain-design), 2.7 (units-generation), 2.8 (contract-design), 2.9 (delivery-planning), 3.1 (functional-design), 3.2 (nfr-requirements), 3.3 (nfr-design), 3.4 (infrastructure-design), 3.7 (ci-pipeline), 4.2 (environment-provisioning), 4.5 (incident-response), 4.6 (performance-validation), 4.7 (feedback-optimization)
- **Depth**: Minimal
- **Test Strategy**: Minimal
- **Review Override**: 

## Workspace State
- **Project Root**: /Users/iliagerman/JointBob/personal/joint_bob
- **Languages**: TypeScript
- **Frameworks**: Unknown
- **Build System**: npm (package.json)

## Execution Plan Summary
- **Total Stages**: 10
- **Completed**: 3
- **In Progress**: reverse-engineering

## Runtime State
- **Revision Count**: 0

- **Parked**: 2026-09-18T20:37:34Z
- **Parked At Stage**: reverse-engineering
## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

- **Initialization**: Verified
- **Ideation**: Skipped
- **Inception**: Active
- **Construction**: Pending
- **Operation**: Pending

## Stage Progress
<!-- Checkbox states: [ ] not started, [-] in progress, [?] awaiting approval (gate open), [R] revising (user rejected gate), [x] completed, [S] skipped via --stage/--phase jump -->

### INITIALIZATION PHASE
- [x] workspace-scaffold — EXECUTE
- [x] workspace-detection — EXECUTE
- [x] state-init — EXECUTE

### IDEATION PHASE
- [ ] intent-capture — SKIP
- [ ] market-research — SKIP
- [ ] feasibility — SKIP
- [ ] scope-definition — SKIP
- [ ] team-formation — SKIP
- [ ] rough-mockups — SKIP
- [ ] approval-handoff — SKIP

### INCEPTION PHASE
- [-] reverse-engineering — EXECUTE
- [ ] practices-discovery — SKIP
- [ ] requirements-analysis — EXECUTE
- [ ] user-stories — SKIP
- [ ] refined-mockups — SKIP
- [ ] domain-design — SKIP
- [ ] units-generation — SKIP
- [ ] contract-design — SKIP
- [ ] delivery-planning — SKIP

### CONSTRUCTION PHASE
Per unit: [TBD]
- [ ] functional-design — SKIP
- [ ] nfr-requirements — SKIP
- [ ] nfr-design — SKIP
- [ ] infrastructure-design — SKIP
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
- [ ] ci-pipeline — SKIP

### OPERATION PHASE
- [ ] deployment-pipeline — EXECUTE
- [ ] environment-provisioning — SKIP
- [ ] deployment-execution — EXECUTE
- [ ] observability-setup — EXECUTE
- [ ] incident-response — SKIP
- [ ] performance-validation — SKIP
- [ ] feedback-optimization — SKIP

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: reverse-engineering
- **Next Stage**: requirements-analysis
- **Status**: Running
- **Last Updated**: 2026-09-18T20:37:34Z

## Session Resume Point
- **Last Completed Stage**: state-init
- **Next Action**: Execute reverse-engineering
- **Pending Artifacts**: none
