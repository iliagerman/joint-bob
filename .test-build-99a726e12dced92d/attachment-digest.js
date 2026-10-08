import { readFile } from "node:fs/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSettings } from "./settings.js";
const MAX_INLINE_FILE_BYTES = 256 * 1024;
const DESCRIBE_PROMPT = [
  "Describe this image for a coding agent that cannot see it.",
  "State what kind of image it is, transcribe all visible text verbatim, and describe the layout, UI state, selected items, errors, and anything unusual.",
  "Be complete and concise. No preamble."
].join(" ");
let runtime;
async function visionModel() {
  runtime ??= ModelRuntime.create();
  const models = await (await runtime).getAvailable();
  const accepting = models.filter((model2) => model2.input.includes("image"));
  const preferred = getSettings().conversationDefaults.pi;
  const model = accepting.find((candidate) => candidate.provider === preferred.provider && candidate.id === preferred.modelId) ?? accepting[0];
  if (!model) throw new Error("No available Pi model accepts images; sign in to a vision-capable model or turn off attachment digest in Settings");
  return { runtime: await runtime, model };
}
async function describeImage(image) {
  const override = process.env.JOINT_BOB_IMAGE_DESCRIBER;
  if (override) {
    const module = await import(override);
    return module.default(image);
  }
  const { runtime: models, model } = await visionModel();
  const reply = await models.complete(model, {
    messages: [{ role: "user", content: [{ type: "text", text: DESCRIBE_PROMPT }, { type: "image", data: image.data, mimeType: image.mimeType }], timestamp: Date.now() }]
  });
  const text = reply.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
  if (!text) throw new Error(`The vision model ${model.provider}/${model.id} returned no description`);
  return text;
}
async function fileText(file) {
  const bytes = await readFile(file);
  if (bytes.length > MAX_INLINE_FILE_BYTES || bytes.subarray(0, 8192).includes(0)) return void 0;
  return bytes.toString("utf8");
}
export {
  describeImage,
  fileText
};
