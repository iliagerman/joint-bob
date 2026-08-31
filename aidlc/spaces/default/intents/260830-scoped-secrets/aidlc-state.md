# AI-DLC State Tracking

## Project Information
- **Project**: Replace GitHub credential groups with a single generic secrets model scoped by workspace, project, and conversation.

Scope:
1. Rename "project types" to "workspaces" throughout storage, API, and UI (Settings -> Projects currently lists project types via renderProjectTypes in public/app.js:1404; projects link to them via projects.project_type in src/store.ts). Projects live under a workspace.
2. Remove the GitHub credential group concept entirely (src/github-auth.ts, the githubGroupDialog and githubSyncDialog in public/index.html, the group picker on project type rows, and the per-project "GitHub access" override). Nothing is special-cased about GitHub anymore: the push token becomes an ordinary secret variable (GH_TOKEN) inside a normal secret account, and git push resolves it from the same secret environment as everything else. Existing group tokens must migrate into secret accounts so pushes keep working, including tokens already replicated to other cluster nodes.
3. Secret accounts (src/secrets.ts) attach to three scopes instead of two: workspace, project, and conversation. Conversations are identified per engine by session id (see src/conversation-ownership.ts). Resolution is most-specific-wins: conversation overrides project, project overrides workspace, on a per-variable-name basis.
4. A secret account stays inert until attached to at least one workspace, project, or conversation.
5. The UI must let the user attach existing secret accounts at all three levels by selecting from the available accounts.
- **Project Type**: Brownfield
- **Scope**: express
- **Start Date**: 2026-08-30T20:22:57Z
- **State Version**: 8
- **Active Agent**: aidlc-operations-agent
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
- **Project Root**: /Users/iliagerman/Work/personal_projects/joint-bob
- **Languages**: TypeScript
- **Frameworks**: Unknown
- **Build System**: npm (package.json)

## Execution Plan Summary
- **Total Stages**: 10
- **Completed**: 9
- **In Progress**: observability-setup

## Runtime State
- **Revision Count**: 0

- **Parked**: 2026-08-31T19:33:56Z
- **Parked At Stage**: observability-setup
## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

- **Initialization**: Verified
- **Ideation**: Skipped
- **Inception**: Verified
- **Construction**: Verified
- **Operation**: Active

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
- [x] reverse-engineering — EXECUTE
- [ ] practices-discovery — SKIP
- [x] requirements-analysis — EXECUTE
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
- [x] code-generation — EXECUTE
- [x] build-and-test — EXECUTE
- [ ] ci-pipeline — SKIP

### OPERATION PHASE
- [x] deployment-pipeline — EXECUTE
- [ ] environment-provisioning — SKIP
- [x] deployment-execution — EXECUTE
- [-] observability-setup — EXECUTE
- [ ] incident-response — SKIP
- [ ] performance-validation — SKIP
- [ ] feedback-optimization — SKIP

## Current Status
- **Lifecycle Phase**: OPERATION
- **Current Stage**: observability-setup
- **Next Stage**: none
- **Status**: Running
- **Last Updated**: 2026-08-31T19:33:56Z

## Session Resume Point
- **Last Completed Stage**: deployment-execution
- **Next Action**: Execute Observability Setup
- **Pending Artifacts**: none
