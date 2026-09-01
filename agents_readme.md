# Joint Bob installation runbook for AI agents

Use this file when a human asks an AI agent to install or upgrade Joint Bob. Read [README.md](README.md) first. Keep the human in control of credentials, private URLs, cloud costs, and cluster membership.

## Goal

Choose one deployment route with the human, install Joint Bob as a native user service, verify it, and hand browser-only steps back to the human.

## Present the deployment options

Ask the human to choose one option before running commands:

1. **Local single node, no Tailscale.** Install on the current macOS or Linux computer and use `http://127.0.0.1:8787`.
2. **Remote or EC2 single node, no Tailscale.** Install over SSH and use an SSH tunnel. Keep Joint Bob's HTTP port private.
3. **Remote or EC2 single node with Tailscale.** Install over SSH, then configure Tailscale Serve for private HTTPS.
4. **Multiple nodes with Tailscale.** Install every node, configure Tailscale Serve on every node, then pair them. This is the recommended cluster route.
5. **Multiple nodes without Tailscale.** Use an existing private network and a trusted HTTPS reverse proxy for every node, then pair them.
6. **Temporary EC2 smoke test.** Use `scripts/ec2-smoke-test.sh` to provision, test, and destroy an isolated test instance. This is not a persistent deployment.

If the human wants a persistent EC2 node but has no instance yet, explain that this repository only contains Terraform for the temporary smoke test. Ask them to provide an existing supported Linux instance or separately approve and define persistent AWS infrastructure work.

## Ask the setup questions

Ask these shared questions together:

1. Which deployment option should you use?
2. Which machine or machines should receive Joint Bob? Is your agent session already on them, or should you connect over SSH?
3. Is each target a new installation, an upgrade, or a repair attempt?
4. For each new node, should Joint Bob use port `8787`? If not, ask for an unused port. Upgrades keep the port in `~/.joint-bob/env`.
5. Where should each node store managed projects? Ask for an absolute path, or let the human choose it later in **Settings > Projects**.

For remote or EC2 routes, also ask:

- What SSH host and OS user should you use?
- Is key-based SSH access ready?
- Should the service start before that user logs in?

For Tailscale routes, also ask:

- Is Tailscale installed and signed in on every target?
- Which tailnet HTTPS port should Tailscale Serve use: `8443`, `443`, or `10000`?

For a cluster without Tailscale, also ask:

- What stable HTTPS origin belongs to each node?
- Can every node reach every other origin?
- Which reverse proxy terminates TLS?
- Do browsers and Node.js on every node trust the certificate chain?
- Does the proxy support WebSocket upgrades?

For the EC2 smoke test, also ask:

- Which AWS profile and region should be used?
- May the script determine the operator's public IPv4 address and create billable temporary resources?
- Should the instance remain after the test with `KEEP_INSTANCE=1`, or be destroyed automatically?

Do not ask the human to paste passwords, API keys, OAuth tokens, cluster join links, private keys, or secret-account values into chat. Let the human enter secrets directly in browser and CLI prompts.

## Inspect each target

Run these checks on every installation target:

```bash
uname -s
uname -m
id -u
command -v curl
command -v tar
```

Continue only when:

- OS is `Darwin` or `Linux`.
- Architecture is `x86_64`, `amd64`, `arm64`, or `aarch64`.
- `id -u` does not return `0`.
- `curl` and `tar` exist.
- Linux has a working user `systemd` session. Verify with `systemctl --user show-environment`.

Inspect existing state without deleting or moving it:

```bash
test -f "$HOME/.local/share/joint-bob/app/.joint-bob-release" -o \
     -f "$HOME/.local/share/joint-bob/app/.master-bob-release" && echo "Joint Bob is already installed"
test -d "$HOME/.joint-bob" && echo "Joint Bob state exists"
grep '^PORT=' "$HOME/.joint-bob/env" 2>/dev/null || true
```

Existing installation and state are expected during upgrades.

## Install or upgrade each node

Default port or any upgrade:

```bash
curl -fsSL https://raw.githubusercontent.com/iliagerman/joint-bob/main/scripts/install.sh | bash
```

Custom port for a new installation:

```bash
curl -fsSL https://raw.githubusercontent.com/iliagerman/joint-bob/main/scripts/install.sh | PORT='<chosen-port>' bash
```

Validate a custom port as a decimal integer from `1` through `65535` before using it. Change an installed node's port only by editing `~/.joint-bob/env` and restarting the service.

Run the command on each target as its service user. Never use `sudo` for the installer. Do not bypass checksum verification, replace the release URL, edit files under the installed app, or delete `~/.joint-bob` to recover from an error.

The installer may report pending Pi or Claude authentication. That does not mean installation failed.

## Verify every node

Use each node's local port:

```bash
curl -fsS "http://127.0.0.1:<port>/api/health"
```

Linux:

```bash
systemctl --user status joint-bob.service --no-pager
```

macOS:

```bash
launchctl print "gui/$(id -u)/com.joint-bob.node"
```

If verification fails, collect the shortest relevant logs before proposing a fix.

Linux:

```bash
journalctl --user -u joint-bob.service -n 100 --no-pager
```

macOS:

```bash
tail -n 100 "$HOME/.joint-bob/logs/node.error.log"
tail -n 100 "$HOME/.joint-bob/logs/node.log"
```

On Linux, if startup before login is requested and lingering is disabled, explain the change and ask before running:

```bash
sudo loginctl enable-linger "$USER"
```

This is the only normal installation step that needs `sudo`.

## Complete option 1: local single node

Tell the human to open:

```text
http://127.0.0.1:<port>/
```

No Tailscale, reverse proxy, or cluster pairing is needed.

## Complete option 2: remote or EC2 single node without Tailscale

Keep the service port closed to untrusted networks. From the human's computer, open a tunnel:

```bash
ssh -L <local-port>:127.0.0.1:<node-port> <user>@<ssh-host>
```

Tell the human to open `http://127.0.0.1:<local-port>/`. The tunnel must remain open while they use Joint Bob. Do not pair this node into a cluster through the SSH tunnel.

## Complete option 3: remote or EC2 single node with Tailscale

Check Tailscale on the target:

```bash
command -v tailscale
tailscale status
```

If Tailscale is missing or signed out, stop for the human to install it or complete sign-in. Never enable Tailscale Funnel.

Run Tailscale Serve. Use environment variables only when the human chose non-default ports:

```bash
~/.local/share/joint-bob/app/scripts/serve-https.sh
```

Example with explicit ports:

```bash
PORT='<node-port>' HTTPS_PORT='<tailscale-port>' ~/.local/share/joint-bob/app/scripts/serve-https.sh
```

Read the private origin from `tailscale serve status` and confirm its health endpoint responds over HTTPS.

## Complete option 4: multiple nodes with Tailscale

For every node:

1. Finish installation and local verification.
2. Confirm Tailscale is signed in to a tailnet shared by all cluster nodes.
3. Configure Tailscale Serve.
4. Record the stable HTTPS origin without a path or query.
5. Verify every node can reach every other node's `/api/health` endpoint.

Do not start pairing until all nodes pass these checks.

## Complete option 5: multiple nodes without Tailscale

This route assumes the human already has private connectivity and trusted TLS. Joint Bob does not create that network or certificate authority.

For every node, verify:

- It has a stable HTTPS origin with no path, query, username, or password.
- Its reverse proxy sends traffic to `http://127.0.0.1:<node-port>`.
- Its proxy forwards WebSocket upgrades and the original `Host` and HTTPS origin information.
- Browsers and Node.js on every cluster node trust its certificate chain.
- Every node can reach every other node at the configured HTTPS origin.

Reject plain HTTP cluster origins except loopback addresses. Avoid self-signed leaf certificates. A private certificate authority is acceptable only when every browser and Node.js runtime involved trusts it.

Do not open port `8787` to the public internet. Stop and report missing network or TLS prerequisites rather than weakening transport security.

## Pair options 4 and 5

Pairing is a human-controlled browser step:

1. On an existing node, open **Settings > Cluster** and select **Generate one-time link**.
2. On the new node, open **Settings > Cluster**.
3. Set its node name and stable private HTTPS origin.
4. Have the human paste the link under **Join an existing cluster** and select **Join cluster**.
5. Repeat with a new one-time link for each additional node.
6. Confirm every node has a **Joint Bob home folder** under **Settings > Projects**.

Treat each one-time link as a secret. Do not print it in logs, shell history, or your completion report. A cluster supports five active nodes.

## Complete option 6: temporary EC2 smoke test

Run this route from a Joint Bob source checkout, not from the EC2 instance. Require `aws`, `curl`, `ssh`, `scp`, `ssh-keygen`, `tar`, and `terraform`.

Confirm AWS identity before creating resources:

```bash
AWS_PROFILE='<profile>' AWS_REGION='<region>' aws sts get-caller-identity
```

After explicit approval for cost and resource creation, run:

```bash
AWS_PROFILE='<profile>' AWS_REGION='<region>' scripts/ec2-smoke-test.sh
```

Keep the instance only when the human explicitly requests it:

```bash
AWS_PROFILE='<profile>' AWS_REGION='<region>' KEEP_INSTANCE=1 scripts/ec2-smoke-test.sh
```

The script creates an operator-restricted Ubuntu instance, installs the unpublished working tree, tests setup and persistence, and normally destroys the resources. With `KEEP_INSTANCE=1`, report the exact destroy command printed by the script. The smoke test uses a short-lived self-signed certificate and is not suitable for cluster pairing or persistent use.

Never substitute the smoke-test Terraform for a production EC2 design.

## Hand browser and authentication steps to the human

For options 1 through 5, ask the human to create the administrator in the browser. Do not create or choose the password for them.

Then ask them to authenticate Pi and Claude directly on each target as the same OS user that runs Joint Bob:

```bash
~/.local/share/joint-bob/app/node_modules/.bin/pi
~/.local/share/joint-bob/app/node_modules/.bin/claude
```

Interactive browser and terminal authentication belongs to the human. Continue after they confirm completion.

Ask them to open **Settings > Projects** and choose the **Joint Bob home folder** on every node. Do not move repositories by hand. Use Joint Bob's import flow.

## Completion report

Report:

- Chosen deployment option
- New install or upgrade for each node
- Target OS and architecture for each node
- Local URL and private HTTPS origin where applicable
- Service health and service name for each node
- Install path: `~/.local/share/joint-bob/app`
- State path: `~/.joint-bob`
- Human confirmation status for Pi and Claude authentication
- Home-folder and cluster-pairing steps still waiting for the human
- For a retained EC2 smoke instance, the destroy command and artifact directory

Never include credentials, cluster join links, secret values, private keys, or full private configuration files.
