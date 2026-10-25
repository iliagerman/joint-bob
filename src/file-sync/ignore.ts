import { createHash } from "node:crypto";
import {
  BUILTIN_RULES, BUILTIN_RULES_VERSION, builtinRule, builtinRulesFor, isNeverIgnored, SYNCTHING_PROJECT_PATTERNS, SYNCTHING_WORKTREE_PATTERNS,
  type BuiltinRule,
} from "./builtin-rules.js";
import type { RuleSettings, ShareKind } from "./types.js";

/* The matcher every scan, event and need decision goes through. Syncthing pattern syntax (gobwas glob
   with "/" as separator): an unanchored pattern matches at any depth, a leading "/" anchors it to the
   share root, "*" and "?" stay within one name, "**" crosses "/", [...] and {a,b} as in Syncthing,
   "(?i)" folds case, "(?d)" marks a user rule regenerable, "!" re-includes. A match on a directory
   covers its subtree, a trailing "/" matches directories only, a trailing "/**" only what is below.
   Unlike Syncthing on macOS, matching is case-sensitive without "(?i)", so every node agrees. */

/** null from classify means synced. */
export type IgnoreClass = "local" | "regenerable" | "user" | "user-regenerable";

/** Whether a peer's directory delete may remove it along with the directory (§5.5.8). */
export function isDeletableClass(ignoreClass: IgnoreClass): boolean {
  return ignoreClass === "regenerable" || ignoreClass === "user-regenerable";
}

export class RuleSyntaxError extends Error {}

interface Pattern {
  negate: boolean;
  foldCase: boolean;
  deletable: boolean;
  anchored: boolean;
  dirOnly: boolean;
  childrenOnly: boolean;
  /** Glob left after the prefixes, the anchor and a trailing "/" or "/**". */
  body: string;
  /** RegExp source of body. */
  source: string;
}

export interface UserRule extends Pattern {
  /** The trimmed line as stored in the settings record. */
  line: string;
}

export interface ParsedUserRules {
  rules: UserRule[];
  /** `#include` lines: rules are replicated records, there is no file to include from. */
  unsupported: string[];
  errors: Array<{ line: string; reason: string }>;
}

/** User rules compile to backtracking RegExps tested on every path; keep them short. */
const MAX_RULE_LENGTH = 1024;
const ESCAPED = new Set("\\^$.*+?()[]{}|/");

function literal(char: string): string { return ESCAPED.has(char) ? `\\${char}` : char; }

/** "s" so "**" also crosses a newline inside a name. */
function regExpFlags(foldCase: boolean): string { return foldCase ? "isu" : "su"; }

function globSource(glob: string): string {
  let index = 0;
  const characterClass = (): string => {
    let negate = false;
    if (glob[index] === "!" || glob[index] === "^") { negate = true; index++; }
    let body = "";
    while (index < glob.length && glob[index] !== "]") {
      let char = glob[index++];
      const escaped = char === "\\" && index < glob.length;
      if (escaped) char = glob[index++];
      body += char === "-" ? (escaped ? "\\-" : "-") : "\\^[]".includes(char) ? `\\${char}` : char;
    }
    if (index >= glob.length) throw new RuleSyntaxError("Unclosed [ in pattern");
    index++;
    if (!body) throw new RuleSyntaxError("Empty [] in pattern");
    // A negated class never matches the separator, as "?" does not.
    return negate ? `[^${body}/]` : `[${body}]`;
  };
  const sequence = (inBraces: boolean): string => {
    let out = "";
    while (index < glob.length) {
      const char = glob[index];
      if (inBraces && (char === "," || char === "}")) return out;
      index++;
      if (char === "\\") out += index < glob.length ? literal(glob[index++]) : "\\\\";
      else if (char === "*") {
        if (glob[index] === "*") { while (glob[index] === "*") index++; out += ".*"; }
        else out += "[^/]*";
      } else if (char === "?") out += "[^/]";
      else if (char === "[") out += characterClass();
      else if (char === "{") {
        const options: string[] = [];
        for (;;) {
          options.push(sequence(true));
          if (index >= glob.length) throw new RuleSyntaxError("Unclosed { in pattern");
          if (glob[index++] === "}") break;
        }
        out += `(?:${options.join("|")})`;
      } else out += literal(char);
    }
    return out;
  };
  const source = sequence(false);
  try { new RegExp(source, regExpFlags(false)); } catch (error) { throw new RuleSyntaxError(`Invalid pattern: ${(error as Error).message}`); }
  return source;
}

function parsePattern(line: string): Pattern {
  if (line.length > MAX_RULE_LENGTH) throw new RuleSyntaxError(`Pattern is longer than ${MAX_RULE_LENGTH} characters`);
  let rest = line;
  let negate = false, foldCase = false, deletable = false;
  // Syncthing accepts the prefixes in any order, each once.
  for (;;) {
    if (!negate && rest.startsWith("!")) { negate = true; rest = rest.slice(1); }
    else if (!foldCase && rest.startsWith("(?i)")) { foldCase = true; rest = rest.slice(4); }
    else if (!deletable && rest.startsWith("(?d)")) { deletable = true; rest = rest.slice(4); }
    else break;
  }
  let childrenOnly = false, dirOnly = false, anchored = false;
  // "/**" alone is an anchored "**" (everything), not "below nothing".
  if (rest.length > 3 && rest.endsWith("/**")) { childrenOnly = true; rest = rest.slice(0, -3); }
  else if (rest.endsWith("/")) { dirOnly = true; rest = rest.slice(0, -1); }
  if (rest.startsWith("/")) { anchored = true; rest = rest.slice(1); }
  else if (rest.startsWith("**/")) rest = rest.slice(3);
  if (!rest) throw new RuleSyntaxError("Missing pattern");
  return { negate, foldCase, deletable, anchored, dirOnly, childrenOnly, body: rest, source: globSource(rest) };
}

/** Tested against a level: the path up to and including one name ("a", "a/b", "a/b/c"). */
function levelRegExp(pattern: Pattern): RegExp {
  return new RegExp(`${pattern.anchored ? "^" : "^(?:.*/)?"}${pattern.source}${pattern.childrenOnly ? "/.*" : ""}$`, regExpFlags(pattern.foldCase));
}

/** Comments ("//" as in Syncthing, "#" as in .gitignore) and blank lines are dropped; duplicates keep their first position. */
export function parseUserRules(lines: readonly string[]): ParsedUserRules {
  const parsed: ParsedUserRules = { rules: [], unsupported: [], errors: [] };
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || seen.has(line)) continue;
    seen.add(line);
    if (line.startsWith("#include")) { parsed.unsupported.push(line); continue; }
    if (line.startsWith("#")) continue;
    try {
      parsed.rules.push({ ...parsePattern(line), line });
    } catch (error) {
      if (!(error instanceof RuleSyntaxError)) throw error;
      parsed.errors.push({ line, reason: error.message });
    }
  }
  return parsed;
}

const ANY = 1, DIR = 2, ROOT_ANY = 4, ROOT_DIR = 8;

function patternBits(pattern: Pattern): number {
  return pattern.anchored ? (pattern.dirOnly ? ROOT_DIR : ROOT_ANY) : (pattern.dirOnly ? DIR : ANY);
}

function bitsMatch(bits: number, isDirectory: boolean, depth: number): boolean {
  return (bits & ANY) !== 0 || (isDirectory && (bits & DIR) !== 0) || (depth === 1 && ((bits & ROOT_ANY) !== 0 || (isDirectory && (bits & ROOT_DIR) !== 0)));
}

const LITERAL = /^[^*?[{\\/]+$/;
const EXTENSION = /^\*\.([^*?[{\\/.]+)$/;

function addBits(map: Map<string, number>, key: string, bits: number): void { map.set(key, (map.get(key) ?? 0) | bits); }

/* Any-match over a set of built-in patterns, precompiled so classify does no per-call regex
   construction: literal names and "*.ext" go through maps, other one-name globs through one combined
   regex per anchoring/type/case variant, and multi-name globs through combined regexes over the
   level string, skipped unless the level's last name can end one of them. */
class PatternIndex {
  private readonly exact = new Map<string, number>();
  private readonly exactFold = new Map<string, number>();
  private readonly extension = new Map<string, number>();
  private readonly extensionFold = new Map<string, number>();
  private segments: Array<{ re: RegExp; bits: number }> = [];
  private levels: Array<{ re: RegExp; dirOnly: boolean }> = [];
  private levelFilter: RegExp | null = null;
  private readonly pendingSegments = new Map<string, string[]>();
  private readonly pendingLevels = new Map<string, { anchored: string[]; unanchored: string[] }>();
  private readonly lastNames: string[] = [];
  private unfilteredLevels = false;
  empty = true;

  add(pattern: Pattern): void {
    this.empty = false;
    const bits = patternBits(pattern);
    const body = pattern.foldCase ? pattern.body.toLowerCase() : pattern.body;
    if (!pattern.body.includes("/") && !pattern.body.includes("**")) {
      const extension = EXTENSION.exec(body);
      if (LITERAL.test(body)) addBits(pattern.foldCase ? this.exactFold : this.exact, body, bits);
      else if (extension) addBits(pattern.foldCase ? this.extensionFold : this.extension, extension[1], bits);
      else {
        const key = `${bits}:${pattern.foldCase}`;
        this.pendingSegments.set(key, [...this.pendingSegments.get(key) ?? [], pattern.source]);
      }
      return;
    }
    const key = `${pattern.dirOnly}:${pattern.foldCase}`;
    const group = this.pendingLevels.get(key) ?? { anchored: [], unanchored: [] };
    (pattern.anchored ? group.anchored : group.unanchored).push(pattern.source);
    this.pendingLevels.set(key, group);
    const lastName = pattern.body.slice(pattern.body.lastIndexOf("/") + 1);
    if (lastName.includes("**")) this.unfilteredLevels = true;
    else this.lastNames.push(globSource(lastName));
  }

  finish(): this {
    this.segments = [...this.pendingSegments].map(([key, sources]) => {
      const [bits, fold] = key.split(":");
      return { re: new RegExp(`^(?:${sources.join("|")})$`, regExpFlags(fold === "true")), bits: Number(bits) };
    });
    this.levels = [...this.pendingLevels].map(([key, group]) => {
      const [dirOnly, fold] = key.split(":");
      const parts = [
        ...(group.unanchored.length ? [`^(?:.*/)?(?:${group.unanchored.join("|")})$`] : []),
        ...(group.anchored.length ? [`^(?:${group.anchored.join("|")})$`] : []),
      ];
      return { re: new RegExp(parts.join("|"), regExpFlags(fold === "true")), dirOnly: dirOnly === "true" };
    });
    // Case-insensitive on purpose: a prefilter only has to be a superset.
    this.levelFilter = this.levels.length && !this.unfilteredLevels ? new RegExp(`^(?:${this.lastNames.join("|")})$`, regExpFlags(true)) : null;
    return this;
  }

  /** `name` is the level's last name; `end` is where the level ends in `path`. */
  test(path: string, end: number, name: string, depth: number, isDirectory: boolean): boolean {
    if (this.empty) return false;
    let bits = this.exact.get(name);
    if (bits !== undefined && bitsMatch(bits, isDirectory, depth)) return true;
    if (this.exactFold.size) {
      bits = this.exactFold.get(name.toLowerCase());
      if (bits !== undefined && bitsMatch(bits, isDirectory, depth)) return true;
    }
    const dot = name.lastIndexOf(".");
    if (dot >= 0) {
      const extension = name.slice(dot + 1);
      bits = this.extension.get(extension);
      if (bits !== undefined && bitsMatch(bits, isDirectory, depth)) return true;
      if (this.extensionFold.size) {
        bits = this.extensionFold.get(extension.toLowerCase());
        if (bits !== undefined && bitsMatch(bits, isDirectory, depth)) return true;
      }
    }
    for (const segment of this.segments) if (bitsMatch(segment.bits, isDirectory, depth) && segment.re.test(name)) return true;
    if (this.levels.length && (this.unfilteredLevels || this.levelFilter!.test(name))) {
      const level = end === path.length ? path : path.slice(0, end);
      for (const candidate of this.levels) if ((isDirectory || !candidate.dirOnly) && candidate.re.test(level)) return true;
    }
    return false;
  }
}

export interface EffectiveRules {
  kind: ShareKind;
  /** Built-ins switched off for this share; locked, unknown and other-kind ids are dropped. Sorted. */
  disabledBuiltins: string[];
  /** Valid user rule lines, the project's before its owner's all-projects rules (first match wins). */
  userRules: string[];
  gitignore: boolean;
}

/** Whether the share's .gitignore files ignore a path, its ancestors aside (see GitignoreTree); a Set of paths will do in tests. */
export interface GitIgnoredPaths { has(path: string, isDirectory?: boolean): boolean }

export interface IgnoreExplanation {
  class: IgnoreClass;
  /** The built-in id, the user rule line, or ".gitignore". */
  rule: string;
  /** The level the rule matched: the path itself or the ancestor directory that covers it. */
  level: string;
}

interface CompiledBuiltin { rule: BuiltinRule; pattern: Pattern; re: RegExp }
interface CompiledUserRule extends UserRule { re: RegExp }

export class IgnoreMatcher {
  readonly rules: EffectiveRules;
  readonly hash: string;
  private readonly worktrees: boolean;
  private readonly localSelf = new PatternIndex();
  private readonly localChildren = new PatternIndex();
  private readonly regenerableSelf = new PatternIndex();
  private readonly regenerableChildren = new PatternIndex();
  private readonly builtins: Array<{ rule: BuiltinRule; pattern: Pattern }> = [];
  private readonly user: CompiledUserRule[];
  private readonly userSelf = new PatternIndex();
  private readonly userChildren = new PatternIndex();
  private compiledBuiltins?: CompiledBuiltin[];
  private hintCache?: RegExp;

  constructor(rules: EffectiveRules) {
    this.rules = effectiveRules(rules.kind, rules);
    this.hash = rulesHash(this.rules);
    this.worktrees = this.rules.kind === "worktrees";
    const disabled = new Set(this.rules.disabledBuiltins);
    for (const rule of builtinRulesFor(this.rules.kind)) {
      if (disabled.has(rule.id)) continue;
      const pattern = parsePattern(rule.pattern);
      this.builtins.push({ rule, pattern });
      // Worktree shares are disposable copies: every built-in is regenerable there.
      const local = rule.class === "local" && !this.worktrees;
      (pattern.childrenOnly ? (local ? this.localChildren : this.regenerableChildren) : (local ? this.localSelf : this.regenerableSelf)).add(pattern);
    }
    for (const index of [this.localSelf, this.localChildren, this.regenerableSelf, this.regenerableChildren]) index.finish();
    this.user = parseUserRules(this.rules.userRules).rules.map((rule) => ({ ...rule, re: levelRegExp(rule) }));
    for (const rule of this.user) (rule.childrenOnly ? this.userChildren : this.userSelf).add(rule);
    this.userSelf.finish();
    this.userChildren.finish();
  }

  /**
   * (1) Built-ins: the outermost level any of them matches decides, local before regenerable at one
   * level, so everything under `.dev-env/` is regenerable even when it matches `*.key`. (2) User rules:
   * the first rule matching the path or an ancestor decides; "!" re-includes, but never below a
   * directory an earlier level already ignores. (3) The .gitignore option. (4) Synced (null).
   * Never-ignored names (builtin-rules.ts) are skipped at their own level in every step.
   */
  classify(path: string, isDirectory: boolean, gitIgnored?: GitIgnoredPaths | boolean): IgnoreClass | null {
    if (!path) return null;
    const kind = this.rules.kind;
    const length = path.length;
    let carryLocal = false, carryRegenerable = false;
    for (let start = 0, depth = 1; ; depth++) {
      let end = path.indexOf("/", start);
      if (end < 0) end = length;
      const last = end === length;
      const directory = last ? isDirectory : true;
      const name = start === 0 && last ? path : path.slice(start, end);
      if (!isNeverIgnored(name, kind)) {
        if (carryLocal || this.localSelf.test(path, end, name, depth, directory)) return "local";
        if (carryRegenerable || this.regenerableSelf.test(path, end, name, depth, directory)) return "regenerable";
      }
      if (last) break;
      // A "dir/**" match covers every deeper level, also past a never-ignored name.
      carryLocal ||= this.localChildren.test(path, end, name, depth, true);
      carryRegenerable ||= this.regenerableChildren.test(path, end, name, depth, true);
      start = end + 1;
    }
    const user = this.user;
    if (user.length) {
      let negatedAt = Infinity;
      let carry = false;
      for (let start = 0, depth = 1; ; depth++) {
        let end = path.indexOf("/", start);
        if (end < 0) end = length;
        const last = end === length;
        const directory = last ? isDirectory : true;
        const name = start === 0 && last ? path : path.slice(start, end);
        // The indexes say whether any rule matches this level; only then is the order worked out.
        if ((carry || this.userSelf.test(path, end, name, depth, directory)) && !isNeverIgnored(name, kind)) {
          const level = last ? path : path.slice(0, end);
          const limit = Math.min(user.length, negatedAt);
          for (let index = 0; index < limit; index++) {
            const rule = user[index];
            if ((rule.dirOnly && !directory) || !rule.re.test(level)) continue;
            if (rule.negate) { negatedAt = index; break; }
            return this.worktrees || rule.deletable ? "user-regenerable" : "user";
          }
        }
        if (last) break;
        carry ||= this.userChildren.test(path, end, name, depth, true);
        start = end + 1;
      }
      // An explicit "!" also wins over the .gitignore option.
      if (negatedAt !== Infinity) return null;
    }
    if (this.rules.gitignore && gitIgnored && this.gitIgnoredLevel(path, isDirectory, gitIgnored) !== undefined) return this.worktrees ? "user-regenerable" : "user";
    return null;
  }

  /** Which rule decides, for Settings and diagnostics. A slow reference path: one regex per rule. */
  explain(path: string, isDirectory: boolean, gitIgnored?: GitIgnoredPaths | boolean): IgnoreExplanation | null {
    if (!path) return null;
    const kind = this.rules.kind;
    const compiled = this.compiledBuiltins ??= this.builtins.map(({ rule, pattern }) => ({ rule, pattern, re: levelRegExp(pattern) }));
    const levels = levelsOf(path);
    for (const [index, level] of levels.entries()) {
      if (isNeverIgnored(level.slice(level.lastIndexOf("/") + 1), kind)) continue;
      const directory = index < levels.length - 1 || isDirectory;
      const matches = compiled.filter(({ pattern, re }) => (directory || !pattern.dirOnly) && re.test(level));
      const decisive = matches.find(({ rule }) => rule.class === "local" && !this.worktrees) ?? matches[0];
      if (decisive) return { class: decisive.rule.class === "local" && !this.worktrees ? "local" : "regenerable", rule: decisive.rule.id, level };
    }
    let negated: { rule: CompiledUserRule; index: number } | undefined;
    for (const [levelIndex, level] of levels.entries()) {
      if (isNeverIgnored(level.slice(level.lastIndexOf("/") + 1), kind)) continue;
      const directory = levelIndex < levels.length - 1 || isDirectory;
      const index = this.user.findIndex((rule) => (directory || !rule.dirOnly) && rule.re.test(level));
      if (index < 0 || (negated && negated.index < index)) continue;
      const rule = this.user[index];
      if (rule.negate) { negated = { rule, index }; continue; }
      return { class: this.worktrees || rule.deletable ? "user-regenerable" : "user", rule: rule.line, level };
    }
    if (negated) return null;
    if (this.rules.gitignore && gitIgnored) {
      const level = this.gitIgnoredLevel(path, isDirectory, gitIgnored);
      if (level !== undefined) return { class: this.worktrees ? "user-regenerable" : "user", rule: ".gitignore", level };
    }
    return null;
  }

  /** A superset of every path these rules ignore (the .gitignore option aside), for cheap event filtering. */
  get hint(): RegExp {
    return this.hintCache ??= hintRegExp([...this.builtins.map(({ pattern }) => pattern), ...this.user.filter((rule) => !rule.negate)]);
  }

  /** Top-down, as git descends: an ignored directory covers its subtree, and nothing below it can be re-included. */
  private gitIgnoredLevel(path: string, isDirectory: boolean, gitIgnored: GitIgnoredPaths | boolean): string | undefined {
    if (gitIgnored === true) return isNeverIgnored(path.slice(path.lastIndexOf("/") + 1), this.rules.kind) ? undefined : path;
    if (gitIgnored === false) return undefined;
    for (let end = path.indexOf("/"); ; end = path.indexOf("/", end + 1)) {
      const level = end < 0 ? path : path.slice(0, end);
      if (!isNeverIgnored(level.slice(level.lastIndexOf("/") + 1), this.rules.kind) && gitIgnored.has(level, end < 0 ? isDirectory : true)) return level;
      if (end < 0) return undefined;
    }
  }
}

function levelsOf(path: string): string[] {
  const levels: string[] = [];
  for (let end = path.indexOf("/"); end >= 0; end = path.indexOf("/", end + 1)) levels.push(path.slice(0, end));
  levels.push(path);
  return levels;
}

function hintRegExp(patterns: Pattern[]): RegExp {
  if (!patterns.length) return /(?!)/;
  const sources = [...new Set(patterns.map((pattern) => `${pattern.anchored ? "^" : "(?:^|/)"}${pattern.source}${pattern.childrenOnly ? "/" : "(?:/|$)"}`))];
  return new RegExp(sources.join("|"), regExpFlags(true));
}

export function compileRules(rules: EffectiveRules): IgnoreMatcher { return new IgnoreMatcher(rules); }

let builtinHint: RegExp | undefined;

/**
 * One combined RegExp that matches every path some rule could ignore: with no argument, any built-in
 * of any share kind (whether switched off or not); with effective rules, those rules. A path it does
 * not match is synced (unless the .gitignore option lists it), so the watcher can skip classify.
 */
export function hintPattern(rules?: EffectiveRules): RegExp {
  if (rules) return compileRules(rules).hint;
  return builtinHint ??= hintRegExp(BUILTIN_RULES.map((rule) => parsePattern(rule.pattern)));
}

/**
 * The rules one share uses (§6.4): the project's settings record over its owner's all-projects record.
 * Switched-off built-ins add up; user rules list the project's first so they win on first match; a
 * rule listed in its record's removedUserRules is not in effect. Idempotent, so the worker can call it
 * again on the merged settings it receives in ShareSpec.rules.
 */
export function effectiveRules(kind: ShareKind, project?: Partial<RuleSettings> | null, global?: Partial<RuleSettings> | null): EffectiveRules {
  const disabled = new Set<string>();
  for (const id of [...project?.disabledBuiltins ?? [], ...global?.disabledBuiltins ?? []]) {
    const rule = builtinRule(id);
    if (rule && !rule.locked && (!rule.kinds || rule.kinds.includes(kind))) disabled.add(id);
  }
  const userRules: string[] = [];
  const seen = new Set<string>();
  for (const settings of [project, global]) {
    const removed = new Set((settings?.removedUserRules ?? []).map((line) => line.trim()));
    for (const rule of parseUserRules((settings?.userRules ?? []).filter((line) => !removed.has(line.trim()))).rules) {
      if (seen.has(rule.line)) continue;
      seen.add(rule.line);
      userRules.push(rule.line);
    }
  }
  return { kind, disabledBuiltins: [...disabled].sort(), userRules, gitignore: Boolean(project?.gitignore || global?.gitignore) };
}

/** The RuleSettings form main puts in ShareSpec.rules; effectiveRules(kind, it) returns the same rules. */
export function effectiveRuleSettings(rules: EffectiveRules): RuleSettings {
  return { disabledBuiltins: [...rules.disabledBuiltins], userRules: [...rules.userRules], removedUserRules: [], gitignore: rules.gitignore, importedFrom: [] };
}

/** sha256 of the canonical effective rules, including the built-in patterns in force and BUILTIN_RULES_VERSION. */
export function rulesHash(rules: EffectiveRules): string {
  const effective = effectiveRules(rules.kind, rules);
  const disabled = new Set(effective.disabledBuiltins);
  const builtins = builtinRulesFor(effective.kind).filter((rule) => !disabled.has(rule.id)).map((rule) => rule.pattern);
  const canonical = JSON.stringify({ version: BUILTIN_RULES_VERSION, kind: effective.kind, builtins, userRules: effective.userRules, gitignore: effective.gitignore });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Earlier releases wrote some managed rules without "(?d)"; those forms are managed too. */
function withoutDeletable(rule: string): string { return rule.replace(/^\(\?d\)/, ""); }

const managedSyncthingLines = new Set([...SYNCTHING_PROJECT_PATTERNS, ...SYNCTHING_WORKTREE_PATTERNS].flatMap((rule) => [rule, withoutDeletable(rule)]));

/**
 * The user lines of a node's Syncthing ignore list: exactly setProjectIgnores' filter (src/syncthing.ts),
 * so a line Syncthing already treated as managed (in either list, with or without "(?d)") never comes
 * back as a user rule. Comments, blank lines and #include lines pass through as they do there.
 */
export function userRulesFromSyncthingIgnores(lines: readonly string[] | null | undefined): string[] {
  return [...new Set((lines ?? []).filter((line) => !managedSyncthingLines.has(line)))];
}

/* The .gitignore option, matched here instead of through `git ls-files`: a listing is a snapshot of the
   paths that existed when it ran, so files created later slipped through, and its answer depended on each
   node's .git (tracked files, core.ignorecase, a missing git binary, "dubious ownership"). Only the share's
   own .gitignore files count (no global excludes, no .git/info/exclude), read from the tree, so every node
   holding the same files classifies them alike. Unlike git, a tracked file is no exception, and matching
   is case-sensitive as everywhere else here. */

export interface GitignorePattern { negate: boolean; dirOnly: boolean; basename: boolean; re: RegExp }
export interface GitignoreSource { text: string; fingerprint: string }
interface GitignoreFile { fingerprint: string; patterns: GitignorePattern[] }

const POSIX_CLASSES: Record<string, string> = {
  alnum: "a-zA-Z0-9", alpha: "a-zA-Z", blank: " \\t", cntrl: "\\x00-\\x1f\\x7f", digit: "0-9", graph: "\\x21-\\x7e", lower: "a-z",
  print: "\\x20-\\x7e", punct: "!-\\/:-@\\[-`{-~", space: "\\s", upper: "A-Z", xdigit: "0-9A-Fa-f",
};

/** One name of a gitignore glob: "*", "**" and "?" stay inside it, as git's wildmatch does with WM_PATHNAME. */
function gitNameSource(glob: string): string {
  let out = "";
  for (let index = 0; index < glob.length;) {
    const char = glob[index++];
    if (char === "\\") out += index < glob.length ? literal(glob[index++]) : "\\\\";
    else if (char === "*") { while (glob[index] === "*") index++; out += "[^/]*"; }
    else if (char === "?") out += "[^/]";
    else if (char === "[") {
      let negate = false;
      if (glob[index] === "!" || glob[index] === "^") { negate = true; index++; }
      let body = "";
      // A "]" right after the opening (or its "!") is a member, not the end.
      for (let first = true; index < glob.length && (first || glob[index] !== "]"); first = false) {
        let member = glob[index++];
        if (member === "[" && glob[index] === ":") {
          const close = glob.indexOf(":]", index + 1);
          const named = close > 0 ? POSIX_CLASSES[glob.slice(index + 1, close)] : undefined;
          if (named) { body += named; index = close + 2; continue; }
        }
        const escaped = member === "\\" && index < glob.length;
        if (escaped) member = glob[index++];
        body += member === "-" ? (escaped ? "\\-" : "-") : "\\^[]/".includes(member) ? `\\${member}` : member;
      }
      if (index >= glob.length) throw new RuleSyntaxError("Unclosed [ in pattern");
      index++;
      out += negate ? `[^${body}/]` : `[${body}]`;
    } else out += literal(char);
  }
  return out;
}

/** "**" as a whole name: a leading "**\/" and an inner "/**\/" match any number of folders, a trailing "/**" everything inside. */
function gitPathSource(glob: string): string {
  const names = glob.split("/");
  return names.map((name, index) => {
    const last = index === names.length - 1;
    if (name === "**") return names.length === 1 || last ? ".*" : "(?:.*/)?";
    return gitNameSource(name) + (last ? "" : "/");
  }).join("");
}

/** Trailing spaces go unless escaped with a backslash. */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    let slashes = 0;
    while (end - 2 - slashes >= 0 && line[end - 2 - slashes] === "\\") slashes++;
    if (slashes % 2 === 1) break;
    end--;
  }
  return line.slice(0, end);
}

/** One .gitignore file (gitignore(5)) in file order; a line git could never match is left out. */
export function parseGitignore(text: string): GitignorePattern[] {
  const patterns: GitignorePattern[] = [];
  for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
    let line = trimTrailingSpaces(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    // A "/" at the start or in the middle ties the pattern to the file's own folder; otherwise it matches a name at any depth.
    const basename = !line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    try {
      const glob = line.normalize("NFC");
      patterns.push({ negate, dirOnly, basename, re: new RegExp(`^${basename ? gitNameSource(glob) : gitPathSource(glob)}$`, "su") });
    } catch { /* an unclosed or reversed class: git matches nothing with it either */ }
  }
  return patterns;
}

/**
 * The .gitignore files of one share, read through `load(dir)` ("" is the root) the first time a path
 * below asks, and kept until a scan that sees one change calls invalidate (then looks at that folder
 * again). `has` answers for one level; IgnoreMatcher.classify asks level by level from the top.
 */
export class GitignoreTree implements GitIgnoredPaths {
  private readonly files = new Map<string, GitignoreFile | null>();
  /** Folders decided already: every path below asks about each of them. */
  private readonly folders = new Map<string, boolean>();

  constructor(private readonly load: (dir: string) => GitignoreSource | null) {}

  has(path: string, isDirectory = false): boolean {
    if (!isDirectory) return this.decide(path, false);
    let ignored = this.folders.get(path);
    if (ignored === undefined) { ignored = this.decide(path, true); this.folders.set(path, ignored); }
    return ignored;
  }

  /** Whether `dir`'s .gitignore differs from the one read before (`fingerprint` null: there is none now); false if it was never read. */
  changed(dir: string, fingerprint: string | null): boolean {
    return this.files.has(dir) && (this.files.get(dir)?.fingerprint ?? null) !== fingerprint;
  }

  /** Whether a .gitignore in `dir` was read (then a folder listing checks that it is unchanged). */
  read(dir: string): boolean { return Boolean(this.files.get(dir)); }

  invalidate(dir: string): void {
    this.files.delete(dir);
    this.folders.clear();
  }

  clear(): void {
    this.files.clear();
    this.folders.clear();
  }

  private file(dir: string): GitignoreFile | null {
    let file = this.files.get(dir);
    if (file === undefined) {
      const source = this.load(dir);
      file = source ? { fingerprint: source.fingerprint, patterns: parseGitignore(source.text) } : null;
      this.files.set(dir, file);
    }
    return file;
  }

  /** From the deepest .gitignore up, and in each from its last line up: the first pattern that matches decides. */
  private decide(path: string, isDirectory: boolean): boolean {
    const slash = path.lastIndexOf("/");
    const name = path.slice(slash + 1);
    for (let end = slash; ; end = end > 0 ? path.lastIndexOf("/", end - 1) : -1) {
      const file = this.file(end < 0 ? "" : path.slice(0, end));
      if (file) {
        const relative = end < 0 ? path : path.slice(end + 1);
        for (let index = file.patterns.length - 1; index >= 0; index--) {
          const pattern = file.patterns[index];
          if ((!pattern.dirOnly || isDirectory) && pattern.re.test(pattern.basename ? name : relative)) return !pattern.negate;
        }
      }
      if (end < 0) return false;
    }
  }
}
