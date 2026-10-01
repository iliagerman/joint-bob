import { z } from "zod";
import { isHarnessId } from "./types.js";

export const browserWebUrlSchema = z.string().url().max(8192).refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Only HTTP(S) browser URLs without embedded credentials are permitted");

export const browserIdentitySchema = z.object({
  projectId: z.string().min(1).max(200),
  engine: z.string().refine(isHarnessId, "Invalid harness ID"),
  conversationId: z.string().min(1).max(200),
});
export const browserStartSchema = browserIdentitySchema.extend({
  appNodeId: z.string().uuid(),
  url: browserWebUrlSchema.optional(),
  profileId: z.string().uuid().optional(),
  profileName: z.string().trim().min(1).max(80).optional(),
  skipLoginPause: z.boolean().optional(),
  /** The caller's workspace on its own machine; trusted only from that machine. */
  workspaceId: z.string().min(1).max(200).optional(),
}).refine(value => !(value.profileId && value.profileName), "Choose a profile ID or a new profile name, not both");
export type BrowserStart = z.infer<typeof browserStartSchema>;
export interface BrowserSessionRecord extends BrowserStart {
  id: string;
  state: "running" | "closed" | "interrupted";
  createdAt: string;
  updatedAt: string;
  error?: string;
  restoreOnRestart?: boolean;
  /** The machine whose conversation holds the session, as authenticated when it started. */
  accessNodeId?: string;
}
/** Who is asking to use a profile, as the owning machine verified it. */
export interface BrowserAccess { nodeId: string; projectId: string; conversationId?: string; workspaceId?: string | null }
export const browserLoginRequestSchema = z.object({
  id: z.string().uuid(),
  expectedOrigin: browserWebUrlSchema.refine(value => new URL(value).origin === value, "Expected origin must not include a path, query, or credentials"),
  readySelector: z.string().min(1).max(4096),
  loginSelector: z.string().min(1).max(4096).nullable(),
  label: z.string().trim().min(1).max(80),
  automatic: z.boolean().optional(),
  returnOrigin: browserWebUrlSchema.refine(value => new URL(value).origin === value, "Return origin must not include a path, query, or credentials").optional(),
});
export type BrowserLoginRequest = z.infer<typeof browserLoginRequestSchema>;
export interface BrowserTab { id: string; url: string; title: string; }
export interface BrowserConfiguration { executorNodeId: string | null; originNodeId: string; updatedAt: string; }
export interface BrowserSessionView extends BrowserSessionRecord {
  nodeId: string;
  tabs: BrowserTab[];
  activePageId: string | null;
  profileLabel?: string;
  owner: "agent" | "human";
  loginRequest?: BrowserLoginRequest | null;
  /** Viewer-specific; absent on node-wide metadata responses. */
  canControl?: boolean;
  /** Agent listings only: the conversation's profile grant is gone, so live page
      and account metadata is redacted; the row stays for closing the session. */
  accessRevoked?: boolean;
  fileChooser: boolean;
  fileChooserRequest: { id: string; pageId: string } | null;
  dialog: { id: string; pageId: string; type: string; message: string; defaultValue: string } | null;
  downloads: Array<{ id: string; name: string; ready: boolean; error?: string }>;
}
export interface BrowserProfile { id: string; projectId: string; label: string; createdAt: string; updatedAt: string; persistent?: boolean; /** Origins this profile's tabs have used, most recent first. */ sites?: string[]; /** Present on listings; the access grants that make this profile usable. */ grants?: BrowserProfileGrant[]; }
/**
 * A profile is usable only through its grants. conversation and project grants match
 * from any machine unless nodeId pins them to one; node covers every conversation on a
 * machine; workspace covers one machine's workspace; cluster covers every member machine.
 */
export type BrowserProfileGrantScope = "conversation" | "project" | "workspace" | "node" | "cluster";
export interface BrowserProfileGrant { scope: BrowserProfileGrantScope; projectId?: string; conversationId?: string; workspaceId?: string; nodeId?: string; clusterId?: string; /** The machine that made the grant; a conversation grant shows in Settings only there. */ originNodeId?: string; createdAt: string; }
const grantText = z.string().min(1).max(200);
export const browserProfileGrantInputSchema = z.object({
  scope: z.enum(["conversation", "project", "workspace", "node", "cluster"]),
  projectId: grantText.optional(),
  conversationId: grantText.optional(),
  workspaceId: grantText.optional(),
  nodeId: z.string().uuid().optional(),
  clusterId: z.string().uuid().optional(),
}).strict().refine(value => {
  const has = (key: "projectId" | "conversationId" | "workspaceId" | "nodeId" | "clusterId") => value[key] !== undefined;
  switch (value.scope) {
    case "conversation": return has("projectId") && has("conversationId") && !has("workspaceId") && !has("clusterId");
    case "project": return has("projectId") && !has("conversationId") && !has("workspaceId") && !has("clusterId");
    case "workspace": return has("workspaceId") && has("nodeId") && !has("projectId") && !has("conversationId") && !has("clusterId");
    case "node": return has("nodeId") && !has("projectId") && !has("conversationId") && !has("workspaceId") && !has("clusterId");
    case "cluster": return has("clusterId") && !has("projectId") && !has("conversationId") && !has("workspaceId") && !has("nodeId");
  }
}, "Grant scope does not match its targets");
export type BrowserProfileGrantInput = z.infer<typeof browserProfileGrantInputSchema>;
export interface BrowserCapability { supported: boolean; available: boolean; executable: string | null; reason: string | null; }

const text = z.string().max(100_000);
const selector = z.string().min(1).max(4096);
export const browserCommandSchema = z.discriminatedUnion("action", [
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
  z.object({ action: z.literal("click"), x: z.number().finite().min(0).max(20000), y: z.number().finite().min(0).max(20000), button: z.enum(["left", "right", "middle"]).optional(), clickCount: z.number().int().min(1).max(3).optional() }),
  z.object({ action: z.literal("key"), key: z.string().min(1).max(100) }),
  z.object({ action: z.literal("text"), text }),
  z.object({ action: z.literal("scroll"), x: z.number().finite().min(-20000).max(20000), y: z.number().finite().min(-20000).max(20000) }),
  z.object({ action: z.literal("setViewport"), width: z.number().int().min(320).max(1600), height: z.number().int().min(320).max(2000) }),
  z.object({ action: z.literal("clickElement"), selector }),
  z.object({ action: z.literal("fill"), selector, text, expectedOrigin: browserWebUrlSchema.optional() }),
  z.object({ action: z.literal("select"), selector, values: z.array(z.string().max(4096)).max(100) }),
  z.object({ action: z.literal("check"), selector, checked: z.boolean() }),
  z.object({ action: z.literal("wait"), selector, state: z.enum(["visible", "hidden", "attached", "detached"]).optional() }),
  z.object({ action: z.literal("snapshot") }),
  z.object({ action: z.literal("screenshot") }),
  z.object({ action: z.literal("evaluate"), expression: text }),
  z.object({ action: z.literal("dialog"), requestId: z.string().uuid().optional(), accept: z.boolean(), promptText: z.string().max(10000).optional() }),
  z.object({ action: z.literal("upload"), requestId: z.string().uuid().optional(), selector: selector.optional(), files: z.array(z.object({ name: z.string().min(1).max(255), data: z.string().max(28_000_000) })).min(1).max(25) }),
  z.object({ action: z.literal("saveProfile"), label: z.string().trim().min(1).max(80) }),
  z.object({ action: z.literal("close") }),
]).and(z.object({ expectedPageId: z.string().uuid().optional() }));
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
export type BrowserActor = { kind: "agent"; credentialOrigins?: string[] } | { kind: "human"; id: string };
