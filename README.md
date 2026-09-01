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

The installer provides pinned versions of Node.js, Pi, Claude Code, and Syncthing. You do not need to install them first. Tailscale is optional.

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

Pairing exchanges cluster membership and project inventory. Joint Bob also creates shared `dot-pi` and `dot-claude` Syncthing folders for shareable engine configuration and sessions. Authentication files, credential-bearing settings, MCP authentication, OAuth locks, and daemon control keys remain node-local.

A cluster supports up to five active nodes. Remove an old node before adding a sixth.

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

Secret accounts stay node-local unless you explicitly replicate one. Use **Settings > Secrets > Sync to nodes** to send an account through encrypted cluster replication. Secrets never use filesystem synchronization.

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
