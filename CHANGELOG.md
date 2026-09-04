# Changelog

Every deployment is a version. The newest section must always match the
`version` field in `package.json`; the pre-push hook writes it for you.

## Unreleased

- Conversation ownership takeovers now reliably verify that transcripts have synchronized to the destination node before proceeding
- Claude harness now provides a /goal command to set completion conditions
- Canvas keyboard shortcuts are now customizable with a modifier chord selector and per-command key bindings, and a finder lets you search conversations by title to jump directly to them
- Pinned conversations now synchronize across cluster nodes instead of being local to each machine
- The app now automatically refreshes to the latest version when deployed while the browser window is open
- Conversation engines are now extensible, enabling support for future custom harnesses alongside Pi and Claude

## 1.2.1 — 2026-09-03

- Remote conversations can now be switched to a local node and taken over reliably with proper ownership settlement across the cluster
- Selected projects and conversations are now more visually prominent with borders and updated highlighting in their sidebars

## 1.2.0 — 2026-09-03

- Canvas panes can now be resized horizontally and rows vertically to customize the layout
- Completed tickets can now merge their workspace changes back into the project with conflict resolution
- Conversations now continue on another node through ownership transfer via the lock banner, replacing the removed 'Continue on' button; takeover now fails safely if the transcript hasn't synchronized
- Conversations linked to board tickets now appear marked in the conversations list with a button to jump into the ticket
- Chat now follows newest messages while reading at the bottom and keeps scroll position when scrolling up
- Pinning is now a quick action on conversations and projects instead of only in the overflow menu
- Task descriptions can now be up to 20,000 characters
- Tool selection and transcript compaction are now available for Claude conversations
- Secret accounts marked for replication now sync immediately when saved
- Chat header keeps conversation names renamed in Joint Bob instead of reverting to auto-generated names, panel headers are consistently sized, and skill descriptions display correctly
- Recent conversations now appear once in the recents dialog even when resumed on different nodes
- Database locks no longer crash the node, node startup no longer gets stuck when Syncthing's API port binding is delayed, and deleted conversations no longer cause crashes when reconnected

## 1.1.1 — 2026-09-02

- Chat toolbar actions now display correctly on desktop instead of being clipped from the panel edge

## 1.1.0 — 2026-09-02

- Terminal now opens in a ticket's working folder when a ticket is active
- Terminal maintains its mode during socket routing to remote nodes

## 1.0.0 — 2026-09-02

- Canvas panes now fill their row width equally and rows fill the canvas height equally, eliminating empty space
- Text files and source code now display with syntax highlighting when viewed, not just markdown
- Fixed text selection colors in the editor to be readable
- Fixed vim mode indicator in the toolbar
- Older canvas layouts are automatically normalized to the new grid format

## 0.8.0 — 2026-09-01

- Prompts typed while Claude is running now persist across reloads and reconnects
- Markdown files now preview in a sidebar instead of rendering in-place
- The View page is now centered with improved readability
- Pinned conversations now display their own unpin button
- Canvas rows are now resizable with draggable height separators
- Canvas panes are individually resizable by width within their row
- Failed multi-agent task runs now display why the worker failed
- Canvas keyboard shortcuts now work correctly across concurrent nodes and focus mode changes

## 0.7.0 — 2026-09-01

- Restructured README with setup options table and added automated agent installation guide to npm package
- Positioned Canvas button on project search bar for more compact layout
- Recents dialog now refreshes activity times across all projects when opened

## 0.6.0 — 2026-09-01

- Added a context usage gauge in the chat header showing how full the model's context window is for both harnesses

## 0.5.0 — 2026-09-01

- Arranged conversations in persistent rows on the canvas instead of hierarchical splits
- Styled assistant responses as cards matching user message bubbles
- Markdown files now show rendered text with a toggle to view raw source
- Enabled starting new conversations from canvas panes
- Fixed project files displaying in the viewer by serving the correct content type

## 0.4.2 — 2026-09-01

- Moved the Canvas launcher below the project search with an accent colour and a grid icon
- Fixed a lone canvas pane filling only half the canvas area

## 0.4.1 — 2026-09-01

- Added a desktop Canvas view showing up to eight existing conversations side by side in resizable, swappable panes
- Reused each conversation's exact session in every pane and persisted the layout per node through preferences

## 0.4.0 — 2026-09-01

- Added one-time cluster join links that any existing member can generate
- Replaced manual node URLs and permanent pairing tokens in Settings with a paste-and-join flow

## 0.3.8 — 2026-09-01

- Fixed conversation scrolling resisting upward movement when off-screen messages changed from estimated to real heights

## 0.3.7 — 2026-09-01

- Added a shared indexed conversation catalog with targeted Pi and Claude transcript refreshes
- Made conversation connection reuse catalog lookups and defer model loading until the socket is ready
- Showed newly created conversations immediately while their transcript is being created

## 0.3.6 — 2026-08-31

- Kept new Pi and Claude conversations attached to their original session across reconnects before the first transcript is written
- Listed transcript-free conversations immediately and replaced them with the real transcript without duplication
- Added live worker, reviewer, and watcher status beneath conversations that launch child agents

## 0.3.5 — 2026-08-31

- Fixed the collapsed projects and conversations panels staying full width instead of shrinking to their rail
- Made the panel collapse buttons visible with an outlined, centred chevron icon

## 0.3.4 — 2026-08-31

- Fixed upward scrolling during a streamed response being pulled back toward the newest message

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
