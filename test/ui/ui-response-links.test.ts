import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("response URLs are clickable in prose, inline code and fenced code", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-response-links-"));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage();
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    // Only loopback fixture traffic, including the destination opened by the link.
    const destination = `${node.url}/?response-link-test=1`;
    const result = await page.evaluate(async (destination) => {
      const { renderMarkdown } = await import("/markdown.js");
      const host = document.createElement("div");
      host.id = "response-link-fixture";
      document.body.replaceChildren(host);
      const source = `HTTPS works: \`${destination}\` loads the instance.\n\nVisit ${destination}.\n\n\`curl ${destination} && echo \\*literal\\*\`\n\n\`javascript:alert(1)\`\n\n\`src/server.ts\`\n\n\`\`\`sh\ncurl ${destination}\necho \\*literal\\*\n\`\`\``;
      renderMarkdown(host, source + `\n\n[\`${destination}\`](${destination})`, { resolveFileUrl(file: string) { return `/files/${file}`; } });
      return {
        links: [...host.querySelectorAll<HTMLAnchorElement>('a:not([data-file-path])')].map(a => ({ href: a.href, target: a.target, rel: a.rel })),
        code: [...host.querySelectorAll("code")].map(code => code.textContent),
        file: host.querySelector<HTMLAnchorElement>("a[data-file-path]")?.dataset.filePath,
        unsafeLinks: host.querySelectorAll('a[href^="javascript:"]').length,
        nestedLinks: host.querySelectorAll("a a").length,
      };
    }, destination);
    assert.equal(result.links.length, 5, "every URL, including URLs inside code, must be linked");
    for (const link of result.links) {
      assert.equal(link.href, destination);
      assert.equal(link.target, "_blank");
      assert.equal(link.rel, "noopener noreferrer");
    }
    assert.deepEqual(result.code, [destination, `curl ${destination} && echo \\*literal\\*`, "javascript:alert(1)", "src/server.ts", `curl ${destination}\necho \\*literal\\*`, destination]);
    assert.equal(result.file, "src/server.ts");
    assert.equal(result.unsafeLinks, 0);
    assert.equal(result.nestedLinks, 0, "explicit Markdown link labels must not create nested anchors");
    const opened = page.waitForEvent("popup");
    await page.locator("#response-link-fixture p code a").first().click();
    const popup = await opened;
    await popup.waitForURL(destination);
    assert.equal(popup.url(), destination, "clicking the inline-code URL opens it in the browser");
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
