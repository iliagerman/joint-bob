import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileText, type ImageDescriber } from "./attachment-digest.js";
import type { QueuedPrompt } from "./prompt-queue.js";

/**
 * Resolves a queued prompt's attachments for the harness. Without a describer the
 * images travel as bytes. With one, each image becomes a description and each
 * text file its contents, so the harness never holds the raw image in its history;
 * the paths stay in the prompt for an agent that needs the original.
 */
export async function queuedAttachments(cwd: string, prompt: QueuedPrompt, describe?: ImageDescriber) {
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
    return { type: "image" as const, data: (await readFile(local)).toString("base64"), mimeType: image.mimeType, path: local };
  }));
  if (!describe) return { text, images: images.map(({ type, data, mimeType }) => ({ type, data, mimeType })) };
  const digests: string[] = [];
  for (const image of images) digests.push(`Description of ${image.path} (Joint Bob described it; open the path only if you need more detail):\n${await describe({ data: image.data, mimeType: image.mimeType })}`);
  const imagePaths = new Set(images.map((image) => image.path));
  for (const local of localPaths.values()) {
    if (imagePaths.has(local)) continue;
    const contents = await fileText(local);
    if (contents !== undefined) digests.push(`Contents of ${local}:\n${contents}`);
  }
  return { text: [text, ...digests].join("\n\n"), images: [] };
}
