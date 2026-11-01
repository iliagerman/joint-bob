import { z } from "zod";

/** When a rule is checked: before shell commands, before file writes and edits, before content goes to the model, or all of them. */
export const GUARDIAN_CHECKS = ["commands", "file-changes", "outgoing", "all"] as const;
/** What a rule does when the model answers yes. */
export const GUARDIAN_IF_YES = ["ask", "block", "fix"] as const;
/** One choice in place of two thresholds and an "unsure" action. */
export const GUARDIAN_CARE = ["relaxed", "balanced", "cautious"] as const;
export const GUARDIAN_UNSURE = ["ask", "block", "continue"] as const;
/** The decision model every Guardian rule on this machine asks. */
export const GUARDIAN_MODELS = ["jev", "laya-local", "laya-remote"] as const;

export type GuardianCheck = typeof GUARDIAN_CHECKS[number];
export type GuardianCare = typeof GUARDIAN_CARE[number];
export type GuardianModelId = typeof GUARDIAN_MODELS[number];

const fixSchema = z.discriminatedUnion("kind", [
  /** Built in: removes the values of this project's secret accounts and common token formats. */
  z.object({ kind: z.literal("remove-secrets") }).strict(),
  /** Receives the content on stdin and prints its replacement. */
  z.object({ kind: z.literal("script"), command: z.string().trim().min(1).max(1000) }).strict(),
  /** A tool-less model call that rewrites the content by these instructions. */
  z.object({ kind: z.literal("agent"), instructions: z.string().trim().min(1).max(4000) }).strict(),
]);
export type GuardianFix = z.infer<typeof fixSchema>;

export const guardianRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(80),
  question: z.string().trim().min(1).max(1000),
  enabled: z.boolean(),
  check: z.enum(GUARDIAN_CHECKS),
  ifYes: z.enum(GUARDIAN_IF_YES),
  care: z.enum(GUARDIAN_CARE),
  /** "More options": each one replaces what the care level would choose. */
  yesAt: z.number().min(0.01).max(1).nullable(),
  noAt: z.number().min(0).max(0.99).nullable(),
  whenUnsure: z.enum(GUARDIAN_UNSURE).nullable(),
  fix: fixSchema,
}).strict().refine((rule) => rule.yesAt === null || rule.noAt === null || rule.noAt < rule.yesAt, { message: "The no value must be below the yes value", path: ["noAt"] });
export type GuardianRule = z.infer<typeof guardianRuleSchema>;

export const guardianSettingsSchema = z.object({
  enabled: z.boolean(),
  model: z.enum(GUARDIAN_MODELS),
  /** The Laya server for `laya-remote`, for example http://gpu-box:8000. */
  layaUrl: z.string().trim().max(500).refine((value) => value === "" || /^https?:\/\/[^\s/]+/.test(value), "Use an http:// or https:// address"),
  rules: z.array(guardianRuleSchema).max(50).refine((rules) => new Set(rules.map(({ id }) => id)).size === rules.length, "Rule IDs must be unique"),
}).strict().refine((settings) => settings.model !== "laya-remote" || settings.layaUrl !== "", { message: "Enter the Laya server address", path: ["layaUrl"] });
export type GuardianSettings = z.infer<typeof guardianSettingsSchema>;

/**
 * What a relay imposes on its machines. Members cannot turn these rules off or change them. A relay
 * names a model every member can reach, and fixes only with the built-in secret removal: it never
 * runs its own scripts or agents on someone else's machine.
 */
export const guardianRelayPolicySchema = z.object({
  model: z.enum(["jev", "laya-remote"]),
  layaUrl: z.string().trim().max(500),
  rules: z.array(guardianRuleSchema).min(1).max(50)
    .refine((rules) => rules.every((item) => item.enabled && item.fix.kind === "remove-secrets"), "Relay rules must be on and use the built-in secret removal"),
}).strict().refine((policy) => policy.model !== "laya-remote" || /^https?:\/\/[^\s/]+/.test(policy.layaUrl), { message: "A relay using Laya must name a server every machine can reach", path: ["layaUrl"] });
export type GuardianRelayPolicy = z.infer<typeof guardianRelayPolicySchema>;

const rule = (id: string, name: string, question: string, check: GuardianCheck, ifYes: GuardianRule["ifYes"], enabled: boolean): GuardianRule =>
  ({ id, name, question, enabled, check, ifYes, care: "balanced", yesAt: null, noAt: null, whenUnsure: null, fix: { kind: "remove-secrets" } });

/** Ready-made rules a person switches on; Guardian itself starts off. */
export const DEFAULT_GUARDIAN_SETTINGS: GuardianSettings = {
  enabled: false,
  model: "jev",
  layaUrl: "",
  rules: [
    rule("dangerous-commands", "Dangerous commands", "Could this action delete data, or make a change to the system that cannot be undone?", "commands", "ask", true),
    rule("secrets", "Secrets", "Does this contain a password, API key, access token or private key?", "outgoing", "fix", true),
    rule("personal-information", "Personal information", "Does this contain personal information about a real person, such as a name with an address, phone number, email or ID number?", "outgoing", "ask", false),
  ],
};

export type RuleOutcome = "continue" | "ask" | "block" | "fix";

const CARE: Record<GuardianCare, { yesAt: number; noAt: number; unsure: "ask" | "continue" | "yes" }> = {
  // Acts only when the model is very sure; anything less lets the action through.
  relaxed: { yesAt: 0.9, noAt: 0.5, unsure: "continue" },
  // Acts when the model is fairly sure and asks the person when it is not.
  balanced: { yesAt: 0.7, noAt: 0.3, unsure: "ask" },
  // Any doubt counts as yes.
  cautious: { yesAt: 0.5, noAt: 0.15, unsure: "yes" },
};

/** The thresholds a rule acts on: its care level, with any "More options" values in place. */
export function ruleThresholds(rule: GuardianRule): { yesAt: number; noAt: number } {
  const care = CARE[rule.care];
  const yesAt = rule.yesAt ?? care.yesAt;
  return { yesAt, noAt: Math.min(rule.noAt ?? care.noAt, yesAt - 0.01) };
}

/** What one rule says about one answer: the probability that the answer to its question is yes. */
export function ruleOutcome(rule: GuardianRule, probability: number): RuleOutcome {
  const { yesAt, noAt } = ruleThresholds(rule);
  if (probability >= yesAt) return rule.ifYes;
  if (probability <= noAt) return "continue";
  const unsure = rule.whenUnsure ?? CARE[rule.care].unsure;
  return unsure === "yes" ? rule.ifYes : unsure;
}

const SEVERITY: Record<RuleOutcome, number> = { continue: 0, fix: 1, ask: 2, block: 3 };

/** Across rules, and across this machine and every relay: a block wins, then a question, then a fix. */
export function worstOutcome(outcomes: RuleOutcome[]): RuleOutcome {
  return outcomes.reduce<RuleOutcome>((worst, next) => SEVERITY[next] > SEVERITY[worst] ? next : worst, "continue");
}

/** What a tool call does, as far as rules are concerned. */
export type ToolCategory = "commands" | "file-changes" | "other";

export type GuardianRequest =
  | { kind: "tool"; tool: string; category: ToolCategory; input: Record<string, unknown> }
  | { kind: "outgoing"; source: string; text: string };

/** A request from outside the server: a Pi worker or the Claude hook. */
export const guardianRequestSchema: z.ZodType<GuardianRequest> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool"), tool: z.string().min(1).max(200), category: z.enum(["commands", "file-changes", "other"]), input: z.record(z.unknown()) }).strict(),
  z.object({ kind: z.literal("outgoing"), source: z.string().min(1).max(200), text: z.string().max(5_000_000) }).strict(),
]);

export function ruleApplies(rule: GuardianRule, request: GuardianRequest): boolean {
  if (!rule.enabled) return false;
  if (rule.check === "all") return true;
  if (request.kind === "outgoing") return rule.check === "outgoing";
  return rule.check === request.category;
}

const COMMAND_TOOLS = new Set(["bash", "shell", "execute_bash", "execute", "run_command", "terminal"]);
const FILE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "fs_write", "str_replace", "create_file", "apply_patch", "delete", "move"]);

/** Tool names differ by agent (Pi `bash`, Claude `Bash`, Kiro `execute_bash`); the category is what rules use. */
export function toolCategory(tool: string): ToolCategory {
  const name = tool.toLowerCase();
  if (COMMAND_TOOLS.has(name)) return "commands";
  if (FILE_TOOLS.has(name)) return "file-changes";
  return "other";
}
