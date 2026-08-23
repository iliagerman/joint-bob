# Joint Bob

## TL;DR

Install on macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/iliagerman/joint-bob/main/scripts/install.sh | bash
```

Open the URL printed by the installer and create the administrator. To use both agents, authenticate them as the same OS user:

```bash
~/.local/share/joint-bob/app/node_modules/.bin/pi
~/.local/share/joint-bob/app/node_modules/.bin/claude
```

For private phone access, install Tailscale and run:

```bash
~/.local/share/joint-bob/app/scripts/serve-https.sh
```

Add another node from **Settings → Nodes** using that node's private Tailscale URL and pairing token. Do not pair over public HTTP.

Joint Bob runs as `joint-bob.service` on Linux or `com.joint-bob.node` on macOS. Code lives in `~/.local/share/joint-bob/app`; state lives in `~/.joint-bob`.

## Install

The curl command downloads the latest GitHub release, verifies its SHA-256 checksum, and installs a native user service. It pins Node.js, Pi, Claude Code, and Syncthing. Existing projects, credentials, settings, tasks, and cluster identity are preserved during upgrades and prior-installation migration.

## Add another node

Install Joint Bob on the new machine, then:

1. Open the new node and create its administrator.
2. Open **Settings → Nodes** on the new node.
3. Set its name and private HTTPS URL, normally its Tailscale Serve URL.
4. Copy the new node's pairing token.
5. On an existing node, open **Settings → Nodes**.
6. Enter the new node URL and token, then choose **Save and add node**.
7. Configure **Settings → Projects → Automatic mapping root** on each node, or map imported projects when prompted.

Pairing is two-sided automatically. One successful pairing exchanges membership and project inventory. Do not pair nodes over plain public HTTP because pairing tokens are machine credentials.

A cluster supports five active nodes. Remove an old node before adding a sixth.

## Private HTTPS

Tailscale Serve keeps the app inside the tailnet:

```bash
npm run serve:https
```

Open the URL printed by Tailscale. Joint Bob does not enable Funnel.

## Service management

Linux:

```bash
sudo loginctl enable-linger "$USER"
systemctl --user status joint-bob
systemctl --user restart joint-bob
journalctl --user -u joint-bob -f
```

macOS:

```bash
launchctl print gui/$(id -u)/com.joint-bob.node
launchctl kickstart -k gui/$(id -u)/com.joint-bob.node
```

Runtime state is stored in `~/.joint-bob`. Existing `~/.pi-mobile-web` state migrates automatically. Node-local overrides belong in `~/.joint-bob/env`.

## Development and deployment

```bash
npm ci
npm run typecheck
npm test
npm run build
npm start
```

Development defaults to `http://localhost:8790`. Production services run from installed copies, not this checkout.

Set the SSH target for the second installed node, then install the versioned deployment hook in the main checkout:

```bash
printf 'JOINT_BOB_DEPLOY_SSH_TARGET=%q\n' '<your-ssh-host>' >> ~/.joint-bob/env
scripts/install-git-hooks.sh
```

Deploy the checked-out commit manually (`brew install just` on macOS if needed):

```bash
just update-local       # this Mac only
just update-homeserver  # configured SSH node only
just update             # both nodes
```

Every command creates a mode-`0600` SQLite backup before replacing an installed copy and verifies the reported release. Git has no native post-push hook, so Joint Bob's `pre-push` hook records a push to `main`, waits until the remote confirms the exact commit, then runs the equivalent of `just update`. Deployment logs are written to `~/.joint-bob/logs/push-deploy.log`.

## EC2 smoke test

`deploy/aws-ec2-test` provisions an isolated Ubuntu EC2 instance with a public IPv4 address. Inbound SSH and application access are restricted to one operator `/32`; storage is encrypted and IMDSv2 is required.

The test runner uploads the unpublished working tree through EC2 Instance Connect, installs Joint Bob, verifies first-run setup and persistence, and prints the destroy command:

```bash
AWS_PROFILE=sela AWS_REGION=us-west-2 KEEP_INSTANCE=1 scripts/ec2-smoke-test.sh
```

Public-IP access is for temporary smoke testing only. Do not send pairing tokens over it. Destroy the environment after testing using the command printed by the runner.

## Security and data

- Run Joint Bob as a non-root user.
- Prefer private networking such as Tailscale.
- Authentication uses secure, SQLite-backed sessions.
- Machine, GitHub, Syncthing, and push secrets are encrypted.
- Joint Bob-owned state stays in node-local SQLite.
- Git repositories, Pi and Claude transcripts, worktrees, and Syncthing data remain filesystem-owned.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.
