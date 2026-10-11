import { z } from "zod";

/** Who wrote a user message. A leaf module: the queue and the author store both use it. */
export const messageAuthorSchema = z.object({
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  email: z.string().max(254).nullable(),
  username: z.string().min(1).max(80),
  homeNodeId: z.string().max(64).nullable(),
}).strict();
export type MessageAuthor = z.infer<typeof messageAuthorSchema>;
