# Node-local provider profiles implementation plan

**Goal:** Multiple user-owned Claude and ChatGPT subscription logins on each execution node, selected by conversation, project, workspace or personal default, with automatic token renewal.

**Architecture:** Profile definitions, selections and credentials are node-local in this first version. Nothing replicates or goes to the relay. Claude runs with an isolated native config directory and owns credential renewal, while its transcript directory remains the existing synchronized directory. OpenAI uses a separate SDK auth store per profile; node-side locked refresh supplies session-scoped credentials to Pi, including isolated workers. Existing unconfigured sessions keep their existing authentication.

**Constraints:** No machine-wide login swapping. Never fall back from an explicitly selected missing/expired profile. Ownership follows the project owner, not whoever views its conversation. Never send tokens to list/status endpoints or logs. Scope changes take effect between turns. No new dependencies. Preserve strict resource isolation. Native local OAuth completion and pasted redirects support headless nodes. Authentication errors must not expose provider response bodies.

## Tasks
- [x] Profile store and scoped resolution. Behavioral tests cover precedence, isolation, deletion, and provider mismatch; missing selected credentials fail closed.
- [x] Local login service. OAuth is persisted only after the flow completes; Claude uses its native private store and OpenAI uses the SDK's locked auth store. Tests cover sanitized status, cancellation, and refresh.
- [x] Harness integration. Claude profile context wraps preflight/turns without changing transcripts. Pi uses per-session credential callbacks and worker hooks; concurrent-profile, environment, and refresh tests pass.
- [x] Authenticated API and Settings > Harnesses management. Profiles, login, logout, pagination, and scoped inherited selections have API and isolated-browser tests.
- [x] Typecheck, focused suites, and UI journey passed. Full test suite was interrupted before totals; see progress note below. Real subscription login still requires human completion.

## Review focus
- Another user's session must not select or read a profile owned by someone else.
- A selected logged-out profile must block rather than use ambient API keys.
- Two concurrent sessions must retain their own selected profile through automatic refresh.
- Native Claude config isolation must not fork synchronized transcripts or load machine resources.
- Cancelled/restarted login must not leak callback listeners or persist a stale login result.

## Progress
User explicitly requested implementation in this checkout. No worktree or new branch. Existing unrelated working-tree edits remain untouched. Profile metadata/selections are node-local for the initial rollout, consistent with independently configured logins; cross-node metadata synchronization is deferred and must be disclosed.

Feature verification: `npm run typecheck`, the provider-profile/API/execution/login/Pi-idle/PWA/source-invariant focused tests, and `test/ui/ui-provider-profiles.test.ts` passed. A previous `npm test` run was interrupted around test 2,430 without totals; its Pi busy-session and offline/PWA asset failures now pass in focused reruns. The workspace/conversation skill-grant failure and full-suite totals remain unverified. No live OAuth credentials were used.
