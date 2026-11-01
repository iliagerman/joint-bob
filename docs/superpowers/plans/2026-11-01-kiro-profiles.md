# Standalone Kiro profiles implementation plan

**Approved requirement:** Standalone Kiro IAM Identity Center profiles. Each has a label, start URL, AWS region and independent native Kiro login. No Pi providers, shared Claude/Pi credentials or mixed pools. Support existing default/workspace/project/conversation and automation profile assignments without changing existing unassigned Kiro behavior.

**Architecture:** Reuse owned profile metadata and scope persistence only, adding a Kiro-specific configuration field. Native Kiro authentication lives in private per-profile HOME/KIRO_HOME/XDG directories, never Pi auth.json. The CLI's `login --license pro --identity-provider URL --region REGION --use-device-flow` owns token persistence and renewal. Show only safe device-flow metadata and status. Alias transcripts remain where they are; changing accounts creates a fresh native Kiro session with explicit conversation-history handoff.

**Evidence:** `kiro-cli login --help` confirms Identity Center/device-flow flags. `whoami` under an empty disposable HOME and KIRO_HOME returned Not logged in and created its own home/Library/Application Support/kiro-cli/data.sqlite3, without reading the current account. KIRO_HOME alone is insufficient to isolate the native data store. Named OS runtimes override HOME, so the Kiro command must receive per-process HOME through an explicit env invocation inside the existing runtime boundary and existing folder ACL helper.

## Tasks

1. Add validated Kiro metadata and standalone native login/status/logout. Reject Kiro membership and selections in subscription pools, forbid OAuth token borrowing. Test validation, ownership, isolation, login lifecycle, cancellation and safe output with synthetic CLI.
2. Resolve/pin Kiro profiles for preflight, prompts and compaction. Keep transcript aliases stable; persist native-session profile association and handoff state for account changes. Test actual Kiro fixture execution with separate accounts and legacy behavior.
3. Add a separate Kiro profiles section in Settings > Harnesses, with creation, native device sign-in, status/logout/delete and scoped selection. Keep Kiro out of Claude/Pi connection and pool UI; automation pickers can show Kiro profiles. Add isolated API/browser journeys.
4. Run related profile/Kiro/harness tests, typecheck/build and UI tests. Attempt a fresh read-only review; fix verified important findings. Commit from a private index, no push/deploy.

## Constraints

- No real login or credentials in tests, no MFA automation.
- Native refresh credentials never leave their profile or node.
- Existing Kiro sign-in and conversations remain available when unassigned.
- Explicit unavailable profile fails closed, never selects another account.
- Use existing account-runtime/ACL boundaries; no execution as another OS user.
- Preserve unrelated shared-checkout edits.
- Kiro profiles are private. A named OS runtime must belong to the profile owner; cross-account/cluster-runtime credential sharing is not supported.

## Implementation and verification

Implemented all three feature tasks. Native authentication remains separate from Pi/Claude; only owned metadata and scope persistence are reused. Added regression coverage for concurrent profile pinning, active-turn authentication mutation, account changes/history handoff, safe device metadata, invalid pool use, API ownership and the standalone UI.

273 related tests pass, including three browser journeys. Typecheck/build pass. These checks ran in a disposable snapshot of `3d2be46f6b` plus this feature, because unrelated in-progress checkout edits break browser startup and a server import. No unrelated edits were changed for testing. No full-suite or live SSO/MFA claim is made.

The independent reviewer failed before inference because its configured child model was unsupported. An alternate temporary agent configuration was blocked as a protected path; no workaround was used. An author self-review was completed instead, with security regressions verified RED→GREEN. Native IAM Identity Center sign-in on a real account remains a human acceptance check after deployment.
