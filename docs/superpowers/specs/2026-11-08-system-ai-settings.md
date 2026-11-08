# System AI settings

## Agreed behavior

One admin-only Settings → System AI screen configures Joint Bob's internal work. It selects the system decision model and saved secret accounts, the default background agent, and operation-specific agent choices. Saved settings replicate to trusted twins. Ordinary cluster peers do not receive them. The setting to collect quality metrics/insights, and the collected records, remain machine-local.

System decision requests must not require a secret attachment to the analyzed project. Selecting a saved account for system work does not attach it to projects or export it to their agents. Account selection is explicit when several keys exist. The screen names the execution machine and reports unavailable credentials or models rather than silently substituting them.

## Implementation decisions

Reuse existing background-agent, sync-check, dashboard and summary configuration and model pickers. Move their controls into System AI without resetting stored choices. Keep summaries' cadence and instructions with their writer. Provide dedicated learning, knowledge-cleanup and quality evaluator choices, plus system login-profile selections. Quality retains its restricted, tool-free Claude evaluator; its model and login are configurable here. Preserve existing defaults until the user changes them.

Use the existing signed replication outbox with a strictly validated, twins-only settings event. Replicate only an allowlist of internal-AI settings, never arbitrary node settings, paths, sign-in contents or the Quality enabled flag. Resolve selected secrets on the execution node; a missing twin copy is an explicit unavailable state. Secrets received solely from unrelated cluster members are not candidates for a twin-wide system default.

Keep the already verified Quality phone-layout and settings-save fixes. Release all changes from this conversation together after focused browser, secret-boundary and two-node tests, exact-tree typecheck/build, and green Release CI. Leave unrelated working-tree changes untouched.
