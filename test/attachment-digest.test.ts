import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describeImage, fileText } from "../src/attachment-digest.js";
import { queuedAttachments } from "../src/queued-attachments.js";
import type { QueuedPrompt } from "../src/prompt-queue.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

async function fixture(): Promise<{ root: string; prompt: QueuedPrompt; image: string; notes: string; binary: string }> {
  // Attachment paths are resolved through realpath, so the fixture compares against real paths too.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "joint-bob-attachment-digest-")));
  const attachments = path.join(root, ".joint-bob-attachments");
  await mkdir(attachments);
  const image = path.join(attachments, "shot.png");
  const notes = path.join(attachments, "notes.md");
  const binary = path.join(attachments, "blob.bin");
  await writeFile(image, png);
  await writeFile(notes, "# Notes\nRemember the login flow.\n");
  await writeFile(binary, Buffer.from([0, 1, 2, 0, 255]));
  const promptText = `Look at this\n\nImage attachments:\n- shot.png: ${image}\nAnalyze them alongside the request.\n\nFile attachments:\n- notes.md: ${notes}\n- blob.bin: ${binary}\nOpen these files from their paths when needed.`;
  const prompt = {
    id: "q1", revision: 1, promptText, displayText: "Look at this", attachmentPaths: [image, notes, binary],
    images: [{ path: image, mimeType: "image/png" }],
  } as unknown as QueuedPrompt;
  return { root, prompt, image, notes, binary };
}

test("without a describer the prompt keeps its raw image bytes and file paths", async () => {
  const { root, prompt, image } = await fixture();
  try {
    const result = await queuedAttachments(root, prompt);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].data, png.toString("base64"));
    assert.ok(result.text.includes(image));
    assert.ok(!result.text.includes("Remember the login flow"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("with a describer the prompt carries the description and file text instead of image bytes", async () => {
  const { root, prompt, image, notes, binary } = await fixture();
  try {
    const seen: Array<{ data: string; mimeType: string }> = [];
    const result = await queuedAttachments(root, prompt, async (input) => { seen.push(input); return "A login form with an error banner reading Invalid password."; });
    assert.deepEqual(result.images, []);
    assert.deepEqual(seen, [{ data: png.toString("base64"), mimeType: "image/png" }]);
    assert.ok(result.text.includes(`Description of ${image}`));
    assert.ok(result.text.includes("Invalid password"));
    assert.ok(result.text.includes(`Contents of ${notes}`));
    assert.ok(result.text.includes("Remember the login flow"));
    assert.ok(!result.text.includes(`Contents of ${binary}`), "binary files stay path-only");
    assert.ok(result.text.includes(binary), "the binary path is still listed for the agent");
    assert.ok(result.text.startsWith("Look at this"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a describer failure fails the prompt instead of silently sending the raw image", async () => {
  const { root, prompt } = await fixture();
  try {
    await assert.rejects(queuedAttachments(root, prompt, async () => { throw new Error("No available model accepts images"); }), /No available model accepts images/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fileText inlines UTF-8 text and skips binary or oversized files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-file-text-"));
  try {
    const text = path.join(root, "a.txt");
    const binary = path.join(root, "b.bin");
    const large = path.join(root, "c.txt");
    await writeFile(text, "hello\n");
    await writeFile(binary, Buffer.from([1, 2, 0, 3]));
    await writeFile(large, "x".repeat(256 * 1024 + 1));
    assert.equal(await fileText(text), "hello\n");
    assert.equal(await fileText(binary), undefined);
    assert.equal(await fileText(large), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("describeImage honours the describer module override used by fixtures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-describer-"));
  const module = path.join(root, "describer.mjs");
  await writeFile(module, "export default async (image) => `fixture saw ${image.mimeType} ${image.data.length} chars`;\n");
  const previous = process.env.JOINT_BOB_IMAGE_DESCRIBER;
  process.env.JOINT_BOB_IMAGE_DESCRIBER = module;
  try {
    assert.equal(await describeImage({ data: "abcd", mimeType: "image/png" }), "fixture saw image/png 4 chars");
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_IMAGE_DESCRIBER;
    else process.env.JOINT_BOB_IMAGE_DESCRIBER = previous;
    await rm(root, { recursive: true, force: true });
  }
});
