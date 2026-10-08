import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveDataDirectory } from "./data-directory.js";
const agentGitPolicyInstructions = `# Joint Bob git policy

Agents never create git branches or git worktrees. The \`git\` on PATH refuses \`git branch <new>\`, \`git branch -m/-M/-c/-C\`, \`git checkout -b/-B/--orphan\`, \`git switch -c/-C/--orphan\`, \`git stash branch\` and \`git worktree add/move\`, including through aliases and tools that call git. Do not work around it with another git binary, a different branch name, or a copied repository.

Isolated work happens in Joint Bob worktrees. A Joint Bob worktree is a synced copy of the project's code and text that every node sharing the project receives, shown in its own color in the conversation list. When a task needs isolation, create one with the Joint Bob worktree CLI (see Joint Bob worktrees) or ask the user to create one from the project's Worktrees section. Inside a worktree, edit files in place; it has no \`.git\`, and its changes return through a pull request opened with the worktree CLI, or through Merge to project when the user does it.

Committing, pushing an existing branch, switching to an existing branch, and read-only commands are allowed.`;
const GUARD_SCRIPT = String.raw`#!/bin/sh
# Joint Bob agent git policy. Generated; do not edit.
guard_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
real="$JOINT_BOB_REAL_GIT"
if [ -z "$real" ] || [ ! -x "$real" ]; then
  real=
  saved_ifs=$IFS; IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] && [ -x "$dir/git" ] && [ ! -d "$dir/git" ] || continue
    [ "$(CDPATH= cd -- "$dir" 2>/dev/null && pwd -P)" = "$guard_dir" ] && continue
    real="$dir/git"; break
  done
  IFS=$saved_ifs
fi
if [ -z "$real" ]; then echo "git: command not found" >&2; exit 127; fi

refuse() {
  echo "Joint Bob: agents may not create git branches or worktrees ($1)." >&2
  echo "Ask the user to create a Joint Bob worktree for this project and continue in a conversation started inside it." >&2
  exit 1
}

check() {
  sub=$1; shift
  case "$sub" in
    worktree)
      case "$1" in add|move) refuse "git worktree $1" ;; esac ;;
    stash)
      [ "$1" = branch ] && refuse "git stash branch" ;;
    checkout)
      for a in "$@"; do
        case "$a" in --) break ;; -b|-B|-b?*|-B?*|--orphan|--orphan=*) refuse "git checkout $a" ;; esac
      done ;;
    switch)
      for a in "$@"; do
        case "$a" in --) break ;; -c|-C|-c?*|-C?*|--create|--create=*|--force-create|--force-create=*|--orphan|--orphan=*) refuse "git switch $a" ;; esac
      done ;;
    branch)
      listing=; positional=; value=
      for a in "$@"; do
        if [ -n "$value" ]; then value=; continue; fi
        case "$a" in
          -m|-M|-c|-C|--move|--copy) refuse "git branch $a" ;;
          -d|-D|--delete|-l|--list|-a|--all|-r|--remotes|--show-current|-v|-vv|--verbose|--edit-description|--unset-upstream|-u|--set-upstream-to|--set-upstream-to=*|--contains*|--no-contains*|--merged*|--no-merged*|--points-at*|--sort=*|--format=*) listing=1 ;;
          --sort|--format) listing=1; value=1 ;;
          -*) ;;
          *) positional=1 ;;
        esac
      done
      [ -n "$positional" ] && [ -z "$listing" ] && refuse "git branch $*" ;;
  esac
  return 0
}

# Global options come before the subcommand; -C/-c/--git-dir/... take a value.
inspect() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env) shift; [ "$#" -gt 0 ] && shift ;;
      -*) shift ;;
      *) break ;;
    esac
  done
  [ "$#" -gt 0 ] || return 0
  sub=$1; shift
  case "$sub" in
    branch|checkout|switch|worktree|stash) check "$sub" "$@"; return 0 ;;
    status|diff|log|show|add|rm|mv|commit|push|pull|fetch|merge|rebase|reset|restore|rev-parse|rev-list|ls-files|ls-tree|cat-file|blame|grep|config|remote|tag|describe|cherry-pick|revert|apply|am|clone|init|clean|for-each-ref|show-ref|symbolic-ref|update-index|hash-object|diff-tree|diff-index|merge-base|name-rev|shortlog|reflog|gc|count-objects|var|version|help|--*) return 0 ;;
  esac
  expanded=$("$real" config --get "alias.$sub" 2>/dev/null) || return 0
  case "$expanded" in
    !*) case "$expanded" in *"worktree add"*|*"worktree move"*|*"checkout -b"*|*"checkout -B"*|*"switch -c"*|*"switch -C"*|*"stash branch"*|*"branch -m"*|*"branch -M"*) refuse "alias $sub" ;; esac ;;
    *) set -f; check $expanded "$@"; set +f ;;
  esac
}

inspect "$@"
exec "$real" "$@"
`;
let installed;
function agentGitGuardDirectory(dataDirectory = resolveDataDirectory()) {
  const directory = path.join(dataDirectory, "runtime", "git-guard");
  if (installed === directory) return directory;
  const file = path.join(directory, "git");
  let current;
  try {
    current = readFileSync(file, "utf8");
  } catch {
  }
  if (current !== GUARD_SCRIPT) {
    mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, GUARD_SCRIPT, { mode: 493 });
    chmodSync(temporary, 493);
    renameSync(temporary, file);
  }
  installed = directory;
  return directory;
}
let realGit;
function resolveRealGit(guard) {
  if (realGit !== void 0) return realGit ?? void 0;
  realGit = null;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory || path.resolve(directory) === guard) continue;
    const candidate = path.join(directory, "git");
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 5e3 });
      realGit = candidate;
      break;
    } catch {
    }
  }
  return realGit ?? void 0;
}
function agentGitPolicyEnvironment(basePath = process.env.PATH ?? "") {
  const guard = agentGitGuardDirectory();
  const entries = basePath.split(path.delimiter).filter((entry) => entry && path.resolve(entry) !== guard);
  return { PATH: [guard, ...entries].join(path.delimiter), JOINT_BOB_REAL_GIT: resolveRealGit(guard) };
}
export {
  agentGitGuardDirectory,
  agentGitPolicyEnvironment,
  agentGitPolicyInstructions
};
