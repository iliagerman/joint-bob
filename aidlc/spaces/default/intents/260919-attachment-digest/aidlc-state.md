# AI-DLC State Tracking

## Project Information
- **Project**: Attachment and screenshot digest for the model, behind a settings toggle, plus proper harness error surfacing. Context: on 2026-09-19 the Kiro conversation "Dev ui tweaks" (Contigos project, session c83e0715-cb6e-4896-aa83-b63fa35985d4) ended silently because Bedrock rejected Kiro's request with a ValidationException ("messages.46.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels") after 23 screenshots (all 1512x945 or smaller) had accumulated in Kiro's history via its native `read` tool on PNGs produced by Joint Bob's browser CLI `screenshot PATH` command. Joint Bob received an end of turn with no assistant text and showed no error. Requirements: (1) A new user setting (default off) that turns on "digest attachments": when on, Joint Bob describes images (vision model call) and extracts text from file attachments the user uploads in chat, sends the digest plus the saved file path to the harness instead of the raw bytes, so raw images are not re-sent on every message; when off, behaviour is exactly today's. (2) Under the same setting, the browser CLI `screenshot PATH` command returns a text description of the captured page plus the saved path, and the browser agent instructions in src/browser-agent.ts tell agents to prefer the description and existing text-extraction commands and read the PNG only when needed. (3) Regardless of the setting, when a harness turn fails or ends because of a provider/model error (e.g. Kiro ACP stream errors, Bedrock validation errors), Joint Bob must surface the error text to the user in the chat UI instead of ending the turn silently; applies to Kiro, Claude, and Pi harnesses. Constraints: Joint Bob cannot remove images from a harness's own history; never strip or rewrite images silently when the setting is off. Keep implementation simple, no defensive programming, tests first per repo rules.
- **Project Type**: Brownfield
- **Scope**: feature
- **Start Date**: 2026-09-19T16:30:23Z
- **State Version**: 8
- **Active Agent**: aidlc-product-agent
- **Worktree Path**:
- **Bolt Refs**:
- **Practices Affirmed Timestamp**:

## Scope Configuration
- **Stages to Execute**: 0.1, 0.2, 0.3, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
- **Review Override**: 

## Workspace State
- **Project Root**: /Users/iliagerman/JointBob/personal/joint_bob
- **Languages**: TypeScript
- **Frameworks**: Unknown
- **Build System**: npm (package.json)

## Execution Plan Summary
- **Total Stages**: 33
- **Completed**: 3
- **In Progress**: intent-capture

## Runtime State
- **Revision Count**: 0

## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

- **Initialization**: Verified
- **Ideation**: Active
- **Inception**: Pending
- **Construction**: Pending
- **Operation**: Pending

## Stage Progress
<!-- Checkbox states: [ ] not started, [-] in progress, [?] awaiting approval (gate open), [R] revising (user rejected gate), [x] completed, [S] skipped via --stage/--phase jump -->

### INITIALIZATION PHASE
- [x] workspace-scaffold — EXECUTE
- [x] workspace-detection — EXECUTE
- [x] state-init — EXECUTE

### IDEATION PHASE
- [-] intent-capture — EXECUTE
- [ ] market-research — EXECUTE
- [ ] feasibility — EXECUTE
- [ ] scope-definition — EXECUTE
- [ ] team-formation — EXECUTE
- [ ] rough-mockups — EXECUTE
- [ ] approval-handoff — EXECUTE

### INCEPTION PHASE
- [ ] reverse-engineering — EXECUTE
- [ ] practices-discovery — EXECUTE
- [ ] requirements-analysis — EXECUTE
- [ ] user-stories — EXECUTE
- [ ] refined-mockups — EXECUTE
- [ ] domain-design — EXECUTE
- [ ] units-generation — EXECUTE
- [ ] contract-design — EXECUTE
- [ ] delivery-planning — EXECUTE

### CONSTRUCTION PHASE
Per unit: [TBD]
- [ ] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
- [ ] ci-pipeline — EXECUTE

### OPERATION PHASE
- [ ] deployment-pipeline — EXECUTE
- [ ] environment-provisioning — EXECUTE
- [ ] deployment-execution — EXECUTE
- [ ] observability-setup — EXECUTE
- [ ] incident-response — EXECUTE
- [ ] performance-validation — EXECUTE
- [ ] feedback-optimization — EXECUTE

## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: intent-capture
- **Next Stage**: market-research
- **Status**: Running
- **Last Updated**: 2026-09-19T16:30:23Z

## Session Resume Point
- **Last Completed Stage**: state-init
- **Next Action**: Execute intent-capture
- **Pending Artifacts**: none
