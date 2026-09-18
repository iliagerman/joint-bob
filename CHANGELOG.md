# Changelog

Every deployment is a version. The newest section must always match the
`version` field in `package.json`; the pre-push hook writes it for you.

## 1.57.3 — 2026-09-18

- Claude now automatically trusts workspace directories when spawned, so project-level settings are honored without manual trust dialogs.
- Fixed composer shortcut badge to appear in the correct position.
- Fixed repository state that could cause broken dependencies on fresh clones.

## 1.57.2 — 2026-09-18

- Kiro conversations no longer stop mid-turn when the agent delegates work to a sub-agent.
- A failed automatic compaction is tried once per turn instead of every few seconds, so it no longer holds up the conversation or floods the log.
- A background-task wake-up that fails or is interrupted by a restart no longer stalls the conversation for good: it is never replayed, later wake-ups still arrive, and the failure now shows in the conversation.

## 1.57.1 — 2026-09-18

- Updates that change the supervisor itself no longer fail with `Installation failed with status 1`; the node installs them as a maintenance activation and restarts the supervisor onto its new components.
- Mobile agent picker now displays each agent as a logo with its name on one line, making the list more compact.
- Conversation name now shows in the chat header instead of a generic fallback label.
- Mobile chat toolbar now keeps model, reasoning, and tasks on one row with tasks shown as an icon.

## 1.57.0 — 2026-09-18

- Browser login forms now appear as a panel beside your chat instead of a popup, sharing the space with the manual browser viewer.
- Browser conversations now detect visible login forms and automatically open a persistent sign-in panel so you can authenticate while agent automation pauses.
- A pending sign-in request now survives a service restart, so you can finish authenticating after the browser reconnects.

## 1.56.1 — 2026-09-18

- Fixed spurious sign-in prompts when accessing git panels across clustered nodes with mismatched versions.

## 1.56.0 — 2026-09-18

- Added a project-level Git review panel to view repository status, diffs, and commit history within project workspaces.
- Ask AI to explain git changes; review discussions persist for 7 days.

## 1.55.0 — 2026-09-18

- Added a Git panel where you can browse the working tree, commit history, and ask AI to explain code changes—explanations are saved for 7 days and can be referenced in follow-ups.

## 1.54.0 — 2026-09-18

- Added website accounts to store structured login credentials that agents can fill automatically at bound origins.

## 1.53.6 — 2026-09-18

- Conversations kept visible by recent activity can now be marked as reviewed, even when they fall outside the listing cap.

## 1.53.5 — 2026-09-18

- Claude transcripts now preserve tool results as separate messages, keeping them in the order the agent spoke.

## 1.53.4 — 2026-09-17

- Terminal output from completed background tasks is now marked as acknowledged, preventing duplicate follow-up prompts.

## 1.53.3 — 2026-09-18

- Kiro transcripts now preserve tool results as separate messages, matching the live stream layout and correctly showing failed tools on reload.

## 1.53.2 — 2026-09-17

- Conversations now recover reliably across machines by matching session identity, even when direct paths become stale.

## 1.53.1 — 2026-09-17

- Sessions now recover by ID even when their saved path becomes unavailable, enabling portable workspaces across multiple machines.

## 1.53.0 — 2026-09-17

- Agents can now automatically fill website login forms using credentials attached to your conversation.
- Holding the shortcut modifiers now shows the message box its own key, so you can jump straight to typing without the mouse.

## 1.52.3 — 2026-09-17

- Pressing Escape now closes the by-the-way side panel.
- By-the-way chat now stays within its dialog boundaries.

## 1.52.2 — 2026-09-17

- Fixed profile leases not being released when idle sessions expire.

## 1.52.1 — 2026-09-17

- Browser sessions now safely close after two hours of inactivity, releasing Chrome resources while keeping their saved login profiles available for explicit reopen.

## 1.52.0 — 2026-09-17

- Website login credentials can now be bound to authorized origins for improved security.
- Updated the cached app shell so existing installations load the new website credential settings.

## 1.51.0 — 2026-09-17

- Long-running agent shell commands continue in Tasks without restarting; short commands finish inline and stay out of task history.
- Tasks stay scoped to their originating conversation, with output and stop controls preserved across ordinary app upgrades.
- Internal completion prompts and routine follow-ups stay out of chat, including after reloads.
- Fixed stale task views when switching conversations and database lock errors when updating conversation review state.

## 1.50.1 — 2026-09-17

- Widened the driven browser viewport to standard laptop dimensions, preventing websites from collapsing into narrow columns.

## 1.50.0 — 2026-09-17

- Added temporary by-the-way chats for exploring ideas in an isolated side panel without affecting your main conversation.
- Scheduled task failures now retry at the next run time by default; you can optionally pause the schedule to review failed runs instead.

## 1.49.0 — 2026-09-17

- Added `/bob-btw` command to open a temporary isolated conversation in a side panel for exploring ideas without affecting the main chat.
- Scheduled tasks now retry after failure by default and can optionally be configured to pause for review instead.

## 1.48.1 — 2026-09-17

- Picked images now preview as thumbnails in the composer chip, and empty conversations show a helpful message instead of blank task panes.

## 1.48.0 — 2026-09-17

- Moved keyboard shortcut badges below controls so button labels stay readable, and added U and Z shortcuts for background tasks and files panel.
- Fixed goal completion markers appearing at the end of assistant responses.
- Secured remote file explorer API endpoints with authentication.

## 1.47.0 — 2026-09-17

- Redesigned project files as a familiar file explorer with breadcrumbs, file-type icons, aligned columns, compact rows, and icon actions.

## 1.46.0 — 2026-09-17

- Added a project file explorer for navigating, opening, and managing files in your workspace, plus optimized background task display and improved supervisor resource efficiency.
- Scheduled task transcripts now collapse to show only final reports, while your own messages stay fully visible so you can see the complete conversation thread.

## 1.45.0 — 2026-09-17

- Added a project file explorer for opening, copying, and deleting files from the active conversation.
- Reworked background tasks with a compact live-output panel, hidden internal completion prompts, and stricter guidance so ordinary shell commands stay foregrounded.
- Lowered supervised background-job priority, reduced duplicate transcript watchers, and reset context usage after Claude compaction.

## 1.44.0 — 2026-09-17

- Added Kiro as a new agent option for starting conversations, with icon buttons on desktop and a choice dialog on mobile.

## 1.43.1 — 2026-09-17

- Kiro sessions no longer rewrite their history when reconfigured with unchanged settings.

## 1.43.0 — 2026-09-17

- ntfy services can now be shared with paired nodes, and a default service can be selected when several are configured.

## 1.42.2 — 2026-09-17

- Scheduled tasks that share a conversation now queue their prompts with their model and reasoning instead of reconfiguring the live session, so coinciding schedules no longer fail with "session is busy".

## 1.42.1 — 2026-09-17

- Force-start button now shows a spinner while sending and prevents accidental repeated clicks.

## 1.42.0 — 2026-09-16

- Agents can now send notifications to ntfy servers you've configured.
- Force-starting a queued prompt after canceling a turn no longer shows the canceled turn's error in the chat.

## 1.41.0 — 2026-09-16

- Added a Tasks panel with live output, status, history, and stop controls across nodes. Finished tasks queue an automatic follow-up in their original conversation, even without an open browser.
- Preserved local conversation history paths when syncing the same agent session across nodes.
- Reopened stale agent sessions before dispatching queued messages and automatic follow-ups.
- Kept the classification filter compact on desktop and full-width on mobile.

## 1.40.1 — 2026-09-16

- Notification preferences for review alerts and ntfy publishing now follow conversations across cluster nodes when ownership transfers.

## 1.40.0 — 2026-09-16

- Keyboard shortcut badges now appear only when you hold the command modifiers, overlaying the buttons rather than taking up toolbar space.

## 1.39.0 — 2026-09-16

- The open conversation now offers a "Conversation actions" button in the toolbar with the same menu as its row, so you can mark it done, set up ntfy publishing, or fork it without leaving the chat.

## 1.38.0 — 2026-09-16

- Conversations can now be marked done to hide them from the active list; a "Show done" toggle reveals them when needed.

## 1.37.1 — 2026-09-16

- Keyboard shortcut labels now display consistently on all platforms.

## 1.37.0 — 2026-09-16

- Review notifications can now also publish to ntfy. Define ntfy servers (URL plus optional access token, encrypted at rest) once in Settings → Notifications, then pick "Publish reviews to ntfy" from any conversation's menu and name a topic. The push carries the conversation title, the reply preview, and a tap-through link, and it works from whichever cluster node runs the conversation.

## 1.36.1 — 2026-09-16

- API responses now prevent browser cache retention, ensuring stale conversation data doesn't persist across sessions.
- Syncthing no longer syncs per-clone metadata across cluster nodes, reducing churn on shared folders.

## 1.36.0 — 2026-09-16

- Conversations can now run toward specific objectives with `/bob-goal`, continuing autonomously until the work is complete, blocked, or cancelled; goal state syncs across cluster nodes.

## 1.35.0 — 2026-09-16

- Canvas shortcuts are now unified: every command uses Control+Option (Control+Alt on Windows/Linux) plus a unique key.
- Button badges now show only the key that distinguishes each shortcut, keeping the toolbar cleaner.
- Existing keymaps are automatically rebuilt to match the new unified shortcut scheme.
- Toolbar and panel controls now display with button styling for improved visual clarity.

## 1.34.3 — 2026-09-16

- Review push notifications now show a short preview of the agent's last reply, so the lock screen says what the conversation is about instead of a generic "tap to open" line.

## 1.34.2 — 2026-09-16

- Chat history now filters out internal Claude system messages that previously appeared in transcripts.

## 1.34.1 — 2026-09-16

- Scheduled conversations now display a streamlined transcript showing only the final report from each turn, hiding intermediate thinking and tool activity.

## 1.34.0 — 2026-09-16

- Message timestamps display in your local time zone on every chat bubble.
- Delivery receipts on your messages show when the agent has received them.
- Read status syncs across your devices through your account settings.

## 1.33.2 — 2026-09-16

- Push notifications now reach iPhones: Apple's push service rejected every send with 403 BadJwtToken because the VAPID contact was the fake address mailto:joint-bob@localhost. The contact is now the project's real URL.

## 1.33.1 — 2026-09-16

- Browser session list now updates automatically when new sessions are created, without requiring a page reload.

## 1.33.0 — 2026-09-16

- Background tasks now run independently across conversation turns on installed Linux and macOS with automatic app lifecycle management.

## 1.32.9 — 2026-09-15

- Unblocked the release pipeline: a stale UI test still asserted the pre-1.32.6 agent-switch behavior and failed every release build since 1.32.5.

## 1.32.8 — 2026-09-15

- The "Take Ownership" button now resets properly when switching nodes after completing a conversation takeover.

## 1.32.7 — 2026-09-15

- Phone push notifications now work across cluster nodes: the mesh route that replicates phone subscriptions between machines was rejecting peer credentials with 401, so subscriptions never left the node they were created on.

## 1.32.6 — 2026-09-15

- Conversations now reopen correctly from Recents after switching between agents.
- Conversations maintain their identity when switching agents mid-chat.
- Large browser transcripts are now bounded to prevent memory bloat.
- Settings now includes reload-safe client diagnostics for troubleshooting connection problems.

## 1.32.5 — 2026-09-15

- Empty conversations now switch nodes silently instead of showing an ownership prompt.

## 1.32.4 — 2026-09-15

- Scheduled task edits and pauses now apply on the next execution, keeping the current run uninterrupted.

## 1.32.3 — 2026-09-15

- Fixed conversations that kept refreshing forever after a restart because child agent runs whose dashboard had died were still counted as running. Such runs are now retired at startup, with the reason recorded on each task.

## 1.32.2 — 2026-09-15

- Fixed the conversation list failing to render when it contained a Kiro conversation; Kiro conversations now show their own mark and colour.
- Failed updates now record which file could not be downloaded and the underlying network error, instead of only "fetch failed".
- Release checks that cannot reach GitHub now say why.

## 1.32.1 — 2026-09-15

- Conversations now automatically transfer ownership to the local node when the owner goes offline.

## 1.32.0 — 2026-09-15

- Conversations now compact automatically between messages when context usage reaches a configured threshold on this node.

## 1.31.9 — 2026-09-15

- Scheduled tasks now run even when peer nodes are temporarily unavailable.

## 1.31.8 — 2026-09-15

- Review notifications that couldn't reach any device are now retried instead of silently failing.

## 1.31.7 — 2026-09-15

- Scheduled Pi tasks now apply model and reasoning together, fixing GLM-5.3-Flash runs with low reasoning.
- Push notification subscriptions now replicate across nodes, including expired endpoint cleanup.

## 1.31.6 — 2026-09-15

- Fixed lost Claude tasks that could accumulate in conversations and cause stale message references.

## 1.31.5 — 2026-09-14

- Mobile chat toolbar now includes a button to access running conversations.
- Fixed classification filter width to align with the search input above it.

## 1.31.4 — 2026-09-15

- Queued prompts now have a "Force start" button to stop the current turn and run the selected message immediately.
- Queued prompts now resume correctly after app recovery or disconnections.

## 1.31.3 — 2026-09-15

- Pi conversations now ignore saved tools that aren't available on the current node when reconnecting.

## 1.31.2 — 2026-09-15

- Fixed prompt recall dropping queued prompts when reconnecting to a conversation.

## 1.31.1 — 2026-09-14

- Prompt recall now works after reloading the page or switching conversations.

## 1.31.0 — 2026-09-14

- Interactive browser commands now run ahead of waiting monitor scans. Operations already running finish first.
- Browser monitors can retain separate scan progress for each conversation without advancing unfinished scans.
- Added backend storage and APIs for reply batches, draft editing, and approval decisions. Automated drafting, sending, live messaging connectors, and the approvals interface are not available yet; approving a stored draft does not send it.
- Rule activation excludes older messages, and rule or monitor changes invalidate pending draft authority. Previously enabled rules are paused during upgrade and require explicit reactivation.

## 1.30.6 — 2026-09-14

- Fixed app updates hanging indefinitely when sessions refuse to stop during shutdown.

## 1.30.5 — 2026-09-14

- Kiro model lists now refresh directly from the native CLI before the first message, without requiring a conversation or app restart.

## 1.30.4 — 2026-09-14

- Handoff notifications now indicate when transcripts are truncated and where to find the full conversation history.

## 1.30.3 — 2026-09-14

- Fixed Pi conversations from getting stuck in a reconnect loop.

## 1.30.2 — 2026-09-14

- Enabled opening conversations from other execution nodes by resolving stale home directory paths to the local node's filesystem.
- Fixed update recovery to run conversations in parallel, preventing one failing conversation from blocking queue resumption in others.

## 1.30.1 — 2026-09-14

- Fixed queued messages to properly resume after app recovery from updates.

## 1.30.0 — 2026-09-14

- Added Kiro CLI conversations alongside Pi and Claude, with streaming replies, tools, model controls, cancellation, compaction, and context-copy forks.
- Added harness-specific defaults and configuration controls across conversations, tickets, and scheduled tasks.
- Preserved queued messages and conversation context when switching harnesses or restarting the app.
- Added per-conversation review notification preferences and harness-aware labels throughout the workspace.
- Verified authenticated Kiro resume and streaming on macOS. Kiro must be installed and authenticated separately on each execution node; authenticated cross-node validation is still pending.

## 1.29.5 — 2026-09-14

- Scheduled tasks now wait safely in an active conversation, support custom hourly intervals, and allow thinking or effort selection with the harness-default model.

## 1.29.4 — 2026-09-14

- New conversations now appear in the session list promptly by reading only appended transcript data instead of re-parsing entire files.

## 1.29.3 — 2026-09-14

- Conversations no longer stay marked running when a restarted agent dashboard has lost old runs. Those runs show failed tracking with completion unknown, preserving recorded output and finished task results. Temporary dashboard outages still retain running status.

## 1.29.2 — 2026-09-14

- Queued messages now start running correctly after stopping a turn with active queues.

## 1.29.1 — 2026-09-13

- Improved performance when opening conversations by streamlining direct session lookups and filtering transcript watch notifications to relevant projects only.

## 1.29.0 — 2026-09-13

- Added an Automations dialog for read-only browser monitors, with previews, activity history, and check intervals starting at 10 seconds.
- Added account-checked browser reassignment and automatic pauses for human control. Checks cover the configured visible target; AI replies and mail/chat connectors are not included.

## 1.28.0 — 2026-09-13

- Scheduled tasks can now specify which model and reasoning level to use when running.

## 1.27.0 — 2026-09-13

- Conversation lists now skip old transcript summaries, reducing startup and refresh work on nodes with large histories.
- Settings now controls the history window in days; pinned, recent, and directly opened older conversations remain available.

## 1.26.0 — 2026-09-13

- Queued messages can now be reordered and merged before sending.

## 1.25.1 — 2026-09-13

- Restored pause, resume, and Run now controls for scheduled tasks.

## 1.25.0 — 2026-09-13

- Messages with image attachments now display as expandable thumbnails in the chat transcript.

## 1.24.5 — 2026-09-13

- Fixed the schedule dialog layout with improved visual hierarchy and mobile responsiveness.

## 1.24.4 — 2026-09-12

- Moved Stop browser into the viewer header, separate from Close viewer. Account and profile controls now align, machine settings collapse, and closed profiles have a Reopen browser button.

## 1.24.3 — 2026-09-12

- Added `/reload` command for Pi to refresh skill definitions and prompt templates without restarting the conversation.

## 1.24.2 — 2026-09-12

- Fixed classification filter width to stay within its panel and auto-focused message input when opening drafts.

## 1.24.1 — 2026-09-12

- Restored terminal functionality in Safari.

## 1.24.0 — 2026-09-12

- Added WhatsApp browser triage skill for managing groups.
- Fixed markdown rendering to support right-to-left languages like Hebrew and Arabic.

## 1.23.1 — 2026-09-12

- Terminal now recovers gracefully when opened after a service worker update, loading dependencies on demand.

## 1.23.0 — 2026-09-12

- Refreshed app cache to ensure latest assets load on next browser visit.
- Conversation list now provides direct access to running work without leaving the chats panel.
- Queued messages now stay visually below active replies until they're sent, maintaining proper message order in the transcript.
- Browser viewer now remains open when expanding side panels for projects or conversations.

## 1.22.2 — 2026-09-12

- Fixed new conversation wizard steps to display in a consistent horizontal layout.

## 1.22.1 — 2026-09-12

- Sub-agent run lines now start folded away by default when conversations fan out to multiple agents, keeping the conversation visible and uncovering them only when you click the toggle.

## 1.22.0 — 2026-09-12

- Added a default browser machine in Settings, with conversation and browser-session overrides independent of where the agent runs.
- Added persistent Chrome profiles on macOS and Ubuntu, multiple accounts per conversation, and preserved human control across service restarts. Sites can still expire logins.
- Moved browser login data into native profiles on their owner machine. Joint Bob does not encrypt these files; use disk encryption to protect them.
- Fixed forked conversations sometimes appearing as drafts when discovered during transcript refresh.

## 1.21.0 — 2026-09-12

- New conversation setup is now a step-by-step wizard: name first, then optionally classify, then choose the node. Keyboard navigation lets you use Enter to walk forward and Cmd/Ctrl+Enter to start immediately.
- Sub-agent task lines can now be collapsed behind a toggle button when conversations fan out to multiple agents, keeping action buttons visible and reducing visual clutter.

## 1.20.3 — 2026-09-12

- All five conversation filters now fit in a single row.

## 1.20.2 — 2026-09-12

- Keyboard shortcuts now control browser (Ctrl+Alt+B) and scheduled tasks (Ctrl+Alt+S) from the chat toolbar.
- Running conversations now have one entry point in the Projects pane instead of duplicate buttons in conversation views.
- Removed the Safeguards on/off indicator from the chat toolbar.

## 1.20.1 — 2026-09-12

- Automated test suites can now launch native Chrome and Playwright instances when using isolated test environments and synthetic test accounts.

## 1.20.0 — 2026-09-12

- Conversation classifications can now be changed from the conversation's row menu, syncing across paired nodes even after the conversation starts.
- Added per-harness conversation defaults in Settings to configure the model and thinking level for new Pi and Claude conversations.
- Forking a conversation now works while it is running, creating an independent copy from the completed history without stopping the source.

## 1.19.1 — 2026-09-11

- Fixed conversations staying marked as Running after work finished on another node, even when no agent dashboard was available.

## 1.19.0 — 2026-09-11

- Added hourly, daily, and weekly scheduled prompts with timezone and execution-node selection. Project schedules create fresh conversations; conversation schedules append after automatically transferring ownership when idle.
- Added scheduled-task management and a dedicated Cron conversation filter, with run history, pause/resume, and safeguards against duplicate or overlapping runs.

## 1.18.1 — 2026-09-11

- Parent conversations now stay marked as running and prevent premature cleanup while background child agents are still working, whether spawned from Pi's multi-agent orchestration or Claude's native task system.

## 1.18.0 — 2026-09-11

- Conversations can now be forked from the session menu with history, settings, and labels preserved. Independent copies have an `[F]` name prefix.

## 1.17.2 — 2026-09-10

- Fixed updates panel to enable peer updates when the current node is already at the latest version, and auto-reload the page when the local node restarts after an update.

## 1.17.1 — 2026-09-10

- Attached credentials now refresh automatically before each message, so changes to secret accounts, rotations, and removals take effect on the next message without restarting the conversation.

## 1.17.0 — 2026-09-10

- Added conversation labels to tag discussions with predefined or custom classifications, and a filter to show conversations by label.

## 1.16.1 — 2026-09-10

- Fixed updates hanging while agents stopped, including Claude processes that had already exited or ignored termination.
- Refused updates when tools could not be confirmed stopped, preserving interrupted work for recovery without restarting over live tools.
- Kept the running installation untouched when update preparation failed and showed the server's reason in installer logs.

## 1.16.0 — 2026-09-10

- Added an Ubuntu browser executor for conversations across the cluster, with localhost traffic routed to the app's node.
- Added live browser viewing and manual control, tabs, popups, uploads, and downloads. Closing a viewer leaves its browser running.
- Added encrypted saved-login snapshots while keeping each conversation's cookies and storage separate.
- Kept the same browser when switching between Pi and Claude, and added browser CLI access to interactive, automated, and recovered agent runs.
- Kept Escape inside full-screen terminal programs instead of closing the embedded terminal.

## 1.15.0 — 2026-09-10

- Added a running conversations button to the mobile conversations list and chat toolbar for quicker access to active sessions.

## 1.14.1 — 2026-09-10

- Fixed conversation ownership takeover timing out when another node is offline. Ownership is saved locally and replicated when the node reconnects.

## 1.14.0 — 2026-09-09

- Queued messages can now select a different harness (Claude or Pi) from the conversation, with available models filtered by the selected harness.

## 1.13.1 — 2026-09-09

- Fixed Claude conversations failing authentication checks when Claude was already logged in through the command line.

## 1.13.0 — 2026-09-09

- Installer now prevents concurrent installations with OS-level locking and safely restores the previous version if updates fail, without reinstalling dependencies.
- Pi coding agent sessions now show their running state and are excluded from the review queue while active.
- Conversation action buttons now stay aligned inside the card when sub-agent tasks extend below it.
- Chat toolbar controls, action labels, and shortcut badges now line up on shared rows.
- Queued messages can now use different models and reasoning levels; settings persist across reconnections.

## 1.12.2 — 2026-09-08

- Escape now closes the recent conversations dialog.
- Shortcut numbers are centered in session and project cards.
- Settings Harnesses tab displays as one column with improved tab styling.

## 1.12.1 — 2026-09-08

- Shortcut numbers in session and project cards are now properly centered.
- Settings Harnesses tab now displays as one column instead of splitting, with improved tab styling for Harnesses and Secrets sections.

## 1.12.0 — 2026-09-08

- Keyboard shortcuts are now visible alongside action buttons, and new shortcuts added for app navigation, chat controls, and canvas operations.

## 1.11.0 — 2026-09-08

- Chat toolbar was streamlined by moving running conversations to the projects panel.
- Sub-agent conversations now collapse under their parent, are excluded from review counts, and can be expanded individually.

## 1.10.0 — 2026-09-08

- Claude sub-agent sessions now appear as read-only child sessions within your conversation list, showing task instructions and outputs.
- Node name and URL changes now reach every connected node as soon as they are saved.
- Project panel action buttons now sit in their own row below the title for clearer layout.

## 1.9.0 — 2026-09-08

- Header buttons show their assigned shortcut, and digits 1–9 and 0 select the first ten rows in picker dialogs.
- Shortcuts can use two-stroke sequences such as Control-Space followed by Backslash, without allowing prefix conflicts.
- Queued Claude messages can be edited or cancelled before they run; cancelled message attachments are removed.
- Leaving a cluster now requires reachable peers and removes their devices from Joint Bob's Syncthing folders.
- Settings adds secret-provider filters, separate Pi and Claude path tabs, resource folder pickers, and password changes.
- The project header gives its controls a separate row and puts Board beside the global conversation controls.
- Test processes reject production data paths, including symlinks to `~/.joint-bob`.

## 1.8.0 — 2026-09-07

- Customize keyboard shortcuts for any canvas or app command in Settings—record your preferred key combination instead of using preset leaders.
- Canvas splits now have dedicated shortcuts: Ctrl+Backslash splits right, Ctrl+Minus splits below.
- Conversations reliably open on any cluster node, even when other nodes are temporarily offline.
- Spotlight search navigates to workspace windows, settings tabs, and recent conversations.
- Settings tabs reorganized into a vertical sidebar on wide screens for easier access to all configuration sections.
- Recent conversations dialog now focuses on the search field automatically when opened.
- View all running conversations across your projects in one place with quick navigation to any live conversation.
- Changelog no longer shows internal hook runs, keeping it focused on user-visible changes.

## 1.7.0 — 2026-09-07

- Search workspace shortcuts using a new spotlight interface
- Customize keyboard shortcuts from workspace settings
- Chat now displays a floating jump-to-bottom button with auto-follow
- Nodes can check for and install application updates from Settings

## 1.6.0 — 2026-09-06

- Handoff messages are now shorter when conversations continue across components
- Newly created conversations now appear immediately in your recent conversations list
- Conversation filter buttons now display visual icons for All, Running, Needs review, and Reviewed states
- Canvas now uses recursive tmux-style splits with draggable dividers and reorderable multi-page layouts to keep panes organized
- Canvas conversations can now be filtered by project and arranged by name, recent activity, or creation date
- Terminal-style keyboard shortcuts now control canvas panes: Ctrl+Space to split or close, and ⌘⇧V to return to the previous view
- Files now open in the dialog editor with aligned split panes instead of opening in a new tab
- Conversations can now switch between Claude and Pi mid-chat while staying as one unified conversation with a visible handoff marker
- Cluster settings now show each connected node's name, address, and connection status
- Claude session titles now display your actual prompt intent instead of framework scaffolding
- Engine settings now validate custom runtime paths and show detected defaults before saving
- Pinned conversations remain pinned across harness switches with full transcript history preserved

## 1.5.0 — 2026-09-06

- Recent conversations now sync across cluster nodes and merge concurrent opens correctly
- Settings and configurations now accept custom directories for agent skills, prompts, rules, and plugins
- Shared agent resources now sync across cluster nodes
- Tickets can now skip directly to Done without requiring implementation phases
- Done ticket conversations now preserve with an option to continue work in a new chat
- Ticket conversation buttons now appear in the correct layout order in session lists
- Task handoffs now preserve conversation ownership across cluster nodes
- Conversation row buttons on phones no longer sit flush against each other
- The workspace settings tab is now labeled "Workspaces" instead of "Projects"
- Unhandled server errors are now logged for better debugging

## 1.4.1 — 2026-09-05

- Symlinked skill directories are now discovered and loaded alongside regular directories
- Ticket handoffs now wait visibly for both nodes to finish synchronizing and continue automatically when ready
- Volatile test artifacts no longer enter ticket workspaces or Syncthing scans
- Notifications now stay above the mobile composer and duplicate messages no longer stack

## 1.4.0 — 2026-09-05

- Tasks now support file and image attachments that persist in the workspace and are included when agents take over the work
- Ticket conversations now correctly open from the board button even when another conversation was previously open
- Task conversations now preserve session identifiers when routed to remote cluster nodes

## 1.3.1 — 2026-09-04

- Secret accounts attached to workspaces now reject duplicate variable names when syncing across nodes

## 1.3.0 — 2026-09-04

- Canvas panes now resize in both dimensions with visible drag handles and support configurable keyboard shortcuts to jump between conversations
- Harness adapters are now automatically discovered and registered
- Harness conversations now sync across all cluster nodes
- Conversations and projects can now be pinned directly from list rows
- Ticket conversations are marked in the chat and can jump to their tickets
- Claude sessions now support compaction commands and tool selection configuration
- Task descriptions now support up to 20,000 characters
- Secret account changes now instantly replicate to all cluster nodes on save
- Ticket management is now consolidated into projects
- Conversation titles now correctly persist in chat headers after renaming
- App automatically refreshes when deployed while the browser window is open
- Server stability improved with better database lock handling and Syncthing startup retry logic

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
