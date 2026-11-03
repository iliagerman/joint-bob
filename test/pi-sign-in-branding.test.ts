import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { brandSignInPages } from "../src/harnesses/pi/sign-in-branding.js";

// The Pi this release ships, whose sign-in chunks carry Pi's page as the managed harness's do.
const piChunks = path.resolve("node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "chunks");

test("Claude and ChatGPT sign-in pages show their provider's logo; the rest of Pi's code is untouched", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-branding-"));
  try {
    const chunks = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "chunks");
    await mkdir(chunks, { recursive: true });
    // An ES module folder, so the syntax check below parses the chunks as Pi loads them.
    await writeFile(path.join(chunks, "package.json"), JSON.stringify({ type: "module" }));
    for (const chunk of ["anthropic.js", "openai-codex.js"]) await cp(path.join(piChunks, chunk), path.join(chunks, chunk));
    const before = await readFile(path.join(chunks, "anthropic.js"), "utf8");

    await brandSignInPages(path.join(root, "node_modules"));
    const claude = await readFile(path.join(chunks, "anthropic.js"), "utf8");
    const openai = await readFile(path.join(chunks, "openai-codex.js"), "utf8");
    assert.match(claude, /LOGO_SVG='<svg [^']*data-joint-bob-logo="claude"/);
    assert.match(openai, /LOGO_SVG='<svg [^']*data-joint-bob-logo="openai"/);
    const outside = (source: string) => source.replace(/LOGO_SVG='<svg [^']*<\/svg>'/, "LOGO_SVG=''");
    assert.equal(outside(claude), outside(before), "only the logo string changes");
    for (const chunk of ["anthropic.js", "openai-codex.js"]) execFileSync(process.execPath, ["--check", path.join(chunks, chunk)]);

    const modified = (await stat(path.join(chunks, "anthropic.js"))).mtimeMs;
    await brandSignInPages(path.join(root, "node_modules"));
    assert.equal((await stat(path.join(chunks, "anthropic.js"))).mtimeMs, modified, "an already branded page is left alone");

    await writeFile(path.join(chunks, "anthropic.js"), "export const changed = true;\n");
    await assert.rejects(brandSignInPages(path.join(root, "node_modules")), /no longer defines its sign-in logo/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
