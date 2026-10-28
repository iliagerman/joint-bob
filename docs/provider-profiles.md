# Subscription profiles

Joint Bob supports multiple node-local Claude subscription logins and ChatGPT logins through Pi's OpenAI Codex provider.

## Add a profile

Open Settings → Harnesses. The **Subscription profiles** card sits below the **Harness configuration** card. Choose Claude or ChatGPT, name the profile, add it, then sign in. The OAuth flow opens the provider's sign-in page or shows a device code. Complete it in the browser, then return to Joint Bob. Logins never go through the relay.

Each profile card shows its sign-in state: **Signed in on this node**, **Using the sign-in on <twin>**, **Not signed in**, or **Sign-in unavailable**. The state is checked when the card is shown and again with **Check status**.

## Twins

Your twins receive your profiles (name, provider, sharing state) and every default, workspace, project and conversation choice automatically, and the newest edit wins. Deleting a profile on one twin deletes it on the others, along with their own sign-ins for it. A member's profiles never go to the administrator's twins, and profile events never go to a cluster or to a node you only visited.

A sign-in stays on the node where you signed in. A twin without its own sign-in for a profile asks the twin that has one for a short-lived access token over the signed, end-to-end encrypted machine channel. The lending twin refreshes the login under its own lock and sends only the access token; the refresh token never leaves it. Two machines therefore never rotate the same login and sign each other out. The borrowing twin keeps the token in memory until ten minutes before it expires.

The lending twin must be online when the borrowing twin starts a turn and its token has run out. If no twin can lend one, the turn stops with a sign-in error and no other account is used. Signing in on a twin as well gives that twin its own independent login, which it uses first.

## Ownership and sharing

Each profile belongs to the Joint Bob account that created it. Only that account can manage sign-in, sign-out, deletion, or sharing. The owner ID, provider, label, creation time, and sharing state are stored on this node. This is current ownership metadata, not a historical usage audit log.

Profiles start private. The owner can choose **Share for automation** to make a profile selectable by every user on this node for scheduled tasks, webhooks, and automatic replies. Shared profiles cannot be used for interactive human turns, including by their owner. Making the profile private revokes other users' automation access immediately at the next execution check.

## Select a profile

Under **Where each profile is used**, pick a profile for your default and for each workspace, for Claude and ChatGPT, then choose **Save choices** once. Inherited cells show which profile they fall back to. Under **Project and conversation overrides**, add or remove an override for a single project or conversation. These choices belong to **you**, not the project owner, even on a shared project. Assigning your profile to a workspace, project, or conversation never shares the profile with another user. Queued human turns retain their author's identity when another user's connection drains the queue.

The most specific saved choice wins:

1. Conversation
2. Project
3. Workspace
4. Your default

Choose the inherit option to remove a choice at that level. Members without an applicable subscription profile must select their own profile; they cannot fall through to the node administrator's subscription. Existing administrator/node configuration remains available for legacy unassigned node work. A choice that points at a profile shared for automation is marked in red and must be changed before your next turn.

The selection takes effect on the next turn. An already-running turn keeps its existing account. Switching a conversation can send its prior transcript to a different provider account, so Joint Bob asks for confirmation before saving the selection.

## Automation assignments

Schedules, webhooks, and automatic replies have a **Run with profile** dropdown. **Use my current profile** is the default and resolves the creator's personal conversation → project → workspace → default selection for the turn's provider when it runs. An explicit profile assignment remains pinned until edited and can refer to the creator's private profile or any shared automation profile on this node.

The creator and assignment are stored server-side and carried through queued execution. Access, provider compatibility, and execution-node identity are checked again at run time. Deletion, revoked sharing, unavailable login, or a mismatched provider fails visibly rather than using another account. Incoming webhook payloads cannot replace the stored creator or assignment.

## Token refresh and removal

Claude refresh authority is the installed Pi SDK's node-local private auth file (provider `anthropic`), not Claude CLI's native credential store. First access migrates legacy credentials through private owner-runtime IPC under a serialized migration gate, saves the canonical credential, then removes native refresh-token copies. An existing canonical store, including a signed-out store, is never reseeded from legacy credentials.

Each Claude turn receives only the selected short-lived access token in `CLAUDE_CODE_OAUTH_TOKEN`, after competing authentication is scrubbed. Its fresh, credential-free config directory and transcript link belong to the project's execution OS runtime; tools never move to the profile owner's runtime. Refresh credentials remain service-private (0700 directories, 0600 files). Pi's auth-file lock serializes refresh with a minimum remaining token lifetime. Missing or revoked selected credentials fail without another account fallback. Login, status, and logout use this same canonical authority.

A crashed migration writer leaves a fail-closed `.authority-lock` directory beside its auth file. An administrator may remove that lock only after stopping the node service and confirming no writer remains.

OpenAI Codex credentials stay in a separate private auth file for each profile. Pi refreshes tokens through its OAuth provider under the SDK auth-file lock. Concurrent requests therefore share the rotated refresh token rather than refreshing separate stale copies.

If a provider has revoked a login, that profile's turn stops with a sign-in error. Joint Bob never silently switches to another profile or a provider API key. Sign out or sign in again on that node from Settings → Harnesses.

Claude transcripts continue using the configured session directory. Subscription profile directories share that transcript directory by link, so account selection does not fork or move conversation history. Local credentials remain outside the synchronized transcript tree.
