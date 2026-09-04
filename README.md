# Joint Bob

Joint Bob is a private web workspace for running Pi and Claude coding agents from a computer or phone. It can manage projects on one machine or synchronize projects and ticket workspaces across a small cluster with Syncthing.

Joint Bob runs as your OS user. Application files live in `~/.local/share/joint-bob/app`, and node-local state lives in `~/.joint-bob`.

Want an AI coding agent to perform the installation? Give it [agents_readme.md](agents_readme.md).

## Requirements

- macOS or Linux with `launchd` or user `systemd`
- An Intel/AMD 64-bit or ARM64 machine
- `curl`, `tar`, and internet access during installation
- A non-root user account
- Pi and Claude accounts if you want to use both agents
- Tailscale or another private HTTPS network for multi-node operation

The installer provides pinned versions of Node.js, Pi, Claude Code, and Syncthing. You do not need to install them first. Syncthing requires no account. Tailscale is optional and has its own account and installation if you choose to use it.

## Choose a setup

Pick the smallest setup that fits your use case:

| Setup | Tailscale | Access method | Cluster support |
| --- | --- | --- | --- |
| One local computer | No | `http://127.0.0.1:8787` | No |
| One remote computer or EC2 instance | No | SSH tunnel | No |
| One remote computer or EC2 instance | Yes | Tailscale Serve HTTPS | Optional later |
| Multiple computers, including EC2 | Yes | Tailscale Serve HTTPS on every node | Yes, recommended |
| Multiple computers without Tailscale | No | Your private network and trusted HTTPS reverse proxy on every node | Yes |
| Temporary EC2 smoke test | No | Operator-restricted self-signed HTTPS | Test only |

For one local node, install and use the local URL. For a remote node without Tailscale, keep port `8787` closed to the network and use an SSH tunnel. A cluster needs a stable HTTPS origin for every node and two-way network reachability between all nodes.

## Install a node

Run this as the user who will run Joint Bob. Do not use `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/iliagerman/joint-bob/main/scripts/install.sh | bash
```

The installer downloads the latest GitHub release, verifies its SHA-256 checksum, installs dependencies, starts Syncthing, and creates a native user service.

When installation finishes:

1. Open the local URL printed by the installer, normally `http://127.0.0.1:8787/`.
2. Create the administrator account in the browser.
3. Authenticate Pi and Claude as the same OS user that installed Joint Bob:

   ```bash
   ~/.local/share/joint-bob/app/node_modules/.bin/pi
   ~/.local/share/joint-bob/app/node_modules/.bin/claude
   ```

4. In Joint Bob, open **Settings > Projects** and choose a **Joint Bob home folder** before creating or importing projects.

If Joint Bob is installed on a remote machine, use Tailscale Serve as described below or open an SSH tunnel before creating the administrator:

```bash
ssh -L 8787:127.0.0.1:8787 <ssh-host>
```

Then open `http://127.0.0.1:8787/` on your computer.

### Linux startup before login

The installer warns if user lingering is disabled. Enable it if Joint Bob must start before you log in:

```bash
sudo loginctl enable-linger "$USER"
```

This is the only installation step that may need `sudo`.

## Upgrade or repair an installation

Run the same installation command again:

```bash
curl -fsSL https://raw.githubusercontent.com/iliagerman/joint-bob/main/scripts/install.sh | bash
```

The installer preserves projects, credentials, settings, tasks, cluster identity, and other state. It restores the previous installed copy if the replacement fails. Existing `~/.pi-mobile-web` state migrates automatically.

## Install on EC2 or another remote Linux host

For a persistent remote node, create a supported Linux host, connect over SSH as a non-root user, and run the normal installer there. On Ubuntu, the default `ubuntu` user is suitable.

```bash
ssh <user>@<host>
curl -fsSL https://raw.githubusercontent.com/iliagerman/joint-bob/main/scripts/install.sh | bash
sudo loginctl enable-linger "$USER"
```

Choose one access method:

- With Tailscale, install Tailscale on the remote host and use Tailscale Serve.
- Without Tailscale, use an SSH tunnel for a single node.
- For a cluster without Tailscale, put every node behind a trusted HTTPS reverse proxy on a private network.

Do not expose Joint Bob's plain HTTP port `8787` to the internet. The repository's `deploy/aws-ec2-test` Terraform is an ephemeral smoke-test environment, not a persistent EC2 deployment. See **EC2 smoke test** below.

## Private access with Tailscale

Install Tailscale, sign the machine into your tailnet, then run:

```bash
~/.local/share/joint-bob/app/scripts/serve-https.sh
```

If Joint Bob uses a custom local port or Tailscale should use another supported HTTPS port, pass both values:

```bash
PORT='<joint-bob-port>' HTTPS_PORT='<443|8443|10000>' ~/.local/share/joint-bob/app/scripts/serve-https.sh
```

Open the HTTPS URL shown by `tailscale serve status`. The default HTTPS port is `8443`. Tailscale Serve keeps Joint Bob inside your tailnet. The script does not enable Tailscale Funnel.

Useful commands:

```bash
tailscale serve status
tailscale serve --https=8443 off
tailscale serve reset
```

Use the private HTTPS URL for phone access and cluster pairing. Do not pair nodes over public HTTP.

## Private access without Tailscale

A single remote node can stay bound to its local service port and be reached through SSH:

```bash
ssh -L 8787:127.0.0.1:8787 <ssh-host>
```

For multiple nodes without Tailscale, provide each node with a stable HTTPS origin such as `https://bob-node-1.internal.example`. Every node must be able to reach every other node at its configured origin. Certificates must be trusted by the browsers and Node.js runtimes that connect to them. Each reverse proxy must forward HTTP, WebSocket upgrades, the original `Host`, and HTTPS origin information to `http://127.0.0.1:8787`.

Cluster URLs must be HTTPS origins with no path, query, username, or password. Loopback HTTP is accepted for local use only. Do not use self-signed certificates for a persistent cluster unless every connecting browser and Node.js runtime explicitly trusts your private certificate authority.

## Add another node

Install Joint Bob and configure private HTTPS on the new machine first. Tailscale Serve is the easiest option, but any mutually reachable trusted HTTPS origin works. Then:

1. On an existing node, open **Settings > Cluster**.
2. Select **Generate one-time link** and copy the link.
3. Open the new node and create its administrator.
4. On the new node, open **Settings > Cluster**.
5. Set the node name and its private HTTPS origin, either its Tailscale Serve URL or its trusted private reverse-proxy URL.
6. Paste the link under **Join an existing cluster**, then select **Join cluster**.
7. On every node, open **Settings > Projects** and select a **Joint Bob home folder**.

A join link works once. Creating another link invalidates the previous unused link from that node. Generate one link per new node and keep it inside the private cluster network.

Pairing exchanges cluster membership, project inventory, Joint Bob machine credentials, and Syncthing device IDs. Joint Bob then adds each paired device and managed folder to the local Syncthing configuration. A cluster supports up to five active nodes. Remove an old node before adding a sixth.

### How synchronization works

Syncthing is a companion process, not code embedded in the Joint Bob server and not a hosted Joint Bob service. The installer supplies a checksum-verified Syncthing binary. It can adopt a compatible running daemon; otherwise it starts `joint-bob-syncthing.service` on Linux or `com.joint-bob.syncthing` on macOS. Joint Bob discovers the daemon's local API key and controls it through Syncthing's loopback REST API. The API endpoint must stay on a loopback address.

Syncthing has no user accounts. Each node has a cryptographic device ID. Joint Bob exchanges those IDs through the one-time cluster pairing flow, so users do not need to open the Syncthing GUI, create an account, or configure device and folder sharing by hand. File transport uses Syncthing's encrypted device-to-device protocol. Depending on network reachability, Syncthing may connect directly or through its configured discovery and relay services.

Joint Bob and Syncthing have separate jobs:

- Joint Bob's authenticated HTTPS API exchanges cluster membership, project inventory, task state, and other application events.
- Syncthing transfers managed project files, the shared ticket-workspace tree, and dedicated Pi and Claude conversation-transcript folders.
- Each node keeps its own `~/.joint-bob/node.db`. Joint Bob never synchronizes the SQLite database as a file.
- Pi and Claude configuration, authentication files, OAuth state, MCP authentication, and daemon control keys remain node-local. Joint Bob syncs transcript roots instead of the complete engine directories and pauses legacy `dot-pi` and `dot-claude` folders if they exist.
- Secret accounts remain node-local unless a user selects **Settings > Secrets > Sync to nodes**. That encrypted replication uses the Joint Bob cluster API, not Syncthing.

Users still install Joint Bob on every node, create a local Joint Bob administrator on every node, configure mutually reachable private HTTPS origins, choose a Joint Bob home folder, and pair nodes with a one-time link. Pi and Claude authentication is separate and must be completed on every node that will run that engine. Tailscale authentication is required only when Tailscale provides the private network.

## Projects and ticket workspaces

The **Joint Bob home folder** controls where new projects and board-card workspaces are stored on each node:

```text
<home>/<workspace>/<project-name>
<home>/tickets/<project-id>/<ticket-id>
```

A workspace is a folder directly under the home folder. Joint Bob creates `personal` and `work` workspaces by default. Add more under **Settings > Projects > Workspaces**.

Projects created through the UI synchronize through per-project Syncthing folders. To import an existing project, choose its source folder and one of these modes:

- **Move into Joint Bob and leave a symlink** keeps the old path working.
- **Move into Joint Bob** removes the old path.
- **Copy into Joint Bob** leaves the original folder unchanged.

Joint Bob copies or moves the complete local folder, including `.git`, `node_modules`, and hidden files. `.git`, `node_modules`, build output, environment files, credentials, and logs are excluded from Syncthing at every depth.

Ticket agents work in the synchronized `<home>/tickets` folder. Handoff waits for the destination node to report that the workspace is synchronized. Archiving a ticket moves it to Done and removes its workspace. Deleting a ticket removes its workspace and task record.

Existing Git-backed tickets keep their worktree and merge behavior. New tickets do not create a branch and do not show **Merge to main**.

## Secret accounts

Secret accounts hold named environment variables encrypted with the node key. Attach an account to a workspace, project, or conversation. More specific scopes override less specific scopes one variable at a time.

Secret accounts stay node-local unless you explicitly replicate one. Use **Settings > Secrets > Sync to nodes** to send an account through encrypted cluster replication. Workspace attachments follow the account when the destination has the same workspace. Secrets never use filesystem synchronization.

## Service management

Linux:

```bash
systemctl --user status joint-bob.service
systemctl --user restart joint-bob.service
journalctl --user -u joint-bob.service -f
```

macOS:

```bash
launchctl print gui/$(id -u)/com.joint-bob.node
launchctl kickstart -k gui/$(id -u)/com.joint-bob.node
```

Node-specific ports, model aliases, credentials, proxy URLs, and executable overrides belong in `~/.joint-bob/env`. Restart the service after changing that file.

## Development

From a source checkout:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm start
```

Development uses `http://localhost:8790` unless `PORT` is set. Production services always run from `~/.local/share/joint-bob/app`, not from a source checkout.

### Add a harness adapter

Joint Bob discovers harness adapters from its own `src/harnesses` directory at startup. Source runs load `*.harness.ts`; compiled builds load `*.harness.js`. The loader sorts adapters by `order`, then filename. It rejects malformed exports and duplicate IDs. The path resolver rejects a session path when no adapter owns it or several adapters claim it. Files outside the application directory are never loaded as adapters.

Create `src/harnesses/<id>.harness.ts` with one default export. Use `src/harnesses/pi.harness.ts` and `src/harnesses/claude.harness.ts` as working examples. The function names in this outline stand for implementations defined earlier in the same file.

```ts
import { defineHarness } from "./contract.js";

export default defineHarness({
  id: "kiro",
  label: "Kiro",
  order: 30,
  paths: {
    newSession: "kiro:new",
    ownsSession: (sessionPath) => sessionPath.startsWith("kiro:"),
    ownsTranscript: (filePath) => filePath.endsWith(".jsonl") && isKiroTranscript(filePath),
  },
  sessions: {
    files: listKiroSessionFiles,
    list: listKiroSessions,
    refresh: refreshKiroSessions,
    loadMessages: loadKiroMessages,
  },
});
```

The adapter fields have these jobs:

- `id` is a lowercase identifier matching `[a-z][a-z0-9-]*`.
- `label` is the name shown in the UI.
- `order` controls display and discovery order. It is optional.
- `paths.newSession` is the path used for a new conversation.
- `paths.ownsSession` must claim only this adapter's session paths. Every path must have exactly one owner.
- `paths.ownsTranscript` limits refreshes to this adapter's transcript files.
- `sessions.files` returns transcript files for change detection.
- `sessions.list` reads the project's sessions.
- `sessions.refresh` updates a previous list after transcript files change.
- `sessions.loadMessages` reads one transcript into Joint Bob chat messages.

Keep path checks inside the adapter and restrict transcript ownership to the harness's known data directory. Do not read adapter code or configuration from `~/.joint-bob`.

Add registry and session tests in `test/harness-registry.test.ts`, then run:

```bash
npm run typecheck
npm test
npm run build
```

This adapter contract currently covers discovery, session listing, refreshes, and transcript loading. Interactive prompts and task execution still use the built-in Pi and Claude runtimes. A new harness needs runtime integration in the server before users can run it.

### Disposable nodes with dummy data

For UI and cluster work, run throwaway nodes instead of your real one:

```bash
npm run dev:local            # one node on http://127.0.0.1:8791
npm run dev:cluster          # two paired nodes on :8791 and :8792
just dev                     # same as dev:local
just dev-cluster             # same as dev:cluster
npm run dev:seed -- --force  # rebuild the dummy data from scratch
just dev-reset               # same thing, two nodes
```

Everything lives under `.dev-env/` in the checkout: one SQLite database per node, a shared `HOME`, three dummy projects, and dummy Pi and Claude transcripts. It never reads or writes `~/.joint-bob`, `~/.pi`, or `~/.claude`, so an installed node on this machine keeps running untouched — which is why the dev nodes default to ports 8791 and 8792 rather than 8790.

In cluster mode the two nodes are paired before they start, and every project is aliased to its twin, so pairing, project inventory, and conversation handover work without any manual setup.

Sign in with `dev` / `joint-bob-dev-password` (override with `JOINT_BOB_DEV_USERNAME` and `JOINT_BOB_DEV_PASSWORD`; the password must be at least 16 characters). Put the environment somewhere else with `JOINT_BOB_DEV_ROOT`. Reset it by deleting `.dev-env/`.

Two things the dev script configures that production does not:

- `JOINT_BOB_SESSION_COOKIE` gives each node its own session cookie name. Cookies ignore the port, so two nodes on `127.0.0.1` would otherwise sign each other out — including your installed node on 8790.
- `JOINT_BOB_INSECURE_COOKIE=1` drops the `Secure` flag, which browsers reject over plain HTTP. Never set it on a real node.

Dummy projects report their sync state as `Unavailable`: the dev nodes configure no Syncthing endpoint, which is correct for an isolated environment.

### Sanity suites

```bash
npm test          # the full suite, no browser needed
npm run test:ui   # browser journey against a seeded node (needs Chrome)
npm run test:all  # both
just test-ui      # same as npm run test:ui
```

`test/cluster-sanity.test.ts` runs inside `npm test`: it starts both paired nodes and checks pairing, shared project inventory, project aliasing, live node-to-node traffic, and conversation handover.

`test/ui/ui-smoke.test.ts` drives a real Chrome through sign-in, the project list, a conversation transcript, and the canvas picker, and fails on any console error or failed request. It uses `playwright-core` against your installed Chrome, so there is no browser download. It sits outside the `test/*.test.ts` glob on purpose: a browser suite that silently skips itself would report success while testing nothing.

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes.

## Maintainer deployment

Set the SSH target for the second installed node and install the repository hooks:

```bash
printf 'JOINT_BOB_DEPLOY_SSH_TARGET=%q\n' '<your-ssh-host>' >> ~/.joint-bob/env
scripts/install-git-hooks.sh
```

Install `just` if needed, then deploy the checked-out commit:

```bash
just update-local       # this Mac only
just update-homeserver  # configured SSH node only
just update             # both nodes
```

Each deployment creates a mode-`0600` SQLite backup before replacing an installed copy and verifies the reported release. Deployment logs are written to `~/.joint-bob/logs/push-deploy.log`.

For staged application changes, the `pre-commit` hook asks Claude Haiku to add an entry under `## Unreleased`. On a push to `main`, the `pre-push` hook reviews the pushed commit range, writes release notes, bumps the version, and stops the first push so the release files can be committed. The next push waits for the remote to confirm the exact commit, then deploys it. Pushes without application changes do not deploy.

## EC2 smoke test

`deploy/aws-ec2-test` provisions an isolated Ubuntu EC2 instance with encrypted storage and IMDSv2. It restricts inbound SSH and application access to one operator `/32`.

```bash
AWS_PROFILE=sela AWS_REGION=us-west-2 KEEP_INSTANCE=1 scripts/ec2-smoke-test.sh
```

The runner uploads the unpublished working tree through EC2 Instance Connect, installs Joint Bob, verifies first-run setup and persistence, and prints the destroy command. Public-IP access is only for temporary smoke testing. Never send pairing tokens over it. Destroy the environment after testing.

## Security and data

- Run Joint Bob as a non-root user.
- Use private networking such as Tailscale for remote access.
- Authentication uses SQLite-backed sessions.
- Machine, secret-account, Syncthing, and push secrets are encrypted.
- Joint Bob-owned state stays in node-local SQLite under `~/.joint-bob`.
- Git repositories, Pi and Claude transcripts, worktrees, and Syncthing data remain filesystem-owned.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.
