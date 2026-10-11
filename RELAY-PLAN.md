# Relay connectivity — plan for review

Status: **implemented** (see section 10 for where the code differs from this design). All decisions are recorded in section 7.

## 1. Goal

Machines in a cluster can talk to each other without Tailscale or any other extra install.

- **Two transports, side by side.** Direct connections, including Tailscale, keep working exactly as they do today. A relay is a second transport for machines without a reachable URL.
- **Any Joint Bob can serve as a relay.** A relay is always a working machine as well. Relay serving is off by default and has its own Settings tab.
- **Several relays**, for example one per environment (dev, staging, prod, or personal and work). A machine can belong to several relays.
- **Machines behind a relay need no public URL.** They only make outbound connections, so they work behind NAT, home routers and most firewalls.
- **Two ways to admit a machine to a relay:**
  - the operator creates a token and a human passes it to the machine's owner;
  - the machine asks to join and the operator approves it.
- **Phone access:**
  - Tailscale access keeps working unchanged (M1).
  - Every machine on a relay gets a name, and the phone can sign in to that machine at `https://<name>.<relay-domain>` through the relay (M2).
- **Sharing rules don't change.** The relay changes how bytes reach a machine, never who may see what. Workspace, project, conversation, file, secret, skill, browser-profile and login sharing stay bound to the existing cluster and twin rules (section 4.10).

## 2. What exists today

- **A peer is one URL.** Each node has a single `url` (`src/cluster.ts:58`, from `JOINT_BOB_NODE_URL`). Membership rows store it per cluster (`cluster_v2_membership_nodes.url` in `src/cluster-membership.ts:58`), and so do pending deliveries and manager transfers.
- **The URL must be HTTPS or loopback, with path `/`** (`isClusterOriginUrl` in `src/server/http-auth.ts:62`). Building a node descriptor throws when the URL is missing (`src/server/cluster-v2.ts:61`), so today a machine with no URL can't join a cluster.
- **About 93 call sites in 39 files reach peers** with `fetch(new URL(target, peer.url))` or `new WebSocket(...)`. Examples are `signedPost` (`src/server/cluster-v2.ts:99`), chat proxying (`src/server/chat-socket.ts:184`), the browser viewer (`src/server/browser.ts:692`), replication, twins, file sharing and tasks.
- **Machine requests are already authenticated end to end.** They use Ed25519 node keys and signed envelopes that bind the sender, recipient, method, path, body hash, timestamp and nonce (`CLUSTER-SHARING-DESIGN.md` §2). A transport in the middle can't forge or alter requests, but it can read them.
- **Cluster invitations are links on the manager's origin**: `https://<manager-origin>/join#v2.<fingerprint>.<payload>` (`src/server/cluster-v2.ts:65`). The signed body carries the manager's URL.
- **Cross-node proxying already exists.** A node's UI shows conversations and browsers owned by other nodes by proxying to the owner (`src/server/chat-socket.ts:184`). A phone that reaches **one** machine can already work with the whole cluster.
- **Browser sessions are host-only cookies.** The session cookie has no `Domain` attribute and is `SameSite=Strict` (`src/auth.ts:513`). Chat WebSockets require the `Origin` host to equal the `Host` header (`src/server/chat-socket.ts:95`). Sign-in supports TOTP MFA (`src/auth.ts`).
- **Syncthing devices use `addresses: ["dynamic"]`** (`src/syncthing.ts:362`). That turns on global discovery, the public Syncthing relay pool and LAN discovery.
- **There is one HTTP server** (`createServer(app)` in `src/server/state.ts:100`). Incoming relay streams can be handed to it with `server.emit("connection", stream)`.
- **Node 22's `node:crypto` has every primitive needed for a Noise handshake.** X25519, ChaCha20-Poly1305, SHA-256, HKDF and BLAKE2b were all checked on this machine.

## 3. Concepts

- **Relay node.** A working Joint Bob machine that also has relay serving on. It has a public HTTPS origin (`<relay-domain>`), a wildcard name (`*.<relay-domain>`), an operator (that machine's admin) and an environment label. As a relay it forwards traffic between admitted machines. Its own projects and clusters work like any other machine's, and the relay role gives it no access to clusters it isn't a member of.
- **Relay membership.** A machine's admission to one relay: relay origin, relay key fingerprint, environment label, **relay name**, and status (pending, admitted or revoked).
- **Relay name.** A DNS-safe name that is unique on that relay, such as `office-mac`. It's the machine's address on the relay for other machines and for phones: `https://office-mac.<relay-domain>`. A machine has one name for each relay it's on.
- **Machine without a direct URL.** A working machine that others can reach only through a relay. It's still a full machine and syncs files like any other.
- **Peer address.** How to reach a node. Today that's one URL. It becomes a list:
  - `{ kind: "direct", url }`
  - `{ kind: "relay", relayOrigin, relayFingerprint, name }` (one entry for each relay the node is on)

## 4. Design

### 4.1 Connection to a relay

- Each machine keeps **one persistent outbound WebSocket (WSS) per relay** it's admitted to. It authenticates with a challenge signed by its node key. The relay checks that key against its list of admitted machines.
- **No polling.** The relay pushes over the open socket, which stays idle when there's nothing to send. A dropped connection reconnects with backoff. Networks that block WebSockets fall back to long-polling, where a request stays open until there's data. This follows the existing push-on-change rule.
- The relay knows which machines are online and pushes presence changes to every machine with a peer on that relay. This replaces timeout probes in `src/server/peer-availability.ts` for relay peers. Pending outboxes flush when a peer comes online instead of waiting for a retry timer.

### 4.2 Channels and streams

- **Channel.** When machine A first needs machine B through a relay, it opens an **encrypted channel** to B (section 4.3). The relay pairs A's channel frames with B's connection and copies them across. It only sees ciphertext, plus who talks to whom, when, and how much.
- **Streams inside a channel.** Each HTTP request or WebSocket to B is a stream inside the channel. The frames are open, data, window and close, and each stream has its own flow-control window. That way a large file transfer can't block chat traffic. The relay applies flow control per channel only.
- On B, each stream is a Node `Duplex`, passed to the existing server with `server.emit("connection", stream)`. Routes, WebSocket upgrades, streaming responses, auth and signed-request checks all run unchanged.
- The channel stays open while both machines stay connected to the relay. A reconnect creates a new channel with fresh keys.

### 4.3 End-to-end encryption (decided: our own Noise implementation)

The handshake is the **Noise protocol, pattern `Noise_XX_25519_ChaChaPoly_SHA256`**, implemented in-repo on `node:crypto`. No new dependencies.

- **Why Noise.** It's a small, fully specified framework used by WireGuard, WhatsApp and libp2p. Its handshake state machine is about 300 lines, and the published Noise test vectors (cacophony and snow) let us check our implementation byte for byte.
- **Why XX.** Neither side needs the other's X25519 key in advance, so the same handshake works for cluster peers, cluster joins and twins.
- **Binding to node identity.** Each node gets a static X25519 key, stored encrypted the way the Ed25519 identity key is.
  - In the handshake payload, each side sends its node ID and an Ed25519 signature over `"joint-bob-relay-noise-v1" ‖ static X25519 key`.
  - Each side checks the other's signature against the Ed25519 key it expects: the pinned key from cluster membership, or the key in the invitation during a join. libp2p does the same.
  - The relay can't impersonate a machine, because it doesn't have any machine's Ed25519 key.
- **Channel identity vs. permission.** The channel proves which node key is on the other end. Whether that key may do something is still decided by the existing signed-request checks, which must name the same key.
- **Limits.** A channel closes before its 64-bit nonce could wrap, which can't happen in practice. There's no rekeying in v1.
- **Before release.** It must pass all `Noise_XX_25519_ChaChaPoly_SHA256` test vectors, and the handshake and identity binding get an external security review.
- **Fallback library.** If owning the code turns out badly, swap to [`noise-handshake`](https://www.npmjs.com/package/noise-handshake). It's maintained by Holepunch (used by Hyperswarm), Apache-2.0, and was last released December 2025. It adds a native libsodium binding (`sodium-universal`), next to the existing `node-pty`. The channel API stays the same either way.

The phone gateway (section 6) can't use this, because a browser can't run our handshake. It has its own trade-off, D13.

### 4.4 Peer calls in the code

Add `peerFetch(peerId, target, init)` and `peerSocket(peerId, target, opts)` helpers. They pick the transport (4.6) and use `http.request` or `ws` with `createConnection` for relay streams. Each of the ~93 call sites is edited once, mechanically. No new dependency.

### 4.5 Addresses in the cluster protocol

- `url` becomes optional on node descriptors, membership rows, deliveries and twin records. A new `addresses` field holds the list from section 3. Old peers keep reading `url`, and new peers fill both fields while mixed versions exist.
- `isClusterOriginUrl` stays the check for direct URLs. A node needs **at least one** address: a valid direct URL or one relay membership.
- **Invitation links.** The signed body adds the manager's relay addresses. When the manager has no direct URL, the link is built on the relay origin: `https://<relay-domain>/join#v2.<fingerprint>.<payload>`. The relay serves `/join` only to hand the link to the joiner's own Joint Bob. The secret stays in the URL fragment, which browsers never send to the server.
- Joining needs a shared relay. If the joiner isn't on any relay the manager uses, the join screen says so. It then offers "Request access to <relay>" or "Paste relay token". Relay admission and cluster joining stay two separate steps in v1.

### 4.6 Choosing a transport

For each peer, try addresses in this order:

1. a direct URL, if the peer has one **and** this machine can reach it;
2. the relay that last carried a channel to this peer (remembered across restarts);
3. every other relay that currently reports the peer online.

Nobody picks relays by hand. Usually there is only one. If the remembered relay is gone or replaced, it stops reporting the peer, or answers that it cannot reach it, and the next relay is tried at once. The one that works is remembered. Machines that talk directly today keep doing so.

### 4.7 Relay serving (Settings → Relay)

The **Relay** tab is visible only to the machine's admin and off by default. Its lists paginate (no scrolling lists), and management happens in the tab, not in dialogs.

- **Turn on.** Set the public origin and environment label. The tab shows the relay's key fingerprint, the number of connected machines and current throughput, and DNS and TLS check results for `<relay-domain>` and `*.<relay-domain>`.
- **Machines.** For each admitted machine:
  - name, node ID, key fingerprint, online or offline, last seen, traffic;
  - how it was admitted (which token, or approved by whom);
  - whether phone sign-in is on.

  Actions are **rename**, suspend and revoke. Revoking closes the connection at once and bans that key.
- **Relay names.**
  - When a machine is admitted, it proposes a name based on its node name, and the relay makes it unique by adding `-2`, `-3` and so on.
  - Names are DNS labels: lowercase letters, digits and `-`, up to 63 characters.
  - A revoked machine's name stays reserved for 30 days, so a phone with an old bookmark or cookie never reaches a different machine under the same name.
- **Tokens.** Create a token with a label, an expiry (default 24 h), a number of uses (default 1) and an optional suggested name. The secret is shown once, as a link: `https://<relay-domain>/enroll#<relayFingerprint>.<secret>`. Only its hash is stored. Tokens can be revoked before use.
- **Access requests.**
  - A pending request shows the machine name, the key fingerprint and a **6-digit pairing code**.
  - The same code appears on the requesting machine, so the operator can confirm it's the machine they expect before approving.
  - Requests can be turned off entirely and are rate-limited per source IP.
- **Limits.** Optional per-machine bandwidth caps, with an ntfy alert to the operator, and a maximum number of machines.
- **Routing scope:** any admitted machine may open channels to any other admitted machine. Cluster rules in Joint Bob still decide what each request may do.
- **Only my own machines.** One switch limits the relay to this machine's twins (the same owner's machines). Other machines are disconnected and refused, and their phone addresses stop working.
- **Audit log** of admissions, renames, revocations and token use.

All of this runs in the same Joint Bob server process, with endpoints under `/api/relay/v1/*`, the `/join` and `/enroll` landing pages, and the phone gateway for `*.<relay-domain>`. The relay node gets a relay name on its own relay too, so a phone reaches it the same way as any other machine.

### 4.8 Machine side (Settings → Relay → Joined relays)

- **Add relay**, either by pasting a token link (admitted immediately) or by entering a relay origin and choosing **Request access**.
  - Request access shows the relay's fingerprint and the pairing code.
  - The machine waits on its open connection and is told when the operator decides. It never polls.
  - The relay fingerprint is pinned on first contact. Token links already carry it.
- For each relay:
  - environment label, status, leave;
  - **phone access**: addresses that work right now on that relay, for this machine, the relay machine, and this user's own cluster and twin machines on it. Each address can be opened, copied or shown as a QR code to scan with the phone's camera. The relay names only machines this one already knows, so other people's machines are never listed;
  - a switch for **phone sign-in through this relay**, on by default (section 6).
- **Other users' phone sign-in.** One switch for the machine decides whether accounts whose home is another machine may sign in to it from a phone through a relay. Turning it off also ends their open phone sessions; the machine's own accounts are unaffected.
- **This machine's direct URL** stays as it is today and is optional. Machines with Tailscale keep their URL.

### 4.9 File sync between machines without a direct URL

Every machine is a working machine and its files always sync. When two machines share a relay, their files go **through that relay**. Syncthing's public relays are used only when there is no other path (D7).

Path order for each pair of machines:

1. **Direct**, when the peer has a direct URL this machine can reach. This is today's behaviour, unchanged.
2. **Our relay**, when both machines are on a relay the cluster allows.
   - Joint Bob opens a loopback port on each machine for that peer, and adds `tcp://127.0.0.1:<port>` to the peer's Syncthing addresses.
   - Syncthing's traffic then flows through our encrypted channel to the peer's Syncthing.
   - Only Joint Bob is needed. The relay host runs nothing extra.
3. **Syncthing's public relays** (part of today's `dynamic` setting), only when neither of the above is available, for example when our relay is down.

How the order is enforced:

- Syncthing ranks connections by type, and relay connections rank last. The loopback tunnel address counts as a LAN connection, so Syncthing prefers it to public relays without extra settings. It also moves to the tunnel automatically once the tunnel is back.
- Joint Bob adds the tunnel address only for peers it reaches through a relay (4.6). Machines that reach each other directly keep plain `dynamic`, as today.
- The test suite checks this order (section 9).
- Which folders go to which devices is still decided by the existing sharing code (`src/server/sharing-files.ts`). The relay only changes the address Syncthing dials.

### 4.10 Sharing and access rules stay unchanged

The relay is a transport. Every sharing decision keeps running in the same code, on the same machine, with the same inputs as today.

**What stays exactly as it is:**

- **Clusters:** membership, the manager role, invitations, join order and removal rights (`src/cluster-membership.ts`, `CLUSTER-SHARING-DESIGN.md`).
- **Twins:** the twin handshake and twin trust (`src/cluster-twins.ts`, `src/server/twins.ts`, `src/server/twin-sharing.ts`).
- **Resource sharing:**
  - workspaces, projects and project files;
  - conversations and transcripts;
  - secrets, skills, quick notes, ntfy and routing policies.

  These run through `mayReceiveResource` and `isTrustedTwin` (`src/cluster-sharing-policy.ts`), `mayReplicateEvent` (`src/server/replication-v2.ts`), `src/selected-sharing.ts`, `src/server/shared-transcripts.ts`, `src/secret-replication.ts`, `src/skill-sharing.ts`, `src/server/shared-quick-notes.ts` and `src/server/ntfy-share.ts`.
- **Browser profile sharing:** the conversation, project, workspace, machine and cluster scopes.
- **Login:** who may sign in on a machine. That's its local users, plus replicated users whose home machine shares a cluster or twin relationship with it, limited to the features `src/features.ts` allows (`src/user-replication.ts`).

**Rules the relay work must follow:**

1. **Relay admission grants nothing.** Two machines on the same relay that share no cluster and no twin relationship can't exchange any resource. Their requests fail the same signed checks they fail today. Relay presence is never treated as membership.
2. **Peers come only from cluster and twin records.** The relay never adds, suggests or auto-joins peers. It only provides another address for a peer this machine already knows.
   - Relay addresses are stored next to direct URLs in `cluster_v2_peer_endpoints`, under the same cluster or twin context they were learned in (`src/cluster-peer-endpoints.ts`).
3. **One authorization path.** Requests that arrive over a relay stream go through the same server, middleware, signed-request checks and replication filters as direct requests. No relay-specific route serves shared data.
4. **The channel must match the signature.** A request signed by machine X that arrives on a channel authenticated as machine Y is rejected. This stops the relay, or a confused peer, from presenting one machine's request as another's.
5. **Relay streams are never local.**
   - Today no access rule trusts the connection's source address. I checked: the local agent endpoints use bearer tokens, not loopback.
   - Relay and gateway streams get a remote, non-loopback socket marker, so any future loopback check can't mistake them for local traffic.
6. **Phone sign-in follows the same login rules.** The gateway accepts exactly the accounts the machine accepts on its direct URL, with the same feature limits for replicated users.
   - The relay has no accounts on machines, and its operator gets no access to any machine's data. The one exception is reading phone sessions in transit (D13).
7. **The relay node shares only through its own memberships.** As a working machine it follows the same rules as any other. Relaying traffic gives it nothing.
8. **The relay never stores or parses shared resources.** It sees only ciphertext between machines. Phone gateway sessions (D13) are the only plaintext it handles, and it doesn't store them.

**How this is enforced:** see the sharing-invariance tests in section 9. Every phase must pass them before it merges.

## 5. Phases

Every phase must keep the existing sharing tests and the sharing-invariance suite (section 9) passing.

1. **Addresses.** Make `url` optional, add `addresses`, and keep compatibility with old peers. No behaviour change. Direct and Tailscale paths are covered by regression tests from this phase on, and so is the baseline for the sharing-invariance suite.
2. **Noise channel.** The in-repo `Noise_XX_25519_ChaChaPoly_SHA256` implementation, identity binding, test vectors and the stream multiplexer. It has no network code yet, so it can be reviewed on its own.
3. **Relay serving.** The Relay tab, tokens, access requests with pairing codes, relay names, admission, presence and channel pairing. Tests use two machines and a loopback relay.
4. **Machine client.** Relays section, persistent connection, `peerFetch` and `peerSocket`, moving every call site over, transport choice.
5. **Cluster flows over relays.** Invitations and joins, the twin handshake, replication, chat and browser-viewer proxying, presence-driven outbox flush.
6. **File sync over relay.** Loopback tunnels for Syncthing, with public relays only as the last resort (4.9).
7. **Phone gateway (M2).** Wildcard routing, per-machine switch, sign-in rules (section 6).
8. **Hosting guide for AWS** (section 8) and release.

## 6. Mobile

### M1. Tailscale — kept as it is (decided)

Phones on Tailscale keep opening a machine's Tailscale URL. Nothing in this plan changes direct URLs, sign-in, cookies or the PWA on those origins. Phase 1 adds a regression test for this path, and every later phase must keep it passing.

### M2. Sign in to a machine by its relay name (decided)

**How it works:**

1. The phone opens `https://office-mac.<relay-domain>`, the address shown in that machine's Relays section.
2. The relay ends TLS with its wildcard certificate, finds the admitted machine with that name, and opens a **gateway stream** to it over the machine's existing relay connection.
3. The machine serves its normal UI over that stream. The user signs in with **that machine's own Joint Bob account** and MFA, exactly as at home.
4. From there, the existing cross-node proxying reaches conversations and browsers on the machine's other cluster peers.

**Behaviour:**

- The PWA installs per name, like any other origin. Each machine is a separate origin, so cookies, the service worker and storage never mix between machines.
- The machine treats gateway streams as HTTPS:
  - the session cookie keeps `Secure`;
  - `Host` stays `office-mac.<relay-domain>`, so the existing Origin check for chat sockets works unchanged.
- The gateway-open frame carries the phone's real IP. The machine uses it for sign-in rate limits and logs, and trusts that IP only from an admitted relay.
- A name that isn't admitted, is suspended, or has phone sign-in off gets a plain 404 page from the relay.
- If the relay is down, Tailscale (M1) still works for machines that have it.

**Trade-offs (decided in D13–D15):**

- **The relay can read phone sessions.** A browser can't run our Noise channel, so TLS ends at the relay. Phone traffic is encrypted between phone and relay, and between relay and machine inside the relay connection. The relay process itself sees the pages and the session cookie.
  - That's acceptable when you run the relay yourself.
  - True end to end would need a certificate on each machine for its relay name, with the relay passing raw TLS through by SNI. The machine would keep its own key and the relay would get the certificate through a DNS-01 challenge. It works, but it's heavy, and public CAs rate-limit certificates per domain.
- **The sign-in page is on the internet.** Phone sign-in is on by default (D15), and the account behind it can run agents with shell access. Mitigations:
  - sign-in rate limits on both the relay and the machine;
  - MFA required for gateway sessions (D14). Until the machine's user sets up MFA, the gateway shows a "set up MFA to use phone sign-in" page, and the Relays section shows the same hint;
  - a per-machine switch to turn phone sign-in off.

### Considered and not chosen

- **M3, sign in on the relay first.** This would mean human accounts on the relay and either two sign-ins or the relay signing in on your behalf. We can revisit it once the multi-user identity model (`MULTI-USER-PLAN.md` §3.1) exists.
- **M4, the relay as your login node.** The relay already is a working machine, so you can sign in to it like any other. Using it as the single entry point for all clusters adds nothing that M2 plus cross-node proxying doesn't already give.

## 7. Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | How the relay reaches a machine | Persistent WSS, long-poll fallback, no timed polling |
| D2 | End-to-end encryption between machines | In v1, our own `Noise_XX_25519_ChaChaPoly_SHA256` on `node:crypto`, verified with test vectors and an external review. `noise-handshake` is the fallback. |
| D3 | Peer call plumbing | `peerFetch` and `peerSocket` helpers |
| D4 | Relay routing scope | Any admitted machine to any admitted machine. Cluster rules decide what a request may do. Per-relay groups can come later. |
| D5 | Trusting a relay on "Request access" | Pin the fingerprint on first contact, with the fingerprint and pairing code shown on both sides. Token links carry the fingerprint. |
| D6 | Direct vs relay when both exist | Prefer direct, then the relay that last worked for that peer, then any other relay reporting it. No manual relay choice. |
| D7 | File sync path | Direct when reachable, otherwise through our relay. Syncthing's public relays only when there is no other path. |
| D8 | Relay node | Always a working machine. The relay role gives no access to clusters it isn't a member of. |
| D9 | Join link plus relay admission | Separate steps in v1 |
| D10 | Relay TLS | Caddy in front, with a wildcard certificate through DNS-01 |
| D11 | Bandwidth | Per-machine caps with an ntfy alert to the operator |
| D12 | Mobile | M1 (Tailscale) kept unchanged, plus M2 (sign in by relay name) |
| D13 | Phone gateway TLS | The relay ends TLS in v1, so it can read phone sessions. SNI pass-through can be added later if relays are run by someone other than the machine owners. |
| D14 | MFA for phone sign-in | Required for gateway sessions. Machines without MFA show a "set up MFA to use phone sign-in" page. |
| D15 | Phone sign-in default | On by default when a machine is admitted. The owner can turn it off per relay. |
| D16 | Sharing rules | Unchanged. The relay is transport only, and cluster and twin rules alone decide what is shared and who may sign in (4.10). |

## 8. Hosting a relay on AWS

- **Instance.** A Lightsail or EC2 instance running Joint Bob as a normal working machine with relay serving on. Caddy sits in front with certificates for `<relay-domain>` and `*.<relay-domain>`. The wildcard needs a DNS-01 challenge, for example through Route 53.
- **Cost.** All relayed traffic is billed outbound data, and it counts twice: once in from A, once out to B. Browser screencasts and file sync dominate. Lightsail bundles a monthly transfer allowance, which is usually much cheaper than EC2 metered egress for this pattern. Check current pricing before choosing.
- **Failure.** A relay outage cuts off machines that have no direct URL and no second relay. Direct and Tailscale paths keep working. Run two relays for important environments.
- **Placement.** Every relayed byte goes through the relay's region. Machines in the same room still go through AWS unless one has a direct URL the other can reach.

## 9. Testing

Follow `TESTING.md`:

- **Noise.** Every `Noise_XX_25519_ChaChaPoly_SHA256` test vector. Also:
  - the handshake rejects a wrong identity signature, an unpinned key and a replayed message;
  - an assertion that the relay sees only ciphertext.
- **Relay.** A loopback relay and two loopback machines (extend `test/dev-nodes.ts`). Cover:
  - token and request admission, unique relay names, rename, revocation with name reservation, presence;
  - stream flow control under a large transfer;
  - transport fallback (direct down, so the relay is used);
  - mixed old and new peers reading `url` and `addresses`.
- **File sync path.** Syncthing uses the direct path when reachable and the relay tunnel when not. It falls back to public relays only when the tunnel is down, and returns to the tunnel once it's back.
- **Cluster suite.** Extend `test/cluster-sanity.test.ts` with a cluster whose members have no direct URL: join, replication, chat proxying and file sync.
- **Sharing invariance.**
  - Run the existing sharing suites twice: once over direct URLs, and once with every machine reachable only through a loopback relay. The results must be identical. The suites are:
    - `cluster-sharing-policy`, `cluster-sharing-membership` and `multi-cluster`;
    - `cluster-resource-policy`, `cluster-resource-adversarial` and `cluster-unseen-revocation`;
    - `cluster-twins` and `cluster-secret-destinations`;
    - `browser-profile-sharing` and `conversation-review-replication`.
  - Two machines on the same relay with no shared cluster or twin relationship can't fetch, replicate or proxy anything.
  - A request whose signature names a different machine than its channel is rejected.
  - A replicated user signing in through the gateway gets the same limited features as on a direct URL.
  - The relay node gets nothing from clusters it isn't a member of.
- **M1 regression.** Sign-in, chat sockets and the PWA on a direct URL behave exactly as before.
- **M2 gateway.**
  - Sign in through `<name>.<relay-domain>` on loopback with MFA, then open a proxied conversation.
  - A newly admitted machine has phone sign-in on.
  - A machine without MFA shows the set-up-MFA page instead of signing in.
  - Unknown, suspended and switched-off names get 404.
  - The real-client IP drives the rate limits.
- **UI.** Browser smoke tests for the Relay tab and the Relays section: lists paginate, the pairing code is visible on both sides, and the phone address can be copied.

## 10. Implementation notes

The code lives in `src/relay/` (protocol, Noise, streams, relay server, machine runtime, transport, Syncthing tunnels), `src/server/routes/relay.ts` (settings API) and `public/app/` (settings UI). Where it differs from the design above:

- **Addresses (4.5).** Relay addresses are not carried in the cluster protocol. A machine without a direct URL advertises `https://<node-id>.relay.invalid`, a name that never resolves, and peers find it through relay presence: each machine asks its relays to report the peers in its own cluster and twin records. Membership snapshots, twin records and invitations keep their single `url` field, so no protocol or schema change was needed and older peers are unaffected. A machine with a direct URL keeps advertising it and is reached through a shared relay only after a direct connection fails.
- **Invitation links (4.5).** A relay-only manager's link uses its `.relay.invalid` origin. The joiner must already be on a relay the manager uses; the link does not name the relay.
- **Channels (4.2–4.3).** Each channel carries one byte stream with its own Noise handshake, and HTTP keep-alive reuses channels between requests. There is no second multiplexing layer inside an encrypted channel. The relay enforces each channel's flow-control window.
- **Call sites (4.4).** About 20 direct `fetch` and `WebSocket` calls reached peers; most peer traffic already went through `fetchPeer` and `runtimeFetch`. All of them now use `peerFetch` and `peerWebSocket`, which behave like `fetch` and `new WebSocket` and fall through to them for anything that is not a peer.
- **Static Noise keys (4.3).** The static X25519 key is generated per process and kept in memory only; every handshake proves it with a fresh Ed25519 signature, so nothing new is stored.
- **Relay choice (4.6, 4.8).** The per-cluster relay list and manual relay order were dropped: the relay that last carried a channel to each peer is stored in `relay_peer_routes` and tried first, and a relay that answers it cannot reach the peer hands the channel to the next relay that reports it.
- **Long-polling fallback (D1).** When a WebSocket to a relay fails to open twice in a row, the machine switches to long-polling (`src/relay/poll.ts`), which carries the same frames over plain HTTPS. One receive request is always held open by the relay until it has frames to deliver, so delivery is still pushed. Outgoing frames go in separate send requests, one at a time.
- **Machine channels reach only machine routes.** A peer channel reaches only `/api/cluster/v2/*`, `/api/health` and signed `/ws` sockets, so another machine on the same relay never sees this machine's UI or sign-in page.
- **QR codes (4.7).** `public/app/qr.js` is a small QR encoder written for this (byte mode, error correction level M, any version), so no library was added. Its output matches macOS CoreImage's generator module for module, and CoreImage decodes it at every version from 1 to 40.
- **Phone gateway (§6 M2).** The gateway refuses machine endpoints (`/api/cluster/v2/*`), first-run setup, update preparation and agent capability tokens. A phone sign-in without two-factor authentication is refused before a session is issued.

### Changes from the implementation review

Two independent reviews (security, and correctness and regressions) found these issues, all fixed with tests:

- **Peer identity.** Callers pass the node they mean to reach, and the transport routes by it. A URL only says where to find that node: a cluster member that copies another machine's URL cannot draw its traffic, and a relay-only URL must name the same node.
- **Phone gateway.**
  - A malformed answer from a machine (an invalid status code) gets a 502 instead of risking the relay process.
  - Cookies scoped to a `Domain` are dropped.
  - Phone sessions use a `__Host-` cookie that sibling machine names cannot set or shadow.
  - Phone sign-in has its own throttle buckets, per phone address and per account, so failures from the internet never lock the owner out of local or Tailscale sign-in.
  - A missing MFA setup and a wrong password get the same answer, so the gateway does not reveal correct passwords.
  - Phone channels have their own cap per machine and a per-address concurrency limit, so phones cannot starve machine traffic.
- **Admission.**
  - Pairing codes include a secret random nonce the machine chose and are computed by each side on its own, so a key cannot be ground to match someone else's code.
  - A pending request filed under another machine's node ID gives way to a token holder, and pending requests expire after 7 days.
  - A removed key stays out under any node ID.
- **Robustness.**
  - A channel whose peer closes while data waits for credit now finishes instead of hanging.
  - Machines detect a silently dead relay link.
  - A black-holed direct address is detected with a 3-second TCP probe before requests wait out their timeouts.
  - WebSocket failures also switch a peer to its relay.
  - Long-polling keeps a closed session until its last frames, such as a refusal, are collected.
  - Machines that stop reading are cut off at 8 MB of queued data.
  - Unauthenticated connections are capped per address, and bodies stay small until a machine authenticates.
  - Signed requests on the four endpoints that verify their own signature must also match the channel's machine.
  - Changes to clusters, twins and file shares re-plan Syncthing tunnels and presence watching.
- **Permission changes reach open connections** (from a later review of automatic relay choice, phone access and the owner switches):
  - Turning off other users' phone sign-in closes their open phone sockets at once, not only their next request.
  - Removing a twin disconnects it from a relay that serves only its owner's machines.
  - Machines ignore presence reports about peers they never asked about, so a relay cannot add phone addresses or routes.

### Tests

- `test/relay-noise.test.ts`: the cacophony and snow vectors for `Noise_XX_25519_ChaChaPoly_SHA256`, byte for byte, and tampering, ordering and size checks.
- `test/relay-transport.test.ts`: a relay and several machines in one process. It covers tokens, unique names, access requests and pairing codes, ciphertext-only routing, flow control under a 2.5 MB response, unpinned peers, the phone gateway, revocation and name reservation, fallback from a dead direct URL, a Syncthing tunnel, and long-polling in both directions.
- `test/relay-sharing-rules.test.ts`: channel identity must match the request signature, machine requests are refused on the gateway, agent tokens are refused through relays, and through the real app a machine channel reaches only machine routes while the gateway reaches only the UI.
- `test/relay-cluster.test.ts`: real nodes. Three relay-only machines and a relay run the `multi-cluster` isolation checks; the relay machine gets nothing; live node-to-node calls go through the relay; the phone gateway enforces MFA and the per-relay switch.
- `test/qr-code.test.ts`: QR codes match matrices produced by CoreImage, pick the smallest version, and carry version information from version 7.
- `test/ui/ui-relay.test.ts`: the Relay tab and the Relays section in a browser, including the QR code for a phone address.
