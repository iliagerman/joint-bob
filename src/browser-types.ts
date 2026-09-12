import { z } from "zod";

export const browserWebUrlSchema = z.string().url().max(8192).refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Only HTTP(S) browser URLs without embedded credentials are permitted");

export const browserIdentitySchema = z.object({
  projectId: z.string().min(1).max(200),
  engine: z.enum(["pi", "claude"]),
  conversationId: z.string().min(1).max(200),
});
export const browserStartSchema = browserIdentitySchema.extend({
  appNodeId: z.string().uuid(),
  url: browserWebUrlSchema.optional(),
  profileId: z.string().uuid().optional(),
  profileName: z.string().trim().min(1).max(80).optional(),
}).refine(value => !(value.profileId && value.profileName), "Choose a profile ID or a new profile name, not both");
export type BrowserStart = z.infer<typeof browserStartSchema>;
export interface BrowserSessionRecord extends BrowserStart {
  id: string;
  state: "running" | "closed" | "interrupted";
  createdAt: string;
  updatedAt: string;
  error?: string;
  restoreOnRestart?: boolean;
}
export interface BrowserTab { id: string; url: string; title: string; }
export interface BrowserConfiguration { executorNodeId: string | null; originNodeId: string; updatedAt: string; }
export interface BrowserSessionView extends BrowserSessionRecord {
  nodeId: string;
  tabs: BrowserTab[];
  activePageId: string | null;
  profileLabel?: string;
  owner: "agent" | "human";
  /** Viewer-specific; absent on node-wide metadata responses. */
  canControl?: boolean;
  fileChooser: boolean;
  fileChooserRequest: { id: string; pageId: string } | null;
  dialog: { id: string; pageId: string; type: string; message: string; defaultValue: string } | null;
  downloads: Array<{ id: string; name: string; ready: boolean; error?: string }>;
}
export interface BrowserProfile { id: string; projectId: string; label: string; createdAt: string; updatedAt: string; persistent?: boolean; }
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
  z.object({ action: z.literal("takeControl"), force: z.boolean().optional() }),
  z.object({ action: z.literal("resumeAgent") }),
  z.object({ action: z.literal("click"), x: z.number().finite().min(0).max(20000), y: z.number().finite().min(0).max(20000), button: z.enum(["left", "right", "middle"]).optional(), clickCount: z.number().int().min(1).max(3).optional() }),
  z.object({ action: z.literal("key"), key: z.string().min(1).max(100) }),
  z.object({ action: z.literal("text"), text }),
  z.object({ action: z.literal("scroll"), x: z.number().finite().min(-20000).max(20000), y: z.number().finite().min(-20000).max(20000) }),
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
export type BrowserActor = { kind: "agent" } | { kind: "human"; id: string };
