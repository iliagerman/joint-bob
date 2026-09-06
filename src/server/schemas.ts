import path from "node:path";
import { z } from "zod";
import { listHarnesses } from "../harnesses.js";
import { CANVAS_MAX_ROW_HEIGHT, CANVAS_MIN_ROW_HEIGHT, canvasRowGeometryIsLegal } from "../preferences.js";
import { isHarnessId, PROJECT_COLORS } from "../types.js";
import { canonicalClusterUrl, isClusterOriginUrl } from "./http-auth.js";

export const absolutePathSchema = z.string().trim().min(1).max(1000).refine(path.isAbsolute, "Path must be absolute");
export const projectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.string().trim().min(1).max(40).optional().default("personal"),
  path: absolutePathSchema.optional(),
  sourcePath: absolutePathSchema.optional(),
  importMode: z.enum(["copy", "move", "move-link"]).optional(),
  synced: z.boolean().optional(),
  macPath: absolutePathSchema.optional(),
  color: z.enum(PROJECT_COLORS).nullable().optional(),
})
  .refine((payload) => !(payload.path && payload.sourcePath), "Project path and import source cannot both be set")
  .refine((payload) => !payload.sourcePath || payload.importMode, { message: "Choose how to import the project", path: ["importMode"] });
export const projectPathMappingSchema = z.object({
  macPath: absolutePathSchema,
});
export const projectListQuerySchema = z.object({
  syncStatus: z.enum(["true", "false"]).optional().default("true"),
});
const clusterUrlSchema = z.string().url().max(500)
  .refine(isClusterOriginUrl, "Cluster URLs must be an HTTPS origin, except loopback HTTP")
  .transform(canonicalClusterUrl);
export const clusterNodeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: clusterUrlSchema,
});
export const clusterPeerSchema = z.object({
  url: clusterUrlSchema,
  token: z.string().trim().min(1).max(500),
});
export const clusterMembershipMemberSchema = clusterNodeSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  token: z.string().trim().min(1).max(500),
});
const clusterMemberTombstoneSchema = z.object({
  id: z.string().uuid(),
  removedAt: z.string().datetime(),
  originNodeId: z.string().uuid(),
});
export const clusterMembershipSnapshotSchema = z.object({
  members: z.array(clusterMembershipMemberSchema).min(1),
  removed: z.array(clusterMemberTombstoneSchema).max(100).optional().default([]),
});
export const clusterInvitationRedeemSchema = z.object({
  invitationId: z.string().uuid(),
  secret: z.string().trim().min(1).max(500),
  member: clusterMembershipMemberSchema,
});
export const clusterJoinSchema = clusterNodeSchema.extend({
  link: z.string().trim().url().max(1200),
});
export const clusterInvitationRedemptionSchema = z.object({
  inviterNodeId: z.string().uuid(),
  membership: clusterMembershipSnapshotSchema,
});
export const clusterProjectImportSchema = z.object({
  peerId: z.string().uuid(),
});
export const clusterProjectMapSchema = clusterProjectImportSchema.extend({
  projectId: z.string().min(1).max(120),
  localPath: absolutePathSchema,
});
export const clusterSyncShareSchema = z.object({
  folderId: z.string().min(1).max(120),
  deviceId: z.string().min(1).max(120),
  deviceName: z.string().trim().min(1).max(80).optional(),
});
const replicationEventSchema = z.object({
  id: z.string().uuid(),
  originNodeId: z.string().uuid(),
  entityType: z.string().min(1).max(80),
  entityKey: z.string().min(1).max(300),
  operation: z.enum(["upsert", "delete"]),
  payload: z.unknown(),
  createdAt: z.string().datetime(),
});
export const replicationBatchSchema = z.object({ events: z.array(replicationEventSchema).max(100) });
export const replicationReceiptSchema = z.object({ received: z.array(z.string().uuid()).max(100) });
export const registeredHarnessIdSchema = z.string().refine(isHarnessId, "Harness ID is invalid")
  .refine((value) => listHarnesses().some((harness) => harness.id === value), "Harness is not registered on this node");
const runtimeLeaseSchema = z.object({
  engine: registeredHarnessIdSchema,
  sessionId: z.string().min(1).max(200),
  ownershipEpoch: z.number().int().positive(),
  runId: z.string().min(1).max(200),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export const runtimeSnapshotSchema = z.object({
  nodeId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  leases: z.array(runtimeLeaseSchema).max(500),
});
export const directoryBrowseSchema = z.object({
  path: absolutePathSchema.optional(),
});
export const TEXT_FILE_LIMIT = 1_048_576;
export const projectFileUpdateSchema = z.object({
  content: z.string().max(TEXT_FILE_LIMIT),
  version: z.string().regex(/^[0-9a-f]{64}$/),
  sessionId: z.string().min(1).max(240),
}).strict();
export const sessionTakeOwnershipSchema = z.object({
  peerId: z.string().uuid(),
  sessionId: z.string().min(1).max(240).optional(),
  sessionPath: z.string().min(1),
  sessionName: z.string().trim().max(120).optional(),
});
export const routedSessionTakeOwnershipSchema = sessionTakeOwnershipSchema.extend({ projectId: z.string().min(1) });
export const ownershipSchema = z.object({
  engine: registeredHarnessIdSchema, sessionId: z.string().min(1).max(240), ownerNodeId: z.string().uuid(),
  epoch: z.number().int().positive(), status: z.enum(["claiming", "owned", "recovering", "transferring", "conflict"]), transferToNodeId: z.string().uuid().nullable(),
});
const nullableOwnershipSchema = ownershipSchema.nullable();
export const ownershipClaimSchema = z.object({ engine: registeredHarnessIdSchema, sessionId: z.string().min(1).max(240), ownerNodeId: z.string().uuid() });
export const ownershipCasSchema = z.object({ expected: nullableOwnershipSchema, proposed: ownershipSchema, originNodeId: z.string().uuid() });
export const sessionRecoverySchema = z.object({ engine: z.literal("pi"), sessionId: z.string().min(1).max(240), sessionPath: z.string().min(1).max(2000) });
const secretCredentialEventSchema = z.object({
  id: z.string().uuid(),
  entityKey: z.string().uuid(),
  operation: z.literal("upsert"),
  value: z.object({
    label: z.string().trim().min(1).max(64),
    provider: z.enum(["aws", "google", "github", "custom"]),
    variables: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), kind: z.enum(["value", "file"]), value: z.string().max(100000) }).strict()).min(1).max(20),
    workspaceIds: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
  }).strict(),
  updatedAt: z.string().datetime(),
  originNodeId: z.string().uuid(),
  createdAt: z.string().datetime(),
}).strict();
export const secretCredentialBatchSchema = z.object({ events: z.array(secretCredentialEventSchema).max(100) });
export const secretCredentialSyncSchema = z.object({ peerIds: z.array(z.string().uuid()).min(1).max(50) });
export const socketSecretAccountIdsSchema = z.array(z.string().uuid()).max(100);
const secretVariableSchema = z.object({ name: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), kind: z.enum(["value", "file"]), value: z.string().max(100000).optional() }).strict();
export const secretAccountSchema = z.object({ id: z.string().uuid().optional(), label: z.string().trim().min(1).max(64).refine((value) => !/[\x00-\x1f\x7f]/.test(value), "Secret account label cannot contain control characters"), provider: z.enum(["aws", "google", "github", "custom"]), replicate: z.boolean().optional(), variables: z.array(secretVariableSchema).min(1).max(20) }).strict();
export const secretScopeParamsSchema = z.object({ scopeType: z.enum(["workspace", "project", "conversation"]), scopeId: z.string().trim().min(1).max(300) });
export const secretScopeSchema = z.object({ accountIds: z.array(z.string().uuid()).max(100) }).strict();
const taskStatusSchema = z.enum(["backlog", "planning", "in_progress", "review", "done"]);
const taskEngineSchema = registeredHarnessIdSchema;
const taskPhaseConfigSchema = z.object({
  engine: taskEngineSchema,
  provider: z.string().max(80).optional().default(""),
  modelId: z.string().max(200).optional().default(""),
  effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]).optional().default("default"),
});
const taskPhaseConfigMapSchema = z.object({
  planning: taskPhaseConfigSchema.optional(),
  in_progress: taskPhaseConfigSchema.optional(),
  review: taskPhaseConfigSchema.optional(),
}).optional();
export const projectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  type: z.string().trim().min(1).max(40).optional(),
  color: z.enum(PROJECT_COLORS).nullable().optional(),
}).refine(
  (payload) => payload.name !== undefined || payload.type !== undefined || payload.color !== undefined,
  "Provide a project name, type, or color",
);
export const projectLockSchema = z.object({ locked: z.boolean() });
export const sessionTitleSchema = z.object({
  sessionId: z.string().min(1),
  engine: registeredHarnessIdSchema,
  title: z.string().trim().max(200),
});
export const sessionColorSchema = z.object({
  sessionId: z.string().min(1),
  engine: registeredHarnessIdSchema,
  color: z.enum(PROJECT_COLORS).nullable(),
});
export const userPinSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectId: z.string().trim().min(1).max(120), pinned: z.boolean() }).strict(),
  z.object({ kind: z.literal("conversation"), projectId: z.string().trim().min(1).max(120), engine: registeredHarnessIdSchema, sessionId: z.string().trim().min(1).max(240), pinned: z.boolean() }).strict(),
]);
export const recentSessionSchema = z.object({
  projectId: z.string().trim().min(1).max(120), engine: registeredHarnessIdSchema, sessionId: z.string().trim().min(1).max(240),
  sessionPath: z.string().trim().min(1).max(2000), title: z.string().max(300), openedAt: z.string().datetime(), updatedAt: z.string().datetime().nullable(),
}).strict();
export const recentSessionIdentitySchema = recentSessionSchema.pick({ projectId: true, engine: true, sessionId: true });
export const socketTaskIdSchema = z.string().trim().min(1).max(120);
export const sessionDeleteSchema = z.object({ projectId: z.string().min(1), engine: registeredHarnessIdSchema, sessionId: z.string().uuid(), taskId: socketTaskIdSchema.optional() });
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const attachmentDataSchema = z.string()
  .min(1)
  .max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
  .superRefine((data, context) => {
    const decoded = Buffer.from(data, "base64");
    if (decoded.toString("base64") !== data) context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid base64 attachment data" });
    if (decoded.byteLength > MAX_ATTACHMENT_BYTES) context.addIssue({ code: z.ZodIssueCode.custom, message: "Attachment exceeds 4 MB" });
  });
const imageAttachmentSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(120),
  data: attachmentDataSchema,
});
const fileAttachmentSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(120),
  data: attachmentDataSchema,
});
export const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20_000),
  status: taskStatusSchema.optional(),
  engine: taskEngineSchema.optional(),
  planMode: z.boolean().optional(),
  reviewMode: z.boolean().optional(),
  phaseConfig: taskPhaseConfigMapSchema,
  images: z.array(imageAttachmentSchema).max(4).optional(),
  files: z.array(fileAttachmentSchema).max(6).optional(),
});
export const taskHandoffSchema = z.object({ peerId: z.string().uuid() });
const taskBranchBundleSchema = z.object({ data: z.string().min(1).max(12_000_000), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const preparedTaskSchema = z.object({ projectId: z.string().min(1), task: z.unknown(), handoffId: z.string().uuid(), handoffContext: z.string().max(500_000), handoffVersion: z.string().datetime(), bundle: taskBranchBundleSchema.nullable() });
export const taskEligibilitySchema = z.object({ projectId: z.string().min(1), task: z.unknown(), source: z.boolean().optional().default(false) });
export const taskHandoffActionSchema = z.object({ handoffId: z.string().uuid() });
export const taskHandoffDeletionSchema = z.object({ updatedAt: z.string().datetime(), originNodeId: z.string().uuid() });
export const taskHandoffStatusSchema = taskHandoffActionSchema;
export const routedTaskUpdateSchema = z.object({ projectId: z.string().min(1), taskId: z.string().min(1), update: z.unknown() });
export const routedTaskSchema = z.object({ projectId: z.string().min(1), taskId: z.string().min(1) });
export const routedTaskHandoffSchema = routedTaskSchema.extend({ peerId: z.string().uuid() });
export const taskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(20_000).optional(),
  status: taskStatusSchema.optional(),
  engine: taskEngineSchema.optional(),
  planMode: z.boolean().optional(),
  reviewMode: z.boolean().optional(),
  phaseConfig: taskPhaseConfigMapSchema,
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
  images: z.array(imageAttachmentSchema).max(4).optional(),
  files: z.array(fileAttachmentSchema).max(6).optional(),
});
const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export const pushSubscribeSchema = z.object({
  subscription: pushSubscriptionSchema,
  projectId: z.string().min(1),
  sessionPath: z.string().min(1),
  title: z.string().trim().max(120).optional(),
});
export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});
export const sessionReviewedSchema = z.object({
  sessionPath: z.string().trim().min(1).max(2000),
  updatedAt: z.string().datetime(),
}).strict();
export const sessionsReviewedSchema = z.object({
  sessions: z.array(sessionReviewedSchema).min(1).max(500),
}).strict();
export const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});
export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});
export const runtimeSettingsSchema = z.object({
  executable: z.string().max(1000),
  configPath: z.string().max(1000),
  sessionPath: z.string().max(1000),
}).strict();
export const runtimeCheckSchema = z.object({ pi: runtimeSettingsSchema, claude: runtimeSettingsSchema }).strict();
export const resourcePathsSchema = z.object({ skills: z.array(absolutePathSchema).max(20), prompts: z.array(absolutePathSchema).max(20), rules: z.array(absolutePathSchema).max(20), plugins: z.array(absolutePathSchema).max(20) }).strict();
export const settingsSchema = z.object({
  pi: runtimeSettingsSchema,
  claude: runtimeSettingsSchema,
  syncthing: z.object({ endpoint: z.string().max(500), apiKey: z.string().max(500).nullable().optional() }),
  projects: z.object({
    homePath: z.string().max(1000).optional(),
    rootPath: z.string().max(1000).optional(),
    personalRootPath: z.string().max(1000).optional(),
    workRootPath: z.string().max(1000).optional(),
  }).optional(),
  resources: resourcePathsSchema.optional(),
});
export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});
const canvasPanePreferenceSchema = z.object({
  kind: z.literal("pane"),
  id: z.string().min(1).max(200),
  projectId: z.string().trim().min(1).max(120),
  sessionPath: z.string().trim().min(1).max(2000),
  sessionId: z.string().trim().min(1).max(200),
  executionNodeId: z.string().uuid().nullable(),
}).strict();
const canvasRowPreferenceSchema = z.object({
  id: z.string().min(1).max(200),
  height: z.number().finite().min(CANVAS_MIN_ROW_HEIGHT).max(CANVAS_MAX_ROW_HEIGHT).nullable().optional(),
  weights: z.array(z.number().finite().positive()).min(1).max(8).optional(),
  panes: z.array(canvasPanePreferenceSchema).min(1).max(8),
}).strict();
interface CanvasSplitInput {
  kind: "split";
  id: string;
  axis: "row" | "column";
  ratio: number;
  first: z.infer<typeof canvasPanePreferenceSchema> | CanvasSplitInput;
  second: z.infer<typeof canvasPanePreferenceSchema> | CanvasSplitInput;
}
const canvasNodePreferenceSchema: z.ZodType<z.infer<typeof canvasPanePreferenceSchema> | CanvasSplitInput> = z.lazy(() => z.union([
  canvasPanePreferenceSchema,
  z.object({
    kind: z.literal("split"),
    id: z.string().min(1).max(200),
    axis: z.enum(["row", "column"]),
    ratio: z.number().finite().min(0.15).max(0.85),
    first: canvasNodePreferenceSchema,
    second: canvasNodePreferenceSchema,
  }).strict(),
]));
const canvasLayoutV1Schema = z.object({
  version: z.literal(1),
  root: canvasNodePreferenceSchema.nullable(),
  focusedPaneId: z.string().min(1).max(200).nullable(),
}).strict();
const canvasLayoutV6Schema = z.object({
  version: z.literal(6),
  pages: z.array(z.object({
    id: z.string().min(1).max(200), name: z.string().trim().min(1).max(80),
    root: canvasNodePreferenceSchema.nullable(), focusedPaneId: z.string().min(1).max(200).nullable(),
    projectFilter: z.string().max(120),
  }).strict()).min(1).max(9),
  activePageId: z.string().min(1).max(200),
}).strict();
const canvasLayoutPreferenceSchema = z.union([
  canvasLayoutV1Schema,
  canvasLayoutV6Schema,
  z.object({
    version: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    rows: z.array(canvasRowPreferenceSchema).max(10),
    focusedPaneId: z.string().min(1).max(200).nullable(),
  }).strict(),
]).superRefine((layout, context) => {
  const ids = new Set<string>();
  const sessionIdentities = new Set<string>();
  const pathIdentities = new Set<string>();
  const paneIds = new Set<string>();
  const pane = (node: { id: string; kind: string; projectId?: string; sessionId?: string; sessionPath?: string }) => {
    if (ids.has(node.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Canvas ids must be unique" });
    ids.add(node.id);
    if (node.kind !== "pane") return;
    paneIds.add(node.id);
    const identity = `${node.projectId}\0${node.sessionId}`;
    const pathIdentity = `${node.projectId}\0${node.sessionPath!.replace(/\.sync-conflict-[^/\\]+(?=\.jsonl$)/, "")}`;
    if (sessionIdentities.has(identity) || pathIdentities.has(pathIdentity)) context.addIssue({ code: z.ZodIssueCode.custom, message: "A conversation can appear on the canvas only once" });
    sessionIdentities.add(identity);
    pathIdentities.add(pathIdentity);
  };
  const walk = (node: z.infer<typeof canvasPanePreferenceSchema> | CanvasSplitInput, depth: number): void => {
    pane(node);
    if (node.kind === "split") {
      if (depth >= 8) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Canvas splits cannot nest deeper than eight levels" });
        return;
      }
      walk(node.first, depth + 1);
      walk(node.second, depth + 1);
    }
  };
  if (layout.version === 1 && layout.root) walk(layout.root, 1);
  if (layout.version === 6) {
    if (!layout.pages.some((page) => page.id === layout.activePageId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Active canvas page is unknown" });
    const pagePaneIds = (node: z.infer<typeof canvasNodePreferenceSchema> | null, result = new Set<string>()) => {
      if (!node) return result;
      if (node.kind === "pane") result.add(node.id);
      else { pagePaneIds(node.first, result); pagePaneIds(node.second, result); }
      return result;
    };
    for (const page of layout.pages) {
      if (ids.has(page.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Canvas ids must be unique" });
      ids.add(page.id);
      const before = paneIds.size;
      if (page.root) walk(page.root, 1);
      if (paneIds.size - before > 8) context.addIssue({ code: z.ZodIssueCode.custom, message: "A canvas page holds at most eight conversations" });
      if (page.focusedPaneId && !pagePaneIds(page.root).has(page.focusedPaneId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Focused canvas pane is unknown" });
    }
    return;
  }
  if (layout.version !== 1) for (const row of layout.rows) {
    if (ids.has(row.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Canvas ids must be unique" });
    ids.add(row.id);
    if (layout.version === 5 && (!row.weights || row.weights.length !== row.panes.length
      || !canvasRowGeometryIsLegal({ height: row.height, weights: row.weights }))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Canvas row geometry is out of range" });
    }
    for (const item of row.panes) pane(item);
  }
  if (layout.focusedPaneId && !paneIds.has(layout.focusedPaneId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Focused canvas pane is unknown" });
});
const canvasKeymapKeySchema = z.string().trim().regex(/^[0-9A-Za-z]$/).nullable();
const canvasKeymapPreferenceSchema = z.object({
  // Shift alone would swallow every capital letter typed in a canvas conversation.
  modifiers: z.array(z.enum(["meta", "ctrl", "alt", "shift"])).min(1).max(4)
    .refine((modifiers) => modifiers.some((name) => name !== "shift"), "A canvas chord needs Command, Control, or Option"),
  recentPane: canvasKeymapKeySchema,
  focusPane: canvasKeymapKeySchema,
  paneSearch: canvasKeymapKeySchema,
  // Optional: a client that predates this command simply never sends it, and the
  // normalizer gives it its default key.
  toggleView: canvasKeymapKeySchema.optional(),
});
export const userPreferencesSchema = z.object({
  theme: z.enum(["light", "dark"]).nullable().optional(),
  notificationsEnabled: z.boolean().optional(),
  completionSound: z.enum(["off", "chime", "bell"]).optional(),
  installDismissed: z.boolean().optional(),
  mobileView: z.enum(["projects", "sessions", "board", "chat", "canvas"]).optional(),
  activeProjectId: z.string().trim().min(1).max(120).nullable().optional(),
  activeSessionPath: z.string().trim().min(1).max(2000).nullable().optional(),
  activeSessionId: z.string().trim().min(1).max(200).nullable().optional(),
  activeNodeId: z.string().uuid().nullable().optional(),
  legacyMigrated: z.boolean().optional(),
  pinnedProjectIds: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  pinnedSessionPaths: z.array(z.string().trim().min(1).max(2000)).max(200).optional(),
  projectsPanelCollapsed: z.boolean().optional(),
  chatsPanelCollapsed: z.boolean().optional(),
  lastSeenVersion: z.string().trim().regex(/^\d+\.\d+\.\d+$/).nullable().optional(),
  canvasLayout: canvasLayoutPreferenceSchema.optional(),
  canvasKeymap: canvasKeymapPreferenceSchema.optional(),
}).strict();
export const socketMessageSchema = z.object({
  type: z.string().max(40),
  message: z.string().max(100_000).optional(),
  name: z.string().trim().max(120).optional(),
  provider: z.string().max(80).optional(),
  modelId: z.string().max(200).optional(),
  level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  engine: registeredHarnessIdSchema.optional(),
  effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]).optional(),
  images: z.array(imageAttachmentSchema).max(4).optional(),
  files: z.array(fileAttachmentSchema).max(6).optional(),
  safeguardsEnabled: z.boolean().optional(),
  toolNames: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
});
