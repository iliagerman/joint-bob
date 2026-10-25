import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  BUILTIN_RULES, builtinRule, SYNCTHING_PROJECT_PATTERNS, SYNCTHING_WORKTREE_PATTERNS,
  WORKTREE_BINARY_EXTENSIONS, WORKTREE_HEAVY_DIRECTORIES, WORKTREE_LINKED_DIRECTORIES,
} from "../src/file-sync/builtin-rules.js";
import {
  compileRules, effectiveRuleSettings, effectiveRules, GitignoreTree, hintPattern, parseGitignore, parseUserRules, rulesHash, userRulesFromSyncthingIgnores,
  type GitIgnoredPaths, type IgnoreClass, type IgnoreMatcher,
} from "../src/file-sync/ignore.js";
import type { ShareKind } from "../src/file-sync/types.js";
import { worktreeBinaryExtensions, worktreeHeavyDirectories, worktreeLinkedDirectories } from "../src/worktree-filters.js";

// Copied from test/syncthing.test.ts: Syncthing's managed project list, which the built-in table must reproduce.
const managedIgnorePatterns = [
  ".git", ".git/**", "**/.git", "**/.git/**", "(?d)node_modules/", "(?d)node_modules/**", "(?d)**/node_modules", "(?d)**/node_modules/**",
  "(?d).venv/", "(?d)venv/", "(?d)site-packages", "(?d)dist-packages", "(?d)__pypackages__", "(?d).tox", "(?d).nox", "(?d).eggs",
  "(?d)*.egg-info", "(?d).npm", "(?d).pnpm-store", "(?d).yarn/cache", "(?d).yarn/unplugged", "(?d).cache/pip", "(?d).cache/uv",
  "(?d).nuget", "(?d).gradle", "(?d).m2", "(?d)(?i)*.pyc", "(?d)(?i)*.pyo", "(?d)(?i)*.whl", "(?d)(?i)*.egg", "(?d)(?i)*.nupkg",
  "(?d)(?i)*.snupkg", "(?d)dist/", "(?d)build/", "(?d).build", "(?d)target", "(?d).next", "(?d)DerivedData", "(?d).terraform",
  "(?d).nx/cache", "(?d)tmp", "(?d).tmp", "(?d).claude/worktrees", "(?d).pi/*worktrees", "(?d)coverage/", "(?d)test-results/",
  "(?d)**/test-results/", "(?d)playwright-report/", "(?d)**/playwright-report/", "(?d).pytest_cache/", "(?d)**/.pytest_cache/",
  "(?d).mypy_cache/", "(?d)**/.mypy_cache/", "(?d).ruff_cache/", "(?d)**/.ruff_cache/", "(?d)__pycache__/", "(?d).DS_Store",
  "(?d).dev-env/", "(?d)**/.dev-env/", "(?d).test-build-*", "(?d).creating-*", "(?d)*.????????-????-????-????-????????????.tmp",
  "(?d)*.jb-merge-*.tmp", "(?d)*.jb-rollback-*.tmp", "(?d).joint-bob-sync.*.tmp", ".env", ".env.*", "**/.env", "**/.env.*", "*.pem",
  "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", "id_ecdsa*", ".joint-bob/", "**/.joint-bob/", ".joint-bob-worktrees",
  ".pi-mobile-web/", "**/.pi-mobile-web/", "(?d)aidlc/.aidlc-*", "(?d)**/aidlc/.aidlc-*", "(?d)aidlc/spaces/*/intents/.aidlc-*",
  "(?d)**/aidlc/spaces/*/intents/.aidlc-*", "(?d)aidlc/spaces/*/intents/*/.aidlc-*", "(?d)**/aidlc/spaces/*/intents/*/.aidlc-*",
  "(?d)logs/", "(?d)**/logs/", "(?d)*.log", ".npmrc", ".pypirc", ".netrc", "credentials.json", "service-account*.json",
  "(?d)test_database_*.db", "(?d)**/test_database_*.db", "(?d)*.db-wal", "(?d)*.db-shm", "(?d)*.db-journal", "(?d)*.sqlite-wal",
  "(?d)*.sqlite-shm", "(?d)*.sqlite-journal", "(?d)*.sqlite3-wal", "(?d)*.sqlite3-shm", "(?d)*.sqlite3-journal",
];

type Case = [path: string, isDirectory: boolean, expected: IgnoreClass | null];

function matcher(kind: ShareKind, project?: Parameters<typeof effectiveRules>[1], global?: Parameters<typeof effectiveRules>[2]): IgnoreMatcher {
  return compileRules(effectiveRules(kind, project, global));
}

function expectClasses(rules: IgnoreMatcher, cases: Case[], gitIgnored?: GitIgnoredPaths): void {
  for (const [file, isDirectory, expected] of cases) {
    const actual = rules.classify(file, isDirectory, gitIgnored);
    assert.equal(actual, expected, `${rules.rules.kind}: ${file}${isDirectory ? "/" : ""} classified ${actual}, expected ${expected}`);
  }
}

function everyPrefix(files: string[], prefixes: string[]): string[] {
  return prefixes.flatMap((prefix) => files.map((file) => prefix + file));
}

test("the built-in table reproduces Syncthing's managed project list line for line", () => {
  assert.deepEqual(SYNCTHING_PROJECT_PATTERNS, managedIgnorePatterns);
});

test("the worktree list is built from the project list exactly as Syncthing builds it", () => {
  const expected = [...new Set([
    ...managedIgnorePatterns.map((rule) => rule.startsWith("(?d)") ? rule : `(?d)${rule}`),
    ...worktreeHeavyDirectories.filter((name) => !name.startsWith(".st")).map((name) => `(?d)${name}`),
    ...worktreeLinkedDirectories.filter((name) => !(worktreeHeavyDirectories as readonly string[]).includes(name)).map((name) => `(?d)${name}`),
    "(?d).joint-bob-merge",
    ...worktreeBinaryExtensions.map((extension) => `(?d)(?i)*.${extension}`),
  ])];
  assert.deepEqual(SYNCTHING_WORKTREE_PATTERNS, expected);
});

test("the worktree lists are copies of src/worktree-filters.ts", () => {
  assert.deepEqual(WORKTREE_HEAVY_DIRECTORIES, worktreeHeavyDirectories);
  assert.deepEqual(WORKTREE_LINKED_DIRECTORIES, worktreeLinkedDirectories);
  assert.deepEqual(WORKTREE_BINARY_EXTENSIONS, worktreeBinaryExtensions);
});

test("every built-in rule takes its id and class from its pattern", () => {
  for (const rule of BUILTIN_RULES) {
    assert.equal(rule.id, rule.pattern.replace(/^\(\?d\)/, ""), `id of ${rule.pattern}`);
    assert.equal(rule.class, rule.pattern.startsWith("(?d)") ? "regenerable" : "local", `class of ${rule.pattern}`);
  }
  assert.equal(new Set(BUILTIN_RULES.map((rule) => rule.id)).size, BUILTIN_RULES.length, "ids are unique");
});

test("exactly the sync-internal rules are locked, and they cover git, app data, Syncthing files and half-written files", () => {
  const locked = BUILTIN_RULES.filter((rule) => rule.locked).map((rule) => rule.id);
  assert.deepEqual(BUILTIN_RULES.filter((rule) => rule.group === "sync-internal").map((rule) => rule.id), locked);
  for (const [id, ruleClass] of [
    [".git", "local"], [".joint-bob/", "local"], [".joint-bob-worktrees", "local"], [".stfolder", "local"], [".stignore", "local"], [".stversions", "local"],
    [".syncthing.*.tmp", "regenerable"], ["~syncthing~*.tmp", "regenerable"], [".creating-*", "regenerable"],
    ["*.????????-????-????-????-????????????.tmp", "regenerable"], [".joint-bob-sync.*.tmp", "regenerable"], [".test-build-*", "regenerable"],
  ] as const) {
    assert.equal(builtinRule(id)?.locked, true, `${id} is locked`);
    assert.equal(builtinRule(id)?.class, ruleClass, `${id} is ${ruleClass}`);
  }
});

const dependencies = [
  "node_modules/pkg/index.js", ".venv/lib/pkg.py", "venv/lib/pkg.py",
  "site-packages/pkg/__init__.py", "dist-packages/pkg/__init__.py", "__pypackages__/3.12/lib/pkg.py",
  ".tox/py/lib/pkg.py", ".nox/test/lib/pkg.py", ".eggs/pkg/index.py", "pkg.egg-info/PKG-INFO",
  ".npm/_cacache/content", ".pnpm-store/v3/content", ".yarn/cache/pkg.zip", ".yarn/unplugged/pkg/index.js",
  ".cache/pip/wheels/content", ".cache/uv/archive/content", ".nuget/packages/pkg/README.md",
  ".gradle/caches/content", ".m2/repository/pkg/content", "pkg.WHL", "pkg.egg", "pkg.pyc", "pkg.pyo",
  "pkg.NUPKG", "pkg.snupkg",
];
const sourceFiles = ["src/main.py", "packages/ui/index.ts", "bin/start.sh", "NuGet.Config", "packages.lock.json", "pyproject.toml", "uv.lock", "pnpm-lock.yaml"];

test("installed packages are excluded at every depth while source packages and lockfiles sync", () => {
  for (const kind of ["project", "worktrees"] as const) {
    const rules = matcher(kind);
    expectClasses(rules, everyPrefix(dependencies, ["", "nested/backend/"]).map((file) => [file, false, "regenerable"]));
    expectClasses(rules, everyPrefix(sourceFiles, ["", "nested/backend/"]).map((file) => [file, false, null]));
  }
});

test("package file extensions match case-insensitively", () => {
  expectClasses(matcher("project"), [["dist/PKG.WHL", false, "regenerable"], ["a/b/Mod.PyC", false, "regenerable"], ["lib.Nupkg", false, "regenerable"], ["notes.pycx", false, null]]);
});

const uuid = "0b9c6f1e-2d3a-4c5b-8e7f-a1b2c3d4e5f6";

test("half-written files and local branch worktrees stay out while conflict copies and shared metadata sync", () => {
  const halfWritten = [
    `.creating-${uuid}/README.md`, `worktree.json.${uuid}.tmp`, `.settings.json.${uuid}.tmp`, `.${uuid}.tmp`,
    `.notes.md.jb-merge-${uuid}.tmp`, `notes.md.jb-rollback-${uuid}.tmp`, ".joint-bob-sync.README.md.0123456789abcdef.tmp",
    `.joint-bob-worktree/worktree.json.${uuid}.tmp`, ".joint-bob-worktrees/feature/README.md",
  ];
  const shared = [
    ".joint-bob-worktree/worktree.json", ".joint-bob-attachments/notes.txt", ".joint-bob-baseline/manifest.json",
    "notes.sync-conflict-20261006-173252-5CHB2CY.md", "plain.tmp", "foo.12345678.tmp", `abc-${uuid}.tmp`, `abc.${uuid}.tmpl`,
    `${uuid}.json`, "creating-notes.md", ".joint-bob-worktrees-old/README.md", "joint-bob-worktrees/README.md",
  ];
  for (const kind of ["project", "tickets", "worktrees"] as const) {
    const rules = matcher(kind);
    for (const file of everyPrefix(halfWritten, ["", "nested/deep/"])) assert.notEqual(rules.classify(file, false), null, `${kind}: ${file} must stay local`);
    expectClasses(rules, everyPrefix(shared, ["", "nested/deep/"]).map((file) => [file, false, null]));
  }
  assert.equal(matcher("project").classify(".joint-bob-worktrees", true), "local", "other machines' deletions never remove local branch worktrees");
});

test("Joint Bob's half-written file names are regenerable", () => {
  const names = [`.creating-${uuid}`, `x.${uuid}.tmp`, `.x.${uuid}.tmp`, `.x.jb-merge-${uuid}.tmp`, `x.jb-rollback-${uuid}.tmp`, ".joint-bob-sync.x.0123456789abcdef.tmp"];
  expectClasses(matcher("project"), everyPrefix(names, ["", "src/deep/"]).map((file) => [file, false, "regenerable"]));
  expectClasses(matcher("project"), [[`.creating-${uuid}`, true, "regenerable"], [`.creating-${uuid}/src/secret.key`, false, "regenerable"]]);
});

test("Syncthing's temp files are regenerable and its folder files local", () => {
  expectClasses(matcher("project"), [
    [".syncthing.notes.md.tmp", false, "regenerable"], ["src/.syncthing.main.ts.tmp", false, "regenerable"],
    ["~syncthing~notes.md.tmp", false, "regenerable"], ["src/~syncthing~main.ts.tmp", false, "regenerable"],
    [".stfolder", true, "local"], [".stignore", false, "local"], [".stversions/notes~20261006.md", false, "local"],
    ["syncthing.notes.md.tmp", false, null],
  ]);
});

test("AI-DLC runtime state is regenerable at every depth while other .aidlc names sync", () => {
  expectClasses(matcher("project"), [
    ["aidlc/.aidlc-state.json", false, "regenerable"], ["tools/aidlc/.aidlc-lock", false, "regenerable"],
    ["aidlc/spaces/main/intents/.aidlc-index", false, "regenerable"], ["x/aidlc/spaces/main/intents/feature/.aidlc-run", true, "regenerable"],
    [".aidlc-state.json", false, null], ["aidlc/spaces/main/.aidlc-index", false, null], ["aidlc/intents.md", false, null],
  ]);
});

test("a secret under .dev-env is regenerable because the outer directory decides (2026-10-12)", () => {
  expectClasses(matcher("project"), [
    [".dev-env/node-a/secret.key", false, "regenerable"], ["cluster/.dev-env/secret.key", false, "regenerable"],
    [".dev-env/.env", false, "regenerable"], [".dev-env", true, "regenerable"], ["secret.key", false, "local"],
  ]);
});

test("local beats regenerable when both match the same name", () => {
  expectClasses(matcher("project"), [[".env.log", false, "local"], ["id_rsa.log", false, "local"], [".env.db-wal", false, "local"]]);
});

test("an outer local directory keeps regenerable content local", () => {
  expectClasses(matcher("project"), [[".git/node_modules/x", false, "local"], [".joint-bob/logs/server.log", false, "local"], ["sub/.git/objects/pack/a.pack", false, "local"]]);
});

test("secrets are local in project and ticket shares", () => {
  const secrets = [".env", "api/.env.production", "certs/server.pem", "a/b.key", "store.p12", "store.pfx", "id_rsa", "home/id_ed25519.pub", "id_ecdsa",
    ".npmrc", "pkg/.pypirc", ".netrc", "credentials.json", "service-account-ci.json", ".pi-mobile-web/state.json"];
  for (const kind of ["project", "tickets"] as const) expectClasses(matcher(kind), secrets.map((file) => [file, false, "local"]));
});

test("worktree shares make every built-in regenerable, secrets and git included", () => {
  expectClasses(matcher("worktrees"), [
    ["feature/.env", false, "regenerable"], ["feature/certs/server.pem", false, "regenerable"], ["feature/.git", false, "regenerable"],
    ["feature/.joint-bob/state.json", false, "regenerable"], ["feature/.stfolder", true, "regenerable"], ["feature/id_rsa", false, "regenerable"],
  ]);
});

test("worktree metadata and the merge baseline sync in worktree shares", () => {
  expectClasses(matcher("worktrees"), [
    ["feature/.joint-bob-worktree", true, null], ["feature/.joint-bob-worktree/worktree.json", false, null],
    ["feature/.joint-bob-baseline", true, null], ["feature/.joint-bob-baseline/src/main.ts", false, null], ["feature/.joint-bob-baseline-old/a.md", false, null],
  ]);
});

test("the merge journal syncs in project and ticket shares and is regenerable in worktree shares", () => {
  expectClasses(matcher("project"), [[".joint-bob-merge", true, null], [".joint-bob-merge/journal.json", false, null]]);
  expectClasses(matcher("tickets"), [["task-1/.joint-bob-merge/journal.json", false, null]]);
  expectClasses(matcher("worktrees"), [["feature/.joint-bob-merge", true, "regenerable"], ["feature/.joint-bob-merge/journal.json", false, "regenerable"]]);
});

test("heavy trees, linked dependency folders and binaries are excluded only in worktree shares", () => {
  const worktreeOnly = ["feature/vendor/lib.go", "feature/out/main.js", "feature/.idea/workspace.xml", "feature/.cache/x", "feature/art/logo.PNG", "feature/media/song.mp3"];
  expectClasses(matcher("worktrees"), worktreeOnly.map((file) => [file, false, "regenerable"]));
  expectClasses(matcher("project"), worktreeOnly.map((file) => [file.replace("feature/", ""), false, null]));
});

test("a linked dependency folder (a symlink, not a directory) is excluded in worktree shares", () => {
  expectClasses(matcher("worktrees"), [["feature/node_modules", false, "regenerable"], ["feature/.venv", false, "regenerable"], ["feature/venv", false, "regenerable"]]);
  // In a project share `.venv/` matches directories only; Syncthing never followed links either.
  expectClasses(matcher("project"), [["node_modules", false, "regenerable"], [".venv", false, null], [".venv", true, "regenerable"]]);
});

test("a trailing slash matches directories only", () => {
  expectClasses(matcher("project"), [["logs", false, null], ["logs", true, "regenerable"], ["logs/today.txt", false, "regenerable"], ["dist", false, null], ["web/dist/app.js", false, "regenerable"]]);
  expectClasses(matcher("project", { userRules: ["exports/"] }), [["exports", false, null], ["exports", true, "user"], ["a/exports/x.csv", false, "user"]]);
});

const guitarPlayer = { userRules: ["(?i)/local_bucket/**.mp3", "(?d)/chords_generator/models"] };

test("guitar_player's mp3 rule ignores bucket audio at any depth, only in the root bucket, in any case", () => {
  expectClasses(matcher("project", guitarPlayer), [
    ["local_bucket/song.mp3", false, "user"], ["local_bucket/artist/album/Track.MP3", false, "user"], ["LOCAL_BUCKET/x.mp3", false, "user"],
    ["local_bucket/index.json", false, null], ["local_bucket", true, null], ["nested/local_bucket/song.mp3", false, null], ["song.mp3", false, null],
  ]);
});

test("guitar_player's models rule is regenerable, anchored and covers its subtree", () => {
  expectClasses(matcher("project", guitarPlayer), [
    ["chords_generator/models", true, "user-regenerable"], ["chords_generator/models/v2/weights.bin", false, "user-regenerable"],
    ["chords_generator/train.py", false, null], ["x/chords_generator/models/a.bin", false, null], ["chords_generator/models2/a.bin", false, null],
  ]);
});

test("user rules in worktree shares are regenerable", () => {
  expectClasses(matcher("worktrees", { userRules: ["*.csv", "(?d)scratch"] }), [["feature/data/a.csv", false, "user-regenerable"], ["feature/scratch/x", false, "user-regenerable"]]);
});

test("a negation before a broader rule re-includes the path", () => {
  expectClasses(matcher("project", { userRules: ["!important.mp3", "*.mp3"] }), [["media/important.mp3", false, null], ["media/other.mp3", false, "user"]]);
});

test("the first matching user rule wins", () => {
  expectClasses(matcher("project", { userRules: ["*.mp3", "!important.mp3"] }), [["media/important.mp3", false, "user"]]);
  expectClasses(matcher("project", { userRules: ["(?d)*.bin", "*.bin"] }), [["a.bin", false, "user-regenerable"]]);
});

test("a negated directory re-includes its subtree for later rules", () => {
  expectClasses(matcher("project", { userRules: ["!keep/", "*.mp3"] }), [["keep/a.mp3", false, null], ["keep/deep/b.mp3", false, null], ["other/a.mp3", false, "user"]]);
});

test("a negation cannot re-include below a directory an outer level ignores", () => {
  expectClasses(matcher("project", { userRules: ["data/", "!data/keep.txt"] }), [["data/keep.txt", false, "user"], ["data", true, "user"]]);
  expectClasses(matcher("project", { userRules: ["!data/keep.txt", "data/"] }), [["data/keep.txt", false, "user"], ["data/keep.txt/inner", false, "user"]]);
});

test("user negations cannot override built-in rules", () => {
  expectClasses(matcher("project", { userRules: ["!.env", "!**", "!*.log"] }), [[".env", false, "local"], ["app.log", false, "regenerable"], ["node_modules/x", false, "regenerable"], ["src/a.ts", false, null]]);
});

test("never-ignored names sync whatever rule matches them", () => {
  const rules = matcher("project", { userRules: [".joint-bob-*", "*.md"] });
  expectClasses(rules, [
    [".joint-bob-worktree", true, null], [".joint-bob-baseline-2", true, null], [".joint-bob-attachments", true, null], [".joint-bob-merge", true, null],
    [".joint-bob-other", true, "user"], ["notes.sync-conflict-20261006-173252-5CHB2CY.md", false, null], ["notes.md", false, "user"],
  ]);
});

test("a conflict copy syncs even when its extension is ignored", () => {
  expectClasses(matcher("project"), [["app.sync-conflict-20261006-173252-5CHB2CY.log", false, null], ["web/app.sync-conflict-20261006-173252-5CHB2CY.log", false, null]]);
});

test("a sync engine's download temp of a conflict copy is never protected by the conflict-copy name", () => {
  const copy = "notes.sync-conflict-20261006-173252-5CHB2CY.md";
  for (const kind of ["project", "tickets", "worktrees"] as const) {
    expectClasses(matcher(kind), [
      [`.joint-bob-sync.${copy}.0123456789abcdef.tmp`, false, "regenerable"], [`web/.joint-bob-sync.${copy}.0123456789abcdef.tmp`, false, "regenerable"],
      [`.syncthing.${copy}.tmp`, false, "regenerable"], [`~syncthing~${copy}.tmp`, false, "regenerable"],
      [copy, false, null],
    ]);
  }
});

test("a never-ignored name protects only itself, not what is inside it or above it", () => {
  expectClasses(matcher("project"), [
    [`.joint-bob-attachments/notes.md.${uuid}.tmp`, false, "regenerable"], [".joint-bob-baseline/node_modules/x.js", false, "regenerable"],
    ["node_modules/.joint-bob-worktree/worktree.json", false, "regenerable"], [".joint-bob-attachments/secret.key", false, "local"],
  ]);
});

test("* stays within one name while ** crosses directories", () => {
  expectClasses(matcher("project", { userRules: ["/reports/*.csv", "/exports/**.csv"] }), [
    ["reports/a.csv", false, "user"], ["reports/2026/a.csv", false, null], ["exports/a.csv", false, "user"], ["exports/2026/10/a.csv", false, "user"],
  ]);
});

test("? matches exactly one character other than a separator", () => {
  expectClasses(matcher("project", { userRules: ["frame-??.png"] }), [["frame-01.png", false, "user"], ["frame-1.png", false, null], ["frame-001.png", false, null], ["a/frame-ab.png", false, "user"]]);
});

test("character classes, negated classes, alternatives and escapes follow Syncthing's glob", () => {
  expectClasses(matcher("project", { userRules: ["run-[0-9].txt", "tmp-[!a-z]", "*.{mov,mkv}", "\\*literal", "price\\?"] }), [
    ["run-7.txt", false, "user"], ["run-x.txt", false, null], ["tmp-1", false, "user"], ["tmp-b", false, null],
    ["v/clip.mov", false, "user"], ["clip.mkv", false, "user"], ["clip.mp4", false, null], ["*literal", false, "user"], ["xliteral", false, null],
    ["price?", false, "user"], ["prices", false, null],
  ]);
});

test("an unanchored pattern with a slash matches at any depth, a leading slash only at the root", () => {
  expectClasses(matcher("project", { userRules: ["data/raw", "/build-cache", "**/fixtures/big"] }), [
    ["data/raw/a.bin", false, "user"], ["svc/data/raw", true, "user"], ["build-cache/x", false, "user"], ["svc/build-cache/x", false, null],
    ["fixtures/big/a", false, "user"], ["a/b/fixtures/big", true, "user"],
  ]);
});

test("a trailing /** ignores what is below a directory but not the directory itself", () => {
  expectClasses(matcher("project", { userRules: ["uploads/**"] }), [["uploads", true, null], ["uploads/a.png", false, "user"], ["x/uploads/b/c.png", false, "user"]]);
});

test("/** alone ignores everything, as in Syncthing", () => {
  expectClasses(matcher("project", { userRules: ["!README.md", "/**"] }), [["a", false, "user"], ["src", true, "user"], ["src/a.ts", false, "user"], ["README.md", false, null]]);
});

test("(?i) folds case and patterns are otherwise case-sensitive", () => {
  expectClasses(matcher("project", { userRules: ["(?i)*.wav", "Thumbs.db"] }), [["a.WAV", false, "user"], ["a.wav", false, "user"], ["Thumbs.db", false, "user"], ["thumbs.db", false, null]]);
  expectClasses(matcher("project"), [["Node_Modules/x", false, null], ["app.LOG", false, null]]);
});

test("parseUserRules drops comments and blank lines and reports #include and invalid patterns", () => {
  const parsed = parseUserRules(["", "  // comment", "# comment", "#include more.stignore", " *.csv ", "*.csv", "[abc", "{a,b", "!", "(?d)(?i)", "!(?i)/Keep/"]);
  assert.deepEqual(parsed.rules.map((rule) => rule.line), ["*.csv", "!(?i)/Keep/"]);
  assert.deepEqual(parsed.unsupported, ["#include more.stignore"]);
  assert.deepEqual(parsed.errors.map((error) => error.line), ["[abc", "{a,b", "!", "(?d)(?i)"]);
  assert.deepEqual(parsed.rules[1], { line: "!(?i)/Keep/", negate: true, foldCase: true, deletable: false, anchored: true, dirOnly: true, childrenOnly: false, body: "Keep", source: "Keep" });
});

test("user rules from Syncthing keep exactly the lines setProjectIgnores treats as user rules", () => {
  assert.deepEqual(userRulesFromSyncthingIgnores(["secrets/", "*.pem", ".git", "__pycache__/", "playwright-report/", "aidlc/.aidlc-*", "secrets/"]), ["secrets/"]);
  assert.deepEqual(userRulesFromSyncthingIgnores(["!.env", "!**", ...managedIgnorePatterns.slice().reverse()]), ["!.env", "!**"]);
});

test("user rules from Syncthing drop worktree-list lines even in a project folder, with or without (?d)", () => {
  assert.deepEqual(userRulesFromSyncthingIgnores(["vendor", "(?d)out", "(?i)*.mp3", "(?d)(?i)*.png", ".env", "(?i)/local_bucket/**.mp3", "(?d)/chords_generator/models", "// note", ""]),
    ["(?i)/local_bucket/**.mp3", "(?d)/chords_generator/models", "// note", ""]);
});

test("a null Syncthing ignore list has no user rules", () => {
  assert.deepEqual(userRulesFromSyncthingIgnores(null), []);
});

test("switched-off built-ins add up across levels and locked or unknown ids are dropped", () => {
  const rules = effectiveRules("project", { disabledBuiltins: ["target", ".git", "no-such-rule"] }, { disabledBuiltins: ["*.log", "vendor", "target"] });
  assert.deepEqual(rules.disabledBuiltins, ["*.log", "target"], "vendor is a worktree-only rule");
  assert.deepEqual(effectiveRules("worktrees", { disabledBuiltins: ["vendor"] }).disabledBuiltins, ["vendor"]);
});

test("switching off a built-in syncs what it covered, and a locked rule keeps applying", () => {
  expectClasses(matcher("project", { disabledBuiltins: ["target", ".git", ".git/**", "**/.git", "**/.git/**"] }), [["target/classes/App.java", false, null], [".git/HEAD", false, "local"]]);
});

test("project user rules come before the owner's all-projects rules, and removed rules are not in effect", () => {
  const rules = effectiveRules("project", { userRules: ["!keep.csv", "*.tmpdata", "old/"], removedUserRules: ["old/"] }, { userRules: ["*.csv", "*.tmpdata", "# note", "[bad"] });
  assert.deepEqual(rules.userRules, ["!keep.csv", "*.tmpdata", "*.csv"]);
  expectClasses(compileRules(rules), [["keep.csv", false, null], ["other.csv", false, "user"], ["old/a", false, null]]);
});

test("the .gitignore option is on when either level turns it on", () => {
  assert.equal(effectiveRules("project", { gitignore: false }, { gitignore: true }).gitignore, true);
  assert.equal(effectiveRules("project").gitignore, false);
});

test("rulesHash ignores the order of switched-off built-ins but not the order of user rules", () => {
  const base = rulesHash(effectiveRules("project", { disabledBuiltins: ["target", "*.log"], userRules: ["a", "!b"] }));
  assert.equal(rulesHash(effectiveRules("project", { disabledBuiltins: ["*.log", "target"], userRules: ["a", "!b"] })), base);
  assert.notEqual(rulesHash(effectiveRules("project", { disabledBuiltins: ["target", "*.log"], userRules: ["!b", "a"] })), base);
  assert.match(base, /^[0-9a-f]{64}$/);
});

test("rulesHash survives the merged settings the worker receives", () => {
  const merged = effectiveRules("tickets", { userRules: ["*.csv", "// note"], disabledBuiltins: ["tmp"] }, { userRules: ["*.wav"], gitignore: true });
  const relayed = effectiveRules("tickets", effectiveRuleSettings(merged));
  assert.deepEqual(relayed, merged);
  assert.equal(rulesHash(relayed), rulesHash(merged));
});

test("rulesHash changes with the share kind, the .gitignore option and a switched-off built-in", () => {
  const hashes = [
    rulesHash(effectiveRules("project")), rulesHash(effectiveRules("tickets")), rulesHash(effectiveRules("worktrees")),
    rulesHash(effectiveRules("project", { gitignore: true })), rulesHash(effectiveRules("project", { disabledBuiltins: ["target"] })),
  ];
  assert.equal(new Set(hashes).size, hashes.length, hashes.join(" "));
});

/** Deterministic PRNG (mulberry32) so a failure names a reproducible case. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const vocabulary = [
  "src", "lib", "node_modules", ".git", "a.key", ".dev-env", "logs", "x.log", ".env", ".env.local", "cache", ".yarn", ".cache", "pip", "aidlc",
  ".aidlc-x", "spaces", "s1", "intents", "i1", ".joint-bob-worktree", ".joint-bob-baseline", ".joint-bob-merge", ".joint-bob", ".joint-bob-attachments",
  "x.sync-conflict-20261006-173252-5CHB2CY.log", "target", "vendor", "x.PNG", "test_database_1.db", "a.db-wal", ".creating-1", ".pi", "foo-worktrees",
  ".claude", "worktrees", "local_bucket", "a.mp3", "chords_generator", "models", "keep", "data", "README.md", `x.${uuid}.tmp`, ".stversions", "Pkg.WHL",
  "build", "dist", "main.ts", "id_rsa", "uploads", ".pytest_cache", "test-results",
];

function randomPaths(count: number, seed: number): Array<[string, boolean]> {
  const next = random(seed);
  return Array.from({ length: count }, () => {
    const depth = 1 + Math.floor(next() * 6);
    const names = Array.from({ length: depth }, () => vocabulary[Math.floor(next() * vocabulary.length)]);
    return [names.join("/"), next() < 0.3];
  });
}

test("explain names the deciding rule and agrees with classify on random paths", () => {
  const gitIgnored = new Set(["data", "keep/x.mp3", ".joint-bob-attachments"]);
  const settings = [{}, { userRules: ["!keep/", "(?i)/local_bucket/**.mp3", "(?d)/chords_generator/models", "*.mp3", "data/", "uploads/**", "!README.md"], gitignore: true, disabledBuiltins: ["target"] }];
  for (const kind of ["project", "tickets", "worktrees"] as const) for (const [index, project] of settings.entries()) {
    const rules = matcher(kind, project);
    for (const [file, isDirectory] of randomPaths(4000, 7 + index)) {
      const fast = rules.classify(file, isDirectory, gitIgnored);
      const slow = rules.explain(file, isDirectory, gitIgnored);
      assert.equal(fast, slow?.class ?? null, `${kind}/${index}: ${file}${isDirectory ? "/" : ""} classify ${fast}, explain ${JSON.stringify(slow)}`);
    }
  }
  assert.deepEqual(matcher("project").explain(".dev-env/a/secret.key", false), { class: "regenerable", rule: ".dev-env/", level: ".dev-env" });
});

test("hintPattern matches every path a built-in of any kind ignores and skips plain source", () => {
  const hint = hintPattern();
  for (const kind of ["project", "tickets", "worktrees"] as const) {
    const rules = matcher(kind);
    for (const [file, isDirectory] of randomPaths(3000, 11)) {
      if (rules.classify(file, isDirectory) !== null) assert.ok(hint.test(file), `${kind}: hint misses ${file}`);
    }
  }
  for (const file of ["src/main.ts", "docs/guide/README.md", "packages/ui/index.tsx"]) assert.equal(hint.test(file), false, `hint matches plain source ${file}`);
});

test("a matcher's hint covers its user rules", () => {
  const rules = matcher("project", guitarPlayer);
  for (const file of ["local_bucket/a/b.MP3", "chords_generator/models/x/y.bin"]) assert.ok(rules.hint.test(file), `hint misses ${file}`);
  assert.equal(rules.hint.test("chords_generator/train.py"), false);
});

test("the .gitignore option ignores listed paths and their subtrees as user rules, and is off by default", () => {
  const gitIgnored = new Set(["generated", "notes/draft.txt", ".joint-bob-attachments"]);
  expectClasses(matcher("project", { gitignore: true }), [
    ["generated", true, "user"], ["generated/a/b.ts", false, "user"], ["notes/draft.txt", false, "user"], ["notes/final.txt", false, null],
    [".joint-bob-attachments/a.txt", false, null],
  ], gitIgnored);
  expectClasses(matcher("worktrees", { gitignore: true }), [["generated/a.ts", false, "user-regenerable"]], gitIgnored);
  expectClasses(matcher("project"), [["generated/a/b.ts", false, null]], gitIgnored);
  expectClasses(matcher("project", { gitignore: true, userRules: ["!generated/keep.ts"] }), [["generated/keep.ts", false, null]], new Set(["generated/keep.ts"]));
});

/** .gitignore files by folder ("" is the root); a fingerprint per text, so a change shows. */
function gitignores(files: Record<string, string>): GitignoreTree {
  return new GitignoreTree((dir) => Object.hasOwn(files, dir) ? { text: files[dir], fingerprint: files[dir] } : null);
}

/** What the .gitignore option alone decides, level by level from the top as classify asks. */
function gitignored(tree: GitIgnoredPaths, file: string, isDirectory = false): boolean {
  const names = file.split("/");
  return names.some((_, index) => tree.has(names.slice(0, index + 1).join("/"), index < names.length - 1 || isDirectory));
}

test("a .gitignore file is read as gitignore(5) describes", () => {
  const tree = gitignores({
    "": [
      "# a comment", "", "*.log", "!keep.log", "/build", "docs/*.md", "out/", "\\#hash", "\\!bang", "trail   ", "esc\\ ", "**/tmp/**", "a/**/z",
      "secret?.txt", "[abc].dat", "[!x]y.bin", "data/", "!data/keep.txt", "logs/*", "!logs/keep", "café",
    ].join("\r\n"),
    src: "!app.log\n/gen\n",
  });
  const cases: Array<[string, boolean, boolean]> = [
    ["app.log", false, true], ["keep.log", false, false], ["x/app.log", false, true], ["src/app.log", false, false], ["src/x/app.log", false, false],
    ["build", false, true], ["sub/build", false, false], ["src/gen", true, true], ["src/x/gen", true, false],
    ["docs/a.md", false, true], ["docs/sub/a.md", false, false], ["out", true, true], ["out", false, false], ["x/out", true, true],
    ["#hash", false, true], ["!bang", false, true], ["trail", false, true], ["esc ", false, true], ["esc", false, false],
    ["tmp/y", false, true], ["x/tmp/y/z", false, true], ["x/tmp", true, false], ["a/z", false, true], ["a/b/c/z", false, true], ["b/z", false, false],
    ["secret1.txt", false, true], ["secret12.txt", false, false], ["a.dat", false, true], ["d.dat", false, false], ["zy.bin", false, true], ["xy.bin", false, false],
    ["data/keep.txt", false, true], ["logs/keep", false, false], ["logs/other", false, true], ["café/x", false, true],
  ];
  for (const [file, isDirectory, expected] of cases) assert.equal(gitignored(tree, file, isDirectory), expected, `${file}${isDirectory ? "/" : ""}`);
  assert.equal(parseGitignore("[unclosed\n").length, 0, "a pattern git cannot match is left out");
  assert.equal(gitignored(gitignores({ "": `${String.fromCharCode(0xfeff)}*.bin\n` }), "a.bin"), true, "a leading byte order mark is not part of the first pattern");
});

test("a .gitignore is read once, and again only after it changed", () => {
  const files: Record<string, string> = { "": "*.out\n" };
  let reads = 0;
  const tree = new GitignoreTree((dir) => { reads++; return Object.hasOwn(files, dir) ? { text: files[dir], fingerprint: files[dir] } : null; });
  assert.equal(tree.changed("", "*.out\n"), false, "never read: nothing to compare");
  for (const file of ["a.out", "b.out", "c.txt"]) tree.has(file);
  assert.equal(reads, 1);
  assert.equal(tree.changed("", "*.out\n"), false);
  files[""] = "*.txt\n";
  assert.equal(tree.changed("", files[""]), true);
  assert.equal(tree.has("c.txt"), false, "kept until invalidated");
  tree.invalidate("");
  assert.deepEqual([tree.has("c.txt"), tree.has("a.out"), reads], [true, false, 2]);
  assert.equal(tree.changed("missing", null), false);
});

test("gitignore matching agrees with git on a tree of nested .gitignore files", async (t) => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { t.skip("git is not installed"); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), "file-sync-gitignore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ignores: Record<string, string> = {
    "": "*.log\n!important.log\n/build/\ndocs/**/*.tmp\n**/cache\ntemp?\n[0-9]*.bak\nnested/deep/\n*.o\n!keep.o\nkeep/\n!keep/x\n",
    pkg: "*.json\n!package.json\n/local\n",
    "pkg/sub": "!*.log\ngenerated/**\n",
  };
  const files = [
    "a.log", "important.log", "x/b.log", "build/out.txt", "sub/build/out.txt", "docs/a/b/c.tmp", "docs/c.tmp", "docs/x.txt", "cache/f", "a/cache/f",
    "temp1", "temp12", "1x.bak", "x.bak", "nested/deep/f", "nested/f", "main.o", "keep.o", "keep/x", "pkg/a.json", "pkg/package.json", "pkg/local/f",
    "pkg/x/local/f", "pkg/sub/a.log", "pkg/sub/generated/x.ts", "pkg/sub/z.json", "café/é.log", "src/main.ts",
  ];
  for (const [dir, text] of Object.entries(ignores)) {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, ".gitignore"), text);
  }
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), "x\n");
  }
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env });
  const listed = execFileSync("git", ["-c", "core.excludesFile=", "-c", "core.ignorecase=false", "ls-files", "-z", "--others", "--ignored", "--exclude-per-directory=.gitignore"], { cwd: root, env })
    .toString("utf8").split("\0").filter(Boolean).map((file) => file.normalize("NFC"));
  const tree = gitignores(ignores);
  const ours = files.filter((file) => gitignored(tree, file));
  assert.deepEqual(ours.sort(), listed.sort());
});

/** A tree shaped like a real monorepo: packages, nested sources, dependencies, build output and media. */
function syntheticTree(count: number): string[] {
  const next = random(42);
  const dirs = ["src", "lib", "test", "docs", "components", "utils", "api", "models", "views", "assets", "scripts", "internal"];
  const names = ["index.ts", "main.py", "README.md", "app.tsx", "style.css", "data.json", "util.go", "logo.png", "notes.txt", "Makefile", "song.mp3", "build.log"];
  const tops = ["", "", "", "node_modules/pkg/", "packages/web/node_modules/dep/", "dist/", "local_bucket/artist/", "services/api/.venv/lib/", "target/classes/"];
  return Array.from({ length: count }, (_, index) => {
    const depth = 1 + Math.floor(next() * 6);
    const middle = Array.from({ length: depth }, () => dirs[Math.floor(next() * dirs.length)]).join("/");
    return `${tops[index % tops.length]}packages/p${index % 40}/${middle}/${index % 7}-${names[Math.floor(next() * names.length)]}`;
  });
}

test("classify handles 100k paths of a large tree in well under a second", (t) => {
  const files = syntheticTree(100_000);
  const userRules = [...guitarPlayer.userRules, "*.bak", "/exports/**", "!keep.md", "(?i)*.wav", "fixtures/big/", "data/raw", "*.{mov,mkv}", "(?d)**/scratch-*"];
  for (const [kind, settings] of [["project", { userRules }], ["worktrees", {}]] as const) {
    const rules = matcher(kind, settings);
    for (const file of files.slice(0, 2_000)) rules.classify(file, false);
    const started = performance.now();
    let ignored = 0;
    for (const file of files) if (rules.classify(file, false) !== null) ignored++;
    const elapsed = performance.now() - started;
    t.diagnostic(`${kind}: ${files.length} paths in ${elapsed.toFixed(0)} ms, ${ignored} ignored`);
    assert.ok(ignored > 30_000 && ignored < files.length, `${kind}: ${ignored} ignored`);
    assert.ok(elapsed < 1_000, `${kind}: classify took ${elapsed.toFixed(0)} ms for ${files.length} paths`);
  }
});
