import type { ShareKind } from "./types.js";

/* The built-in ignore rules, ported line by line from Syncthing's managed lists (src/syncthing.ts
   projectIgnorePatterns and the worktree construction over src/worktree-filters.ts). Patterns keep
   Syncthing syntax so the same table can still be written into a node's .stignore while projects
   move engines. Order matters only for that Syncthing list: the engine decides by class (ignore.ts). */

/** `local` is never synced and never deleted for a peer; `regenerable` goes with its directory. */
export type RuleClass = "local" | "regenerable";

export type RuleGroup =
  | "sync-internal" | "secrets" | "local-state" | "dependencies" | "build-output" | "test-output" | "tool-caches"
  | "scratch" | "agent-state" | "logs" | "temporary" | "sqlite"
  | "worktree-heavy" | "worktree-linked" | "worktree-merge" | "worktree-binaries";

export interface BuiltinRule {
  /** The pattern without "(?d)": what `disabledBuiltins` names. */
  id: string;
  /** Syncthing syntax as written to .stignore. */
  pattern: string;
  /** "(?d)" lines are regenerable, every other line is local. */
  class: RuleClass;
  group: RuleGroup;
  /** Cannot be switched off: the engine or Syncthing would sync its own bookkeeping. */
  locked?: true;
  /** Share kinds the rule applies to; every kind when absent. */
  kinds?: readonly ShareKind[];
  /** Not part of Syncthing's managed list (Syncthing already skips these names itself). */
  engineOnly?: true;
}

/** Bump when a rule changes meaning without its pattern changing; pattern changes already move rulesHash. */
export const BUILTIN_RULES_VERSION = 1;

export const RULE_GROUPS: ReadonlyArray<{ id: RuleGroup; label: string }> = [
  { id: "sync-internal", label: "Sync and Joint Bob internals" },
  { id: "secrets", label: "Secrets" },
  { id: "local-state", label: "Node-local app state" },
  { id: "dependencies", label: "Installed dependencies" },
  { id: "build-output", label: "Build output" },
  { id: "test-output", label: "Test output" },
  { id: "tool-caches", label: "Tool caches" },
  { id: "scratch", label: "Scratch directories" },
  { id: "agent-state", label: "Agent runtime state" },
  { id: "logs", label: "Logs" },
  { id: "temporary", label: "Half-written files" },
  { id: "sqlite", label: "SQLite side files" },
  { id: "worktree-heavy", label: "Worktrees: dependency, build and cache trees" },
  { id: "worktree-linked", label: "Worktrees: linked dependency folders" },
  { id: "worktree-merge", label: "Worktrees: merge journal" },
  { id: "worktree-binaries", label: "Worktrees: binary files" },
];

const DELETABLE = "(?d)";
const WORKTREES: readonly ShareKind[] = ["worktrees"];

function withoutDeletable(pattern: string): string { return pattern.startsWith(DELETABLE) ? pattern.slice(DELETABLE.length) : pattern; }

function rules(group: RuleGroup, patterns: readonly string[], extra: Partial<Pick<BuiltinRule, "locked" | "kinds" | "engineOnly">> = {}): BuiltinRule[] {
  return patterns.map((pattern) => ({ id: withoutDeletable(pattern), pattern, class: pattern.startsWith(DELETABLE) ? "regenerable" : "local", group, ...extra }));
}

/* Every line of projectIgnorePatterns, in its order. The comments there explain each addition; the
   ones that matter for classification are repeated here. */
const projectRules: BuiltinRule[] = [
  // D10: .git stays node-local; git-catch-up moves HEAD.
  ...rules("sync-internal", [".git", ".git/**", "**/.git", "**/.git/**"], { locked: true }),
  ...rules("dependencies", [
    "(?d)node_modules/", "(?d)node_modules/**", "(?d)**/node_modules", "(?d)**/node_modules/**",
    "(?d).venv/", "(?d)venv/", "(?d)site-packages", "(?d)dist-packages", "(?d)__pypackages__", "(?d).tox", "(?d).nox", "(?d).eggs",
    "(?d)*.egg-info", "(?d).npm", "(?d).pnpm-store", "(?d).yarn/cache", "(?d).yarn/unplugged", "(?d).cache/pip", "(?d).cache/uv",
    "(?d).nuget", "(?d).gradle", "(?d).m2",
    "(?d)(?i)*.pyc", "(?d)(?i)*.pyo", "(?d)(?i)*.whl", "(?d)(?i)*.egg", "(?d)(?i)*.nupkg", "(?d)(?i)*.snupkg",
  ]),
  // Build output and Terraform provider binaries (hundreds of MB each).
  ...rules("build-output", ["(?d)dist/", "(?d)build/", "(?d).build", "(?d)target", "(?d).next", "(?d)DerivedData", "(?d).terraform", "(?d).nx/cache"]),
  ...rules("scratch", ["(?d)tmp", "(?d).tmp"]),
  // Agents' own worktrees are full copies of the repository.
  ...rules("agent-state", ["(?d).claude/worktrees", "(?d).pi/*worktrees"]),
  ...rules("test-output", ["(?d)coverage/", "(?d)test-results/", "(?d)**/test-results/", "(?d)playwright-report/", "(?d)**/playwright-report/"]),
  ...rules("tool-caches", [
    "(?d).pytest_cache/", "(?d)**/.pytest_cache/", "(?d).mypy_cache/", "(?d)**/.mypy_cache/", "(?d).ruff_cache/", "(?d)**/.ruff_cache/",
    "(?d)__pycache__/", "(?d).DS_Store",
  ]),
  // A dev node's secret.key lives under .dev-env; the outer directory decides, so it stays deletable.
  ...rules("scratch", ["(?d).dev-env/", "(?d)**/.dev-env/"]),
  // Test builds (.test-build-<hash>) and half-written files: worktree staging copies, atomic writes
  // (<name>.<uuid>.tmp), merge journal writes and rollbacks, and this engine's downloads.
  ...rules("sync-internal", ["(?d).test-build-*", "(?d).creating-*", "(?d)*.????????-????-????-????-????????????.tmp"], { locked: true }),
  ...rules("temporary", ["(?d)*.jb-merge-*.tmp", "(?d)*.jb-rollback-*.tmp"]),
  ...rules("sync-internal", ["(?d).joint-bob-sync.*.tmp"], { locked: true }),
  ...rules("secrets", [".env", ".env.*", "**/.env", "**/.env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", "id_ecdsa*"]),
  // App data and legacy branch-ticket worktrees beside a project: node-local, never shared.
  ...rules("sync-internal", [".joint-bob/", "**/.joint-bob/", ".joint-bob-worktrees"], { locked: true }),
  ...rules("local-state", [".pi-mobile-web/", "**/.pi-mobile-web/"]),
  ...rules("agent-state", [
    "(?d)aidlc/.aidlc-*", "(?d)**/aidlc/.aidlc-*", "(?d)aidlc/spaces/*/intents/.aidlc-*", "(?d)**/aidlc/spaces/*/intents/.aidlc-*",
    "(?d)aidlc/spaces/*/intents/*/.aidlc-*", "(?d)**/aidlc/spaces/*/intents/*/.aidlc-*",
  ]),
  ...rules("logs", ["(?d)logs/", "(?d)**/logs/", "(?d)*.log"]),
  ...rules("secrets", [".npmrc", ".pypirc", ".netrc", "credentials.json", "service-account*.json"]),
  ...rules("scratch", ["(?d)test_database_*.db", "(?d)**/test_database_*.db"]),
  // SQLite side files are only valid next to their open database.
  ...rules("sqlite", [
    "(?d)*.db-wal", "(?d)*.db-shm", "(?d)*.db-journal", "(?d)*.sqlite-wal", "(?d)*.sqlite-shm", "(?d)*.sqlite-journal",
    "(?d)*.sqlite3-wal", "(?d)*.sqlite3-shm", "(?d)*.sqlite3-journal",
  ]),
];

/* Syncthing's folder marker, ignore file and versions, and its temp files: Syncthing skips them on its
   own, but the engine runs beside it in shadow mode and must not index them either. */
const engineOnlyRules: BuiltinRule[] = [
  ...rules("sync-internal", [".stfolder", ".stignore", ".stversions", "(?d).syncthing.*.tmp", "(?d)~syncthing~*.tmp"], { locked: true, engineOnly: true }),
];

/* Copies of src/worktree-filters.ts (pure modules import nothing outside file-sync); a test keeps them equal. */
export const WORKTREE_HEAVY_DIRECTORIES = [
  "target", ".next", ".nuxt", ".svelte-kit", ".angular", ".turbo", ".cache", ".parcel-cache", ".vite", ".gradle", ".m2",
  "Pods", "DerivedData", ".tox", ".nox", ".eggs", "site-packages", "dist-packages", "__pypackages__", ".nuget", "vendor", "bower_components", "jspm_packages",
  ".yarn", ".pnpm-store", ".npm", ".terraform", ".serverless", ".vercel", ".netlify", ".expo", ".dart_tool",
  "out", "tmp", ".tmp", ".idea", ".stversions", ".stfolder",
] as const;
export const WORKTREE_LINKED_DIRECTORIES = [
  "node_modules", ".venv", "venv", "vendor", "bower_components", "jspm_packages", "Pods", ".yarn", ".pnpm-store",
  ".gradle", ".m2", ".dart_tool", ".terraform", ".tox", ".nox",
] as const;
export const WORKTREE_BINARY_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tif", "tiff", "heic", "psd", "ai", "sketch", "fig",
  "mp4", "mov", "avi", "mkv", "webm", "mp3", "wav", "flac", "ogg", "m4a", "aac",
  "zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "jar", "war", "class", "dex", "apk", "ipa", "aab",
  "so", "dylib", "dll", "exe", "bin", "o", "a", "lib", "obj", "pdb", "pyc", "pyo", "whl", "egg", "nupkg", "snupkg", "wasm", "node",
  "sqlite", "sqlite3", "db", "pdf", "woff", "woff2", "ttf", "otf", "eot", "dmg", "iso", "pkg", "deb", "rpm", "msi",
] as const;

/* Worktrees are disposable copies: on top of the project rules (all regenerable there), heavy trees,
   linked dependency folders (symlinks with absolute targets into the project, which must never
   travel), the merge journal and binaries stay out. A pattern the project rules already have is
   not repeated, exactly as Syncthing's Set dedup does. */
function worktreeOnlyRules(): BuiltinRule[] {
  const seen = new Set(projectRules.map((rule) => rule.class === "regenerable" ? rule.pattern : `${DELETABLE}${rule.pattern}`));
  const fresh = (pattern: string) => !seen.has(pattern) && Boolean(seen.add(pattern));
  const heavy: readonly string[] = WORKTREE_HEAVY_DIRECTORIES;
  const groups: Array<[RuleGroup, string[]]> = [
    // Syncthing's own folder files are engine-only rules below every kind.
    ["worktree-heavy", heavy.filter((name) => !name.startsWith(".st")).map((name) => `${DELETABLE}${name}`)],
    ["worktree-linked", WORKTREE_LINKED_DIRECTORIES.filter((name) => !heavy.includes(name)).map((name) => `${DELETABLE}${name}`)],
    ["worktree-merge", [`${DELETABLE}.joint-bob-merge`]],
    ["worktree-binaries", WORKTREE_BINARY_EXTENSIONS.map((extension) => `${DELETABLE}(?i)*.${extension}`)],
  ];
  return groups.flatMap(([group, patterns]) => rules(group, patterns.filter(fresh), { kinds: WORKTREES }));
}

export const BUILTIN_RULES: readonly BuiltinRule[] = Object.freeze([...projectRules, ...engineOnlyRules, ...worktreeOnlyRules()]);

const byId = new Map(BUILTIN_RULES.map((rule) => [rule.id, rule]));
if (byId.size !== BUILTIN_RULES.length) throw new Error("Built-in ignore rule ids must be unique");

export function builtinRule(id: string): BuiltinRule | undefined { return byId.get(id); }

export function builtinRulesFor(kind: ShareKind): BuiltinRule[] {
  return BUILTIN_RULES.filter((rule) => !rule.kinds || rule.kinds.includes(kind));
}

/** Syncthing's project/ticket folder list, identical to projectIgnorePatterns in src/syncthing.ts. */
export const SYNCTHING_PROJECT_PATTERNS: readonly string[] = projectRules.map((rule) => rule.pattern);

/** Syncthing's worktree folder list, identical to worktreeIgnorePatterns in src/syncthing.ts. */
export const SYNCTHING_WORKTREE_PATTERNS: readonly string[] = [...new Set([
  ...projectRules.map((rule) => rule.class === "regenerable" ? rule.pattern : `${DELETABLE}${rule.pattern}`),
  ...BUILTIN_RULES.filter((rule) => rule.kinds?.includes("worktrees") && !rule.engineOnly).map((rule) => rule.pattern),
])];

/* Names that always sync, whatever matches them: worktree metadata and baselines, attachments, conflict
   copies (so a conflict is visible on every node), and the ticket merge journal outside worktrees.
   Only the name itself is protected; content below it is classified normally. */
export function isNeverIgnored(name: string, kind: ShareKind): boolean {
  if (name.startsWith(".joint-bob-")) {
    if (name === ".joint-bob-worktree" || name === ".joint-bob-attachments" || name.startsWith(".joint-bob-baseline")) return true;
    if (name === ".joint-bob-merge") return kind !== "worktrees";
  }
  return name.includes(".sync-conflict-");
}
