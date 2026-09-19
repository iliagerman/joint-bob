import { readFile } from "node:fs/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSettings } from "./settings.js";

export interface ImageInput { data: string; mimeType: string; }
export type ImageDescriber = (image: ImageInput) => Promise<string>;

const MAX_INLINE_FILE_BYTES = 256 * 1024;

const DESCRIBE_PROMPT = [
  "Describe this image for a coding agent that cannot see it.",
  "State what kind of image it is, transcribe all visible text verbatim, and describe the layout, UI state, selected items, errors, and anything unusual.",
  "Be complete and concise. No preamble.",
].join(" ");

let runtime: Promise<ModelRuntime> | undefined;

async function visionModel(): Promise<{ runtime: ModelRuntime; model: NonNullable<ReturnType<ModelRuntime["getModel"]>> }> {
  runtime ??= ModelRuntime.create();
  const models = await (await runtime).getAvailable();
  const accepting = models.filter((model) => model.input.includes("image"));
  const preferred = getSettings().conversationDefaults.pi;
  const model = accepting.find((candidate) => candidate.provider === preferred.provider && candidate.id === preferred.modelId) ?? accepting[0];
  if (!model) throw new Error("No available Pi model accepts images; sign in to a vision-capable model or turn off attachment digest in Settings");
  return { runtime: await runtime, model };
}

/**
 * Turns an image into text with this node's Pi models. Tests and fixtures point
 * `JOINT_BOB_IMAGE_DESCRIBER` at a module whose default export plays the model.
 */
export async function describeImage(image: ImageInput): Promise<string> {
  const override = process.env.JOINT_BOB_IMAGE_DESCRIBER;
  if (override) {
    const module = await import(override) as { default: ImageDescriber };
    return module.default(image);
  }
  const { runtime: models, model } = await visionModel();
  const reply = await models.complete(model, {
    messages: [{ role: "user", content: [{ type: "text", text: DESCRIBE_PROMPT }, { type: "image", data: image.data, mimeType: image.mimeType }], timestamp: Date.now() }],
  });
  const text = reply.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
  if (!text) throw new Error(`The vision model ${model.provider}/${model.id} returned no description`);
  return text;
}

/** UTF-8 text of a small file, or undefined for binary or oversized files that stay path-only. */
export async function fileText(file: string): Promise<string | undefined> {
  const bytes = await readFile(file);
  if (bytes.length > MAX_INLINE_FILE_BYTES || bytes.subarray(0, 8192).includes(0)) return undefined;
  return bytes.toString("utf8");
}
