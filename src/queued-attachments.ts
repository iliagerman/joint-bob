import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { QueuedPrompt } from "./prompt-queue.js";

export async function queuedAttachments(cwd: string, prompt: QueuedPrompt) {
  let text = prompt.promptText;
  const localPaths = new Map<string, string>();
  for (const original of prompt.attachmentPaths) {
    if (path.basename(path.dirname(original)) !== ".joint-bob-attachments") throw new Error("Queued attachment path is invalid");
    const root = await realpath(path.join(cwd, ".joint-bob-attachments"));
    const local = await realpath(path.join(root, path.basename(original)));
    if (path.dirname(local) !== root) throw new Error("Queued attachment escapes attachment directory");
    localPaths.set(original, local);
    text = text.replaceAll(original, local);
  }
  const images = await Promise.all(prompt.images.map(async (image) => {
    const local = localPaths.get(image.path);
    if (!local) throw new Error("Queued image is not a retained attachment");
    return { type: "image" as const, data: (await readFile(local)).toString("base64"), mimeType: image.mimeType };
  }));
  return { text, images };
}
