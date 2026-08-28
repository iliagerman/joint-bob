import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("loaded transcripts keep the tool role and tool name instead of flattening them into chat text", async () => {
  const [piService, types, server] = await Promise.all([
    readFile("src/pi-service.ts", "utf8"),
    readFile("src/types.ts", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  // ChatMessage carries the tool label so the client can render a tool bubble.
  assert.match(types, /export interface ChatMessage \{[\s\S]*toolName\?: string;[\s\S]*\}/);
  assert.match(piService, /simplifyMessages[\s\S]*toolName/);
  // The cluster transfer payload must not reject the new field.
  assert.match(server, /messages: z\.array\(z\.object\(\{[\s\S]*toolName: z\.string\(\)[\s\S]*\)\)/);
});

test("history rendering routes each transcript role to its own bubble", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /function appendTranscript\(/);
  // Tool results become collapsed monospace tool bubbles, never markdown prose.
  assert.match(app, /appendTranscript[\s\S]*toolResult[\s\S]*appendToolMessage/);
  // The old "loop every message straight into a chat bubble" mapping is gone.
  assert.doesNotMatch(app, /for \(const message of payload\.messages/);
  // Both transcript entry points use the shared renderer.
  assert.equal(app.match(/appendTranscript\(payload\.messages\)/g)?.length, 2);
});

test("assistant filesystem paths open through the authenticated project file route", async () => {
  const [app, markdown, server, serviceWorker] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/markdown.js", "utf8"),
    readFile("src/server.ts", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);

  assert.match(markdown, /const FILE_PATH_RE/);
  assert.match(markdown, /dataset\.testid = "chat-file-link"/);
  assert.match(markdown, /const linksToFile = Boolean\(resolveFileUrl\) && isFilePath\(groups\.url\)/);
  assert.match(app, /resolveFileUrl: role === "assistant" \? projectFileUrl : undefined/);
  assert.match(app, /download \? `\$\{url\}&download=1` : url/);
  assert.match(server, /request\.query\.download === "1" \? "attachment" : "inline"/);
  assert.match(server, /resolved = await realpath\(requestedFile\)/);
  assert.match(server, /requestedPath\.replace\(\/\^\[\/\\\\\]\+\//);
  assert.match(server, /File is outside the project directory/);
  assert.match(serviceWorker, /const CACHE_NAME = "joint-bob-v42"/);
});

test("empty states never stack up in the transcript", async () => {
  const [app, html] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/index.html", "utf8"),
  ]);

  // Reconnect attempts previously appended one block per try.
  assert.match(app, /function showChatEmptyState\(title, copy\) \{\s*elements\.messages\.querySelector\("\.empty-state"\)\?\.remove\(\);/);
  // Disconnect status belongs in its own strip, never inside the transcript.
  assert.match(html, /id="reconnectBanner"[^>]*data-testid="chat-reconnect-banner"/);
  assert.match(app, /socket\.addEventListener\("close"[\s\S]*?setConnecting\(true/);
  assert.doesNotMatch(app, /showChatEmptyState\("Cannot connect"/);
});
