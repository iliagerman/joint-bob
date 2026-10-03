import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type GitProtocol = "ssh" | "https";
type Kind = "value" | "file";
type Variable = { name: string; kind: Kind; value: string };

export const GITHUB_TOKEN_VARIABLE = "GH_TOKEN";
const SSH_KEY = "GITHUB_SSH_KEY";
const PUBLIC_KEY = "GITHUB_SSH_PUBLIC_KEY";
const SSH_HOST = "GITHUB_SSH_HOST";
const OWNERS = "GITHUB_OWNERS";
const PROTOCOL = "GITHUB_GIT_PROTOCOL";
const GITHUB_VARIABLES: Record<string, Kind> = { [GITHUB_TOKEN_VARIABLE]: "value", [SSH_KEY]: "file", [PUBLIC_KEY]: "value", [SSH_HOST]: "value", [OWNERS]: "value", [PROTOCOL]: "value" };

// Pinned from https://api.github.com/meta so a first connection never trusts an unknown host.
const GITHUB_HOST_KEYS = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
];
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface GithubAccount { id: string; label: string; token?: string; sshKey?: string; publicKey?: string; sshHost: string; owners: string[]; protocol: GitProtocol }
export interface GithubAccountSummary { sshHost: string; owners: string[]; protocol: GitProtocol; hasToken: boolean; hasSshKey: boolean; publicKey?: string; fingerprint?: string }

export function assertGithubVariableNames(variables: Array<{ name: string; kind: Kind }>): void {
  for (const variable of variables) {
    if (GITHUB_VARIABLES[variable.name] !== variable.kind) throw new Error(`GitHub secret accounts hold only a ${GITHUB_TOKEN_VARIABLE} value and SSH key settings`);
  }
}

function parseOwners(value: string | undefined): string[] {
  const owners = (value ?? "").split(/[\s,]+/).filter(Boolean);
  for (const owner of owners) if (!OWNER_PATTERN.test(owner)) throw new Error(`GitHub owner "${owner}" is invalid`);
  return [...new Set(owners)];
}

function normalizePrivateKey(value: string): string {
  const key = value.replace(/\r\n?/g, "\n").trim();
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----$/.test(key)) throw new Error("Paste the whole private SSH key, including its BEGIN and END lines");
  if (/ENCRYPTED/.test(key)) throw new Error("SSH keys protected by a passphrase cannot be used unattended. Use a key without a passphrase");
  return `${key}\n`;
}

function withPrivateDirectory<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jb-ssh-"));
  chmodSync(directory, 0o700);
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function sshKeygen(args: string[]): string {
  try { return execFileSync("ssh-keygen", args, { timeout: 15_000, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ssh-keygen is not installed on this machine, so SSH keys cannot be checked");
    throw new Error("The SSH key is invalid or protected by a passphrase. Use a key without a passphrase");
  }
}

function derivePublicKey(privateKey: string): string {
  return withPrivateDirectory((directory) => {
    const file = path.join(directory, "key");
    writeFileSync(file, privateKey, { mode: 0o600 });
    return sshKeygen(["-y", "-P", "", "-f", file]).trim();
  });
}

export function sshFingerprint(publicKey: string): string | undefined {
  const blob = publicKey.trim().split(/\s+/)[1];
  if (!blob) return undefined;
  return `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

export function generateSshKeyPair(comment: string): { privateKey: string; publicKey: string; fingerprint?: string } {
  return withPrivateDirectory((directory) => {
    const file = path.join(directory, "key");
    sshKeygen(["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file]);
    const publicKey = readFileSync(`${file}.pub`, "utf8").trim();
    return { privateKey: readFileSync(file, "utf8"), publicKey, fingerprint: sshFingerprint(publicKey) };
  });
}

/** Runs after edited values are merged with saved ones, so every rule sees the final account. */
export function finalizeGithubVariables(variables: Variable[]): Variable[] {
  const values = new Map(variables.map((variable) => [variable.name, variable.value.trim()]));
  const token = values.get(GITHUB_TOKEN_VARIABLE);
  const rawKey = variables.find((variable) => variable.name === SSH_KEY)?.value;
  if (!token && !rawKey?.trim()) throw new Error("GitHub accounts need an API token, an SSH key, or both");
  const sshKey = rawKey?.trim() ? normalizePrivateKey(rawKey) : undefined;
  const sshHost = values.get(SSH_HOST);
  if (sshHost && !HOST_PATTERN.test(sshHost)) throw new Error("SSH host alias may contain only letters, digits, dots, dashes and underscores");
  const owners = parseOwners(values.get(OWNERS));
  const protocol = values.get(PROTOCOL) || (sshKey ? "ssh" : "https");
  if (protocol !== "ssh" && protocol !== "https") throw new Error("Git access must be ssh or https");
  if (protocol === "ssh" && !sshKey) throw new Error("Git over SSH needs an SSH key");
  if (protocol === "https" && !token) throw new Error("Git over HTTPS needs an API token");
  const result: Variable[] = [];
  if (token) result.push({ name: GITHUB_TOKEN_VARIABLE, kind: "value", value: token });
  if (sshKey) result.push({ name: SSH_KEY, kind: "file", value: sshKey }, { name: PUBLIC_KEY, kind: "value", value: derivePublicKey(sshKey) });
  if (sshHost) result.push({ name: SSH_HOST, kind: "value", value: sshHost });
  if (owners.length) result.push({ name: OWNERS, kind: "value", value: owners.join(",") });
  // Stored only when it differs from the default, so a token-only account keeps its original shape.
  if (protocol !== (sshKey ? "ssh" : "https")) result.push({ name: PROTOCOL, kind: "value", value: protocol });
  return result;
}

export function githubAccount(id: string, label: string, variables: Variable[]): GithubAccount {
  const values = new Map(variables.map((variable) => [variable.name, variable.value]));
  const sshKey = values.get(SSH_KEY);
  const token = values.get(GITHUB_TOKEN_VARIABLE);
  const stored = values.get(PROTOCOL);
  const protocol: GitProtocol = stored === "ssh" && sshKey ? "ssh" : stored === "https" && token ? "https" : sshKey ? "ssh" : "https";
  return { id, label, token, sshKey, publicKey: values.get(PUBLIC_KEY), sshHost: values.get(SSH_HOST) || "github.com", owners: parseOwners(values.get(OWNERS)), protocol };
}

export function githubAccountSummary(account: GithubAccount): GithubAccountSummary {
  return { sshHost: account.sshHost, owners: account.owners, protocol: account.protocol, hasToken: Boolean(account.token), hasSshKey: Boolean(account.sshKey), ...(account.publicKey ? { publicKey: account.publicKey, fingerprint: sshFingerprint(account.publicKey) } : {}) };
}

/** Two attached accounts claiming the same SSH host or owner would make git's choice arbitrary. */
export function assertGithubAccountsDistinct(accounts: GithubAccount[]): void {
  const hosts = new Set<string>();
  const owners = new Set<string>();
  for (const account of accounts) {
    if (account.sshKey) {
      if (hosts.has(account.sshHost.toLowerCase())) throw new Error(`Selected GitHub accounts both use SSH host ${account.sshHost}`);
      hosts.add(account.sshHost.toLowerCase());
    }
    for (const owner of account.owners) {
      if (owners.has(owner.toLowerCase())) throw new Error(`Selected GitHub accounts both serve owner ${owner}`);
      owners.add(owner.toLowerCase());
    }
  }
}

export function githubOwnerFromRemote(remote: string): string | undefined {
  const scp = remote.trim().match(/^[^@\s/]+@[^:\s/]+:\/?([^/\s]+)\//);
  if (scp) return scp[1];
  try { return new URL(remote.trim()).pathname.split("/").filter(Boolean)[0]; } catch { return undefined; }
}

/** Accounts arrive narrowest first. An SSH alias names its account; otherwise the owner does. */
export function githubAccountFor(accounts: GithubAccount[], repository: { owner: string; host?: string }): GithubAccount | undefined {
  const host = repository.host?.toLowerCase();
  const owner = repository.owner.toLowerCase();
  return (host && host !== "github.com" ? accounts.find((account) => account.sshHost.toLowerCase() === host) : undefined)
    ?? accounts.find((account) => account.owners.some((item) => item.toLowerCase() === owner))
    ?? accounts.find((account) => account.token);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function writePrivate(file: string, content: string, mode = 0o600): string {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  return file;
}

const CREDENTIAL_HELPER = `#!/bin/sh
[ "$1" = get ] || exit 0
owner=
while IFS= read -r line; do
  case "$line" in path=*) owner=\${line#path=}; owner=\${owner%%/*} ;; esac
done
token=
if [ -n "$owner" ] && [ -n "$JOINT_BOB_GITHUB_TOKENS" ]; then
  token=$(awk -v owner="$(printf %s "$owner" | tr 'A-Z' 'a-z')" '$1 == owner { print $2; exit }' "$JOINT_BOB_GITHUB_TOKENS")
fi
[ -n "$token" ] || token=$PI_GITHUB_TOKEN
[ -n "$token" ] || exit 0
printf 'username=x-access-token\\npassword=%s\\n' "$token"
`;

/**
 * Accounts arrive narrowest first. Git picks the account from the remote: an SSH alias selects
 * its key through a generated ssh config, owner prefixes are rewritten to the account's chosen
 * protocol, and HTTPS asks a credential helper that returns the token for the URL's owner.
 */
export function applyGithubAccounts(values: NodeJS.ProcessEnv, accounts: GithubAccount[], options: { dataDir: string; repoOwner?: string; keyFile: (account: GithubAccount) => string }): void {
  if (!accounts.length) return;
  const tokens = accounts.filter((account) => account.token);
  const owner = options.repoOwner?.toLowerCase();
  const primary = (owner ? tokens.find((account) => account.owners.some((item) => item.toLowerCase() === owner)) : undefined) ?? tokens[0];
  if (primary) values.GH_TOKEN = primary.token;
  const digest = createHash("sha256").update(JSON.stringify(accounts.map(({ id, sshHost, owners, protocol }) => [id, sshHost, owners, protocol]))).digest("hex").slice(0, 16);
  const directory = path.join(options.dataDir, "github-git", digest);
  const config: Array<[string, string]> = [];
  const rewrites = new Set<string>();
  const rewrite = (target: string, prefix: string) => {
    if (rewrites.has(prefix)) return;
    rewrites.add(prefix);
    config.push([`url.${target}.insteadOf`, prefix]);
  };
  const keyed = accounts.filter((account) => account.sshKey);
  if (keyed.length) {
    const knownHosts = writePrivate(path.join(directory, "known_hosts"), GITHUB_HOST_KEYS.map((key) => `github.com ${key}`).join("\n") + "\n");
    const hosts = new Set<string>();
    const blocks = keyed.filter((account) => !hosts.has(account.sshHost.toLowerCase()) && hosts.add(account.sshHost.toLowerCase())).map((account) => [
      `Host ${account.sshHost}`, "  HostName github.com", "  User git", `  IdentityFile "${options.keyFile(account)}"`, "  IdentitiesOnly yes",
      `  UserKnownHostsFile "${knownHosts}"`, "  HostKeyAlias github.com", "  StrictHostKeyChecking yes", "",
    ].join("\n"));
    // Every other host keeps the user's own ssh settings.
    const sshConfig = writePrivate(path.join(directory, "ssh_config"), `${blocks.join("\n")}Match all\nInclude ~/.ssh/config\n`);
    values.GIT_SSH_COMMAND = `ssh -F ${quote(sshConfig)}`;
  }
  for (const account of accounts) {
    if (account.protocol === "ssh") {
      for (const item of account.owners) {
        const target = `git@${account.sshHost}:${item}/`;
        rewrite(target, `https://github.com/${item}/`);
        if (account.sshHost !== "github.com") { rewrite(target, `git@github.com:${item}/`); rewrite(target, `ssh://git@github.com/${item}/`); }
      }
    } else {
      for (const item of account.owners) { rewrite(`https://github.com/${item}/`, `git@github.com:${item}/`); rewrite(`https://github.com/${item}/`, `ssh://git@github.com/${item}/`); }
      if (account.sshHost !== "github.com") rewrite("https://github.com/", `git@${account.sshHost}:`);
    }
  }
  const routed = tokens.flatMap((account) => account.owners.map((item) => `${item.toLowerCase()} ${account.token}`));
  if (routed.length) {
    values.JOINT_BOB_GITHUB_TOKENS = writePrivate(path.join(directory, "tokens"), `${routed.join("\n")}\n`);
    const helper = writePrivate(path.join(options.dataDir, "github-credential-helper.sh"), CREDENTIAL_HELPER, 0o700);
    // The empty helper clears credential stores configured elsewhere, so the routed token wins.
    config.push(["credential.https://github.com.useHttpPath", "true"], ["credential.https://github.com.helper", ""], ["credential.https://github.com.helper", `!${quote(helper)}`]);
  }
  if (!config.length) return;
  values.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => { values[`GIT_CONFIG_KEY_${index}`] = key; values[`GIT_CONFIG_VALUE_${index}`] = value; });
}

export function githubAccountContext(account: GithubAccount): string {
  const parts = [account.token ? "API token (GH_TOKEN)" : "no API token: Pipelines, pull requests and gh need one", account.sshKey ? `SSH key ${sshFingerprint(account.publicKey ?? "") ?? ""} on host ${account.sshHost}`.trim() : "", `git over ${account.protocol === "ssh" ? "SSH" : "HTTPS"}`];
  const route = account.owners.length
    ? `repos owned by ${account.owners.join(", ")} use this account automatically; clone them as https://github.com/<owner>/<repo>.git and git routes them`
    : account.sshKey && account.sshHost !== "github.com" ? `remotes git@${account.sshHost}:<owner>/<repo>.git use this account` : "the default GitHub account for this project";
  return `${parts.filter(Boolean).join(", ")}; ${route}`;
}
