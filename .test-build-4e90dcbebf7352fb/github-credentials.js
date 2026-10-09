import { createHash, createPrivateKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const GITHUB_TOKEN_VARIABLE = "GH_TOKEN";
const SSH_KEY = "GITHUB_SSH_KEY";
const PUBLIC_KEY = "GITHUB_SSH_PUBLIC_KEY";
const SSH_HOST = "GITHUB_SSH_HOST";
const OWNERS = "GITHUB_OWNERS";
const PROTOCOL = "GITHUB_GIT_PROTOCOL";
const APP_ID = "GITHUB_APP_ID";
const INSTALLATION_ID = "GITHUB_APP_INSTALLATION_ID";
const APP_KEY = "GITHUB_APP_PRIVATE_KEY";
const GITHUB_VARIABLES = { [GITHUB_TOKEN_VARIABLE]: "value", [SSH_KEY]: "file", [PUBLIC_KEY]: "value", [SSH_HOST]: "value", [OWNERS]: "value", [PROTOCOL]: "value", [APP_ID]: "value", [INSTALLATION_ID]: "value", [APP_KEY]: "file" };
const GITHUB_HOST_KEYS = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk="
];
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
function assertGithubVariableNames(variables) {
  for (const variable of variables) {
    if (GITHUB_VARIABLES[variable.name] !== variable.kind) throw new Error(`GitHub secret accounts hold only a ${GITHUB_TOKEN_VARIABLE} value and SSH key settings`);
  }
}
function parseOwners(value) {
  const owners = (value ?? "").split(/[\s,]+/).filter(Boolean);
  for (const owner of owners) if (!OWNER_PATTERN.test(owner)) throw new Error(`GitHub owner "${owner}" is invalid`);
  return [...new Set(owners)];
}
function normalizePrivateKey(value) {
  const key = value.replace(/\r\n?/g, "\n").trim();
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----$/.test(key)) throw new Error("Paste the whole private SSH key, including its BEGIN and END lines");
  if (/ENCRYPTED/.test(key)) throw new Error("SSH keys protected by a passphrase cannot be used unattended. Use a key without a passphrase");
  return `${key}
`;
}
function withPrivateDirectory(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jb-ssh-"));
  chmodSync(directory, 448);
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function sshKeygen(args) {
  try {
    return execFileSync("ssh-keygen", args, { timeout: 15e3, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("ssh-keygen is not installed on this machine, so SSH keys cannot be checked");
    throw new Error("The SSH key is invalid or protected by a passphrase. Use a key without a passphrase");
  }
}
function derivePublicKey(privateKey) {
  return withPrivateDirectory((directory) => {
    const file = path.join(directory, "key");
    writeFileSync(file, privateKey, { mode: 384 });
    return sshKeygen(["-y", "-P", "", "-f", file]).trim();
  });
}
function sshFingerprint(publicKey) {
  const blob = publicKey.trim().split(/\s+/)[1];
  if (!blob) return void 0;
  return `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}
function generateSshKeyPair(comment) {
  return withPrivateDirectory((directory) => {
    const file = path.join(directory, "key");
    sshKeygen(["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file]);
    const publicKey = readFileSync(`${file}.pub`, "utf8").trim();
    return { privateKey: readFileSync(file, "utf8"), publicKey, fingerprint: sshFingerprint(publicKey) };
  });
}
function finalizeGithubVariables(variables) {
  const values = new Map(variables.map((variable) => [variable.name, variable.value.trim()]));
  const token = values.get(GITHUB_TOKEN_VARIABLE);
  const rawKey = variables.find((variable) => variable.name === SSH_KEY)?.value;
  const appId = values.get(APP_ID);
  const installationId = values.get(INSTALLATION_ID);
  const appKey = variables.find((variable) => variable.name === APP_KEY)?.value.trim();
  if (appId || installationId || appKey) {
    if (!appId || !installationId || !appKey) throw new Error("GitHub App needs an App ID, installation ID and private key");
    if (!/^[1-9]\d*$/.test(appId) || !/^[1-9]\d*$/.test(installationId)) throw new Error("GitHub App and installation IDs must be positive integers");
    try {
      if (createPrivateKey(appKey).asymmetricKeyType !== "rsa") throw new Error();
    } catch {
      throw new Error("GitHub App private key must be a valid RSA private key");
    }
    if (token) throw new Error("Choose either a GitHub App or an API token");
  }
  if (!token && !appKey && !rawKey?.trim()) throw new Error("GitHub accounts need an API token, a GitHub App, or an SSH key");
  const sshKey = rawKey?.trim() ? normalizePrivateKey(rawKey) : void 0;
  const sshHost = values.get(SSH_HOST);
  if (sshHost && !HOST_PATTERN.test(sshHost)) throw new Error("SSH host alias may contain only letters, digits, dots, dashes and underscores");
  const owners = parseOwners(values.get(OWNERS));
  const protocol = values.get(PROTOCOL) || (sshKey ? "ssh" : "https");
  if (protocol !== "ssh" && protocol !== "https") throw new Error("Git access must be ssh or https");
  if (protocol === "ssh" && !sshKey) throw new Error("Git over SSH needs an SSH key");
  if (protocol === "https" && !token && !appKey) throw new Error("Git over HTTPS needs an API token or GitHub App");
  const result = [];
  if (token) result.push({ name: GITHUB_TOKEN_VARIABLE, kind: "value", value: token });
  if (appId && installationId && appKey) result.push({ name: APP_ID, kind: "value", value: appId }, { name: INSTALLATION_ID, kind: "value", value: installationId }, { name: APP_KEY, kind: "file", value: `${appKey}
` });
  if (sshKey) result.push({ name: SSH_KEY, kind: "file", value: sshKey }, { name: PUBLIC_KEY, kind: "value", value: derivePublicKey(sshKey) });
  if (sshHost) result.push({ name: SSH_HOST, kind: "value", value: sshHost });
  if (owners.length) result.push({ name: OWNERS, kind: "value", value: owners.join(",") });
  if (protocol !== (sshKey ? "ssh" : "https")) result.push({ name: PROTOCOL, kind: "value", value: protocol });
  return result;
}
function githubAccount(id, label, variables) {
  const values = new Map(variables.map((variable) => [variable.name, variable.value]));
  const sshKey = values.get(SSH_KEY);
  const token = values.get(GITHUB_TOKEN_VARIABLE);
  const appId = values.get(APP_ID);
  const installationId = values.get(INSTALLATION_ID);
  const privateKey = values.get(APP_KEY);
  const app = appId && installationId && privateKey ? { appId, installationId, privateKey } : void 0;
  const stored = values.get(PROTOCOL);
  const protocol = stored === "ssh" && sshKey ? "ssh" : stored === "https" && (token || app) ? "https" : sshKey ? "ssh" : "https";
  return { id, label, token, app, sshKey, publicKey: values.get(PUBLIC_KEY), sshHost: values.get(SSH_HOST) || "github.com", owners: parseOwners(values.get(OWNERS)), protocol };
}
function githubAccountSummary(account) {
  return { sshHost: account.sshHost, owners: account.owners, protocol: account.protocol, hasToken: Boolean(account.token), hasApp: Boolean(account.app), ...account.app ? { appId: account.app.appId, installationId: account.app.installationId } : {}, hasSshKey: Boolean(account.sshKey), ...account.publicKey ? { publicKey: account.publicKey, fingerprint: sshFingerprint(account.publicKey) } : {} };
}
function assertGithubAccountsDistinct(accounts) {
  const hosts = /* @__PURE__ */ new Set();
  const owners = /* @__PURE__ */ new Set();
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
function githubOwnerFromRemote(remote) {
  const scp = remote.trim().match(/^[^@\s/]+@[^:\s/]+:\/?([^/\s]+)\//);
  if (scp) return scp[1];
  try {
    return new URL(remote.trim()).pathname.split("/").filter(Boolean)[0];
  } catch {
    return void 0;
  }
}
function githubAccountFor(accounts, repository) {
  const host = repository.host?.toLowerCase();
  const owner = repository.owner.toLowerCase();
  return (host && host !== "github.com" ? accounts.find((account) => account.sshHost.toLowerCase() === host) : void 0) ?? accounts.find((account) => account.owners.some((item) => item.toLowerCase() === owner)) ?? accounts.find((account) => account.token || account.app);
}
function quote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function writePrivate(file, content, mode = 384) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 448 });
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
function applyGithubAccounts(values, accounts, options) {
  if (!accounts.length) return;
  const tokens = accounts.filter((account) => account.token);
  const owner = options.repoOwner?.toLowerCase();
  const primary = (owner ? tokens.find((account) => account.owners.some((item) => item.toLowerCase() === owner)) : void 0) ?? tokens[0];
  if (primary) values.GH_TOKEN = primary.token;
  const digest = createHash("sha256").update(JSON.stringify(accounts.map(({ id, sshHost, owners, protocol }) => [id, sshHost, owners, protocol]))).digest("hex").slice(0, 16);
  const directory = path.join(options.dataDir, "github-git", digest);
  const config = [];
  const rewrites = /* @__PURE__ */ new Set();
  const rewrite = (target, prefix) => {
    if (rewrites.has(prefix)) return;
    rewrites.add(prefix);
    config.push([`url.${target}.insteadOf`, prefix]);
  };
  const keyed = accounts.filter((account) => account.sshKey);
  if (keyed.length) {
    const knownHosts = writePrivate(path.join(directory, "known_hosts"), GITHUB_HOST_KEYS.map((key) => `github.com ${key}`).join("\n") + "\n");
    const hosts = /* @__PURE__ */ new Set();
    const blocks = keyed.filter((account) => !hosts.has(account.sshHost.toLowerCase()) && hosts.add(account.sshHost.toLowerCase())).map((account) => [
      `Host ${account.sshHost}`,
      "  HostName github.com",
      "  User git",
      `  IdentityFile "${options.keyFile(account)}"`,
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile "${knownHosts}"`,
      "  HostKeyAlias github.com",
      "  StrictHostKeyChecking yes",
      ""
    ].join("\n"));
    const sshConfig = writePrivate(path.join(directory, "ssh_config"), `${blocks.join("\n")}Match all
Include ~/.ssh/config
`);
    values.GIT_SSH_COMMAND = `ssh -F ${quote(sshConfig)}`;
  }
  for (const account of accounts) {
    if (account.protocol === "ssh") {
      for (const item of account.owners) {
        const target = `git@${account.sshHost}:${item}/`;
        rewrite(target, `https://github.com/${item}/`);
        if (account.sshHost !== "github.com") {
          rewrite(target, `git@github.com:${item}/`);
          rewrite(target, `ssh://git@github.com/${item}/`);
        }
      }
    } else {
      for (const item of account.owners) {
        rewrite(`https://github.com/${item}/`, `git@github.com:${item}/`);
        rewrite(`https://github.com/${item}/`, `ssh://git@github.com/${item}/`);
      }
      if (account.sshHost !== "github.com") rewrite("https://github.com/", `git@${account.sshHost}:`);
    }
  }
  const routed = tokens.flatMap((account) => account.owners.map((item) => `${item.toLowerCase()} ${account.token}`));
  if (routed.length) {
    values.JOINT_BOB_GITHUB_TOKENS = writePrivate(path.join(directory, "tokens"), `${routed.join("\n")}
`);
    const helper = writePrivate(path.join(options.dataDir, "github-credential-helper.sh"), CREDENTIAL_HELPER, 448);
    config.push(["credential.https://github.com.useHttpPath", "true"], ["credential.https://github.com.helper", ""], ["credential.https://github.com.helper", `!${quote(helper)}`]);
  }
  if (!config.length) return;
  values.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => {
    values[`GIT_CONFIG_KEY_${index}`] = key;
    values[`GIT_CONFIG_VALUE_${index}`] = value;
  });
}
function githubAccountContext(account) {
  const parts = [account.app ? `GitHub App installation ${account.app.installationId}` : account.token ? "API token (GH_TOKEN)" : "no API token: Pipelines, pull requests and gh need one", account.sshKey ? `SSH key ${sshFingerprint(account.publicKey ?? "") ?? ""} on host ${account.sshHost}`.trim() : "", `git over ${account.protocol === "ssh" ? "SSH" : "HTTPS"}`];
  const route = account.owners.length ? `repos owned by ${account.owners.join(", ")} use this account automatically; clone them as https://github.com/<owner>/<repo>.git and git routes them` : account.sshKey && account.sshHost !== "github.com" ? `remotes git@${account.sshHost}:<owner>/<repo>.git use this account` : "the default GitHub account for this project";
  return `${parts.filter(Boolean).join(", ")}; ${route}`;
}
export {
  GITHUB_TOKEN_VARIABLE,
  applyGithubAccounts,
  assertGithubAccountsDistinct,
  assertGithubVariableNames,
  finalizeGithubVariables,
  generateSshKeyPair,
  githubAccount,
  githubAccountContext,
  githubAccountFor,
  githubAccountSummary,
  githubOwnerFromRemote,
  sshFingerprint
};
