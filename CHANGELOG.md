# Changelog

Every deployment is a version. The newest section must always match the
`version` field in `package.json`; the pre-push hook writes it for you.

## 0.3.3 — 2026-08-31

- Fixed startup remaining on the splash screen after the workspace migration left UI controls unbound
- Added a post-deployment smoke check for the release, application shell, JavaScript syntax, and UI element bindings

## 0.3.2 — 2026-08-31

- Fixed the terminal dialog failing to open because the fit addon constructor lives under the addon's namespace
- Fixed viewing or editing a file on a paired node returning Unauthorized after that node rotated its cluster credential
- Fixed choppy chat scrolling while assistant replies stream in

## 0.3.1 — 2026-08-31

- Fixed node installation failing due to attempt to load a removed internal module.

## 0.3.0 — 2026-08-31

- Replaced GitHub credential groups with ordinary secret accounts; the push token is now a normal GH_TOKEN variable
- Scoped secret accounts to workspace, project, and conversation, resolving most-specific-first per variable name
- Renamed project types to workspaces across the UI, the API, and the database
- Migrated existing GitHub credential groups and per-project overrides into secret accounts on first start, one way and once per node
- Made gh and git push always authenticate as the same identity
- Added a per-account switch for replicating a secret account to paired nodes
- Chose a conversation's secret accounts in the new-conversation dialog
- Fixed secret assignments surviving a project merge, a project delete, and a workspace delete

## 0.2.0 — 2026-08-30

- Added a Changelog tab in Settings listing the last ten released versions
- Showed the semantic version in the app menu instead of a Git commit hash
- Opened a "What's new" dialog once after an update, listing that release's changes
- Added an embedded terminal, a file editor, and composer commands to the chat surface
- Nested child conversations under the conversation that started them
- Added a cross-project review inbox with a live badge and notifications
- Added scoped runtime secret accounts with brand icons and a provider picker
- Allowed taking ownership of a Claude conversation from another node
- Resumed active sessions automatically after a service update
- Read conversation recency from transcript events instead of file timestamps
- Synced project colours across nodes

## 0.1.1 — 2026-08-23

- Embedded the commit identity in release archives

## 0.1.0 — 2026-08-23

- First public release
