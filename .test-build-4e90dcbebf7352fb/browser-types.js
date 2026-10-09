import { z } from "zod";
import { isHarnessId } from "./types.js";
const browserWebUrlSchema = z.string().url().max(8192).refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Only HTTP(S) browser URLs without embedded credentials are permitted");
const browserIdentitySchema = z.object({
  projectId: z.string().min(1).max(200),
  engine: z.string().refine(isHarnessId, "Invalid harness ID"),
  conversationId: z.string().min(1).max(200)
});
const browserStartSchema = browserIdentitySchema.extend({
  appNodeId: z.string().uuid(),
  url: browserWebUrlSchema.optional(),
  profileId: z.string().uuid().optional(),
  profileName: z.string().trim().min(1).max(80).optional(),
  skipLoginPause: z.boolean().optional(),
  /** The caller's workspace on its own machine; trusted only from that machine. */
  workspaceId: z.string().min(1).max(200).optional()
}).refine((value) => !(value.profileId && value.profileName), "Choose a profile ID or a new profile name, not both");
const browserLoginRequestSchema = z.object({
  id: z.string().uuid(),
  expectedOrigin: browserWebUrlSchema.refine((value) => new URL(value).origin === value, "Expected origin must not include a path, query, or credentials"),
  readySelector: z.string().min(1).max(4096),
  loginSelector: z.string().min(1).max(4096).nullable(),
  label: z.string().trim().min(1).max(80),
  automatic: z.boolean().optional(),
  returnOrigin: browserWebUrlSchema.refine((value) => new URL(value).origin === value, "Return origin must not include a path, query, or credentials").optional()
});
const grantText = z.string().min(1).max(200);
const browserProfileGrantInputSchema = z.object({
  scope: z.enum(["conversation", "project", "workspace", "node", "cluster"]),
  projectId: grantText.optional(),
  conversationId: grantText.optional(),
  workspaceId: grantText.optional(),
  nodeId: z.string().uuid().optional(),
  clusterId: z.string().uuid().optional()
}).strict().refine((value) => {
  const has = (key) => value[key] !== void 0;
  switch (value.scope) {
    case "conversation":
      return has("projectId") && has("conversationId") && !has("workspaceId") && !has("clusterId");
    case "project":
      return has("projectId") && !has("conversationId") && !has("workspaceId") && !has("clusterId");
    case "workspace":
      return has("workspaceId") && has("nodeId") && !has("projectId") && !has("conversationId") && !has("clusterId");
    case "node":
      return has("nodeId") && !has("projectId") && !has("conversationId") && !has("workspaceId") && !has("clusterId");
    case "cluster":
      return has("clusterId") && !has("projectId") && !has("conversationId") && !has("workspaceId") && !has("nodeId");
  }
}, "Grant scope does not match its targets");
const text = z.string().max(1e5);
const selector = z.string().min(1).max(4096);
const browserCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: browserWebUrlSchema }),
  z.object({ action: z.literal("back") }),
  z.object({ action: z.literal("forward") }),
  z.object({ action: z.literal("reload") }),
  z.object({ action: z.literal("newTab"), url: browserWebUrlSchema.optional() }),
  z.object({ action: z.literal("selectTab"), pageId: z.string().uuid() }),
  z.object({ action: z.literal("closeTab"), pageId: z.string().uuid() }),
  z.object({ action: z.literal("takeControl"), force: z.boolean().optional(), loginRequestId: z.string().uuid().optional() }),
  z.object({ action: z.literal("resumeAgent") }),
  z.object({ action: z.literal("requestLogin"), expectedOrigin: browserLoginRequestSchema.shape.expectedOrigin, readySelector: browserLoginRequestSchema.shape.readySelector, loginSelector: browserLoginRequestSchema.shape.loginSelector.default(null), label: browserLoginRequestSchema.shape.label.default("Sign in") }),
  z.object({ action: z.literal("completeLogin"), requestId: z.string().uuid(), expectedPageId: z.string().uuid() }),
  z.object({ action: z.literal("click"), x: z.number().finite().min(0).max(2e4), y: z.number().finite().min(0).max(2e4), button: z.enum(["left", "right", "middle"]).optional(), clickCount: z.number().int().min(1).max(3).optional() }),
  z.object({ action: z.literal("key"), key: z.string().min(1).max(100) }),
  z.object({ action: z.literal("text"), text }),
  z.object({ action: z.literal("scroll"), x: z.number().finite().min(-2e4).max(2e4), y: z.number().finite().min(-2e4).max(2e4) }),
  z.object({ action: z.literal("setViewport"), width: z.number().int().min(320).max(1600), height: z.number().int().min(320).max(2e3) }),
  z.object({ action: z.literal("clickElement"), selector }),
  z.object({ action: z.literal("fill"), selector, text, expectedOrigin: browserWebUrlSchema.optional() }),
  z.object({ action: z.literal("select"), selector, values: z.array(z.string().max(4096)).max(100) }),
  z.object({ action: z.literal("check"), selector, checked: z.boolean() }),
  z.object({ action: z.literal("wait"), selector, state: z.enum(["visible", "hidden", "attached", "detached"]).optional() }),
  z.object({ action: z.literal("snapshot") }),
  z.object({ action: z.literal("screenshot") }),
  z.object({ action: z.literal("evaluate"), expression: text }),
  z.object({ action: z.literal("dialog"), requestId: z.string().uuid().optional(), accept: z.boolean(), promptText: z.string().max(1e4).optional() }),
  z.object({ action: z.literal("upload"), requestId: z.string().uuid().optional(), selector: selector.optional(), files: z.array(z.object({ name: z.string().min(1).max(255), data: z.string().max(28e6) })).min(1).max(25) }),
  z.object({ action: z.literal("saveProfile"), label: z.string().trim().min(1).max(80) }),
  z.object({ action: z.literal("close") })
]).and(z.object({ expectedPageId: z.string().uuid().optional() }));
export {
  browserCommandSchema,
  browserIdentitySchema,
  browserLoginRequestSchema,
  browserProfileGrantInputSchema,
  browserStartSchema,
  browserWebUrlSchema
};
