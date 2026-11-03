# Subscription profiles

Joint Bob supports multiple node-local Claude subscription logins, ChatGPT logins through Pi's OpenAI Codex provider, Pi provider sign-ins, and Kiro IAM Identity Center accounts.

## Add a profile

Open Settings → Connections. It has three tabs: **Profiles**, **Pools**, and **Assignments**. On **Profiles**, pick the provider tab (Claude, ChatGPT, Pi, or Kiro), name the profile, add it, then sign in. A Kiro profile also needs its IAM Identity Center start URL and AWS region. The OAuth flow opens the provider's sign-in page or shows a device code. Complete it in the browser, then return to Joint Bob. Logins never go through the relay.

Kiro profiles are private and stay on the node where they were signed in. They cannot be shared for automation or join a pool.

Each profile card shows its sign-in state: **Signed in on this node**, **Using the sign-in on <twin>**, **Not signed in**, or **Sign-in unavailable**. The state is checked when the card is shown and again with **Check status**.

## Twins

Your twins receive your profiles (name, provider, sharing state) and every default, workspace, project and conversation choice automatically, and the newest edit wins. Deleting a profile on one twin deletes it on the others, along with their own sign-ins for it. A member's profiles never go to the administrator's twins, and profile events never go to a cluster or to a node you only visited.

A sign-in stays on the node where you signed in. A twin without its own sign-in for a profile asks the twin that has one for a short-lived access token over the signed, end-to-end encrypted machine channel. The lending twin refreshes the login under its own lock and sends only the access token; the refresh token never leaves it. Two machines therefore never rotate the same login and sign each other out. The borrowing twin keeps the token in memory until ten minutes before it expires.

The lending twin must be online when the borrowing twin starts a turn and its token has run out. If no twin can lend one, the turn stops with a sign-in error and no other account is used. Signing in on a twin as well gives that twin its own independent login, which it uses first.

## Ownership and sharing

Each profile belongs to the Joint Bob account that created it. Only that account can manage sign-in, sign-out, deletion, or sharing. The owner ID, provider, label, creation time, and sharing state are stored on this node. This is current ownership metadata, not a historical usage audit log.

Profiles start private. The owner can choose **Share for automation** to make a profile selectable by every user on this node for scheduled tasks, webhooks, and automatic replies. Shared profiles cannot be used for interactive human turns, including by their owner. Making the profile private revokes other users' automation access immediately at the next execution check.

## Select a profile

On **Assignments**, pick the provider tab, then choose the profile or pool that **every conversation** on that provider uses. To use a different one in a single workspace, in the projects shared through one cluster or relay group, in one project, or in one conversation, choose **Add exception**, pick where it applies, and pick the profile or pool. Remove an exception to go back to the next matching choice. Each change is saved when you confirm it. These choices belong to **you**, not the project owner, even on a shared project. Assigning your profile to a workspace, project, or conversation never shares the profile with another user. Queued human turns retain their author's identity when another user's connection drains the queue.

The most specific saved choice wins:

1. Conversation
2. Project
3. Cluster (any cluster or relay group the project is shared through)
4. Workspace
5. Your default

A project shared through two clusters with different cluster choices stops with an error naming the conflict; keep one cluster choice or add a project exception.

Choose the first option as the default, or remove an exception, to clear a choice at that level. When nothing is chosen at any level and you have exactly one private profile for the provider, that profile is used; the default picker shows it as **Automatic**. With two or more, none is guessed. A Pi profile holds several providers, so a single Pi profile is used only for turns whose provider it holds. Members without an applicable subscription profile must select their own profile; they cannot fall through to the node administrator's subscription. Existing administrator/node configuration remains available for legacy unassigned node work. A choice that points at a profile shared for automation is marked in red as unavailable and must be changed before your next turn.

The selection takes effect on the next turn. An already-running turn keeps its existing account. Switching a conversation can send its prior transcript to a different provider account, so Joint Bob asks for confirmation before saving the selection.

## Subscription pools and failover

A subscription pool groups private profiles you own. On the **Pools** tab, choose **New pool**, arrange its members in failover order, and choose the model to use after switching to each provider the pool holds; a mixed-provider pool requires one. Pool selectors are searchable wherever a profile can be chosen. **Test failover** on a pool card is local to the page: marking a member unavailable changes neither saved pool data nor real provider quotas.

For a turn, Joint Bob tries profiles from the current provider first, preserving the pool order within each provider. Pi can switch providers; after a switch it uses the configured classifier mapping for the current difficulty when available, otherwise that provider's pool fallback model. Claude Code stays on Claude, and Kiro cannot use pools.

A retry is allowed only for a recognized subscription quota, authentication, or availability failure before any assistant output or tool execution. The failed attempt is rolled back before the next candidate runs. Generic failures, user cancellation, or failures after output/tool start are returned without retry; no attempt falls back to ambient credentials or a different account. Quota availability is simulated only for that turn and does not disable a member on later turns.

## Cluster assignments and relay

To use a profile or pool in the projects shared through one cluster or relay group, add a **Cluster** exception on the **Assignments** tab. It is your own choice, like any other: it syncs to your twins and applies on your machines only. Other members keep their own choices, and no cluster member or manager is asked, so an offline member cannot block it. It applies wherever your turn runs with your choices, including when a teammate works through the relay on a project you own. Your other projects keep your other choices at the same time.

A pool can also be attached to a whole cluster for every member, an older kind of assignment that the page no longer creates. If a member has made one, the **Assignments** tab names it, and it still wins in that cluster's projects. The pool owner made it after every member confirmed pool-protocol support; for a relay group, the relay signs it as the group's manager, and while it is attached a machine without pool support cannot join. Only the pool owner can change or clear it.

Cluster members receive a signed, non-secret pool manifest, not provider credentials. When a turn needs a profile held on another node, the manager revalidates the current cluster assignment and membership before the holder lends a short-lived access token over the signed peer channel. The refresh credential stays on the profile holder; the borrowed token is kept in memory and never becomes a cluster manifest.

## Automation assignments

Schedules, webhooks, and automatic replies have a **Run with profile** dropdown. **Use my current profile** is the default and resolves the creator's personal conversation → project → workspace → default selection for the turn's provider when it runs. An explicit profile assignment remains pinned until edited and can refer to the creator's private profile or any shared automation profile on this node.

The creator and assignment are stored server-side and carried through queued execution. Access, provider compatibility, and execution-node identity are checked again at run time. Deletion, revoked sharing, unavailable login, or a mismatched provider fails visibly rather than using another account. Incoming webhook payloads cannot replace the stored creator or assignment.

## Token refresh and removal

Claude refresh authority is the installed Pi SDK's node-local private auth file (provider `anthropic`), not Claude CLI's native credential store. First access migrates legacy credentials through private owner-runtime IPC under a serialized migration gate, saves the canonical credential, then removes native refresh-token copies. An existing canonical store, including a signed-out store, is never reseeded from legacy credentials.

Each Claude turn receives only the selected short-lived access token in `CLAUDE_CODE_OAUTH_TOKEN`, after competing authentication is scrubbed. Its fresh, credential-free config directory and transcript link belong to the project's execution OS runtime; tools never move to the profile owner's runtime. Refresh credentials remain service-private (0700 directories, 0600 files). Pi's auth-file lock serializes refresh with a minimum remaining token lifetime. Missing or revoked selected credentials fail without another account fallback. Login, status, and logout use this same canonical authority.

A crashed migration writer leaves a fail-closed `.authority-lock` directory beside its auth file. An administrator may remove that lock only after stopping the node service and confirming no writer remains.

OpenAI Codex credentials stay in a separate private auth file for each profile. Pi refreshes tokens through its OAuth provider under the SDK auth-file lock. Concurrent requests therefore share the rotated refresh token rather than refreshing separate stale copies.

If a provider has revoked a login, that profile's turn stops with a sign-in error. Joint Bob never silently switches to another profile or a provider API key. Sign out or sign in again on that node from Settings → Connections.

Claude transcripts continue using the configured session directory. Subscription profile directories share that transcript directory by link, so account selection does not fork or move conversation history. Local credentials remain outside the synchronized transcript tree.
