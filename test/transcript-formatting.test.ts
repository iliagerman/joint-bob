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
  const [app, markdown, server, serviceWorker, html, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/markdown.js", "utf8"),
    readFile("src/server.ts", "utf8"),
    readFile("public/sw.js", "utf8"),
    readFile("public/index.html", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(markdown, /const FILE_PATH_RE/);
  assert.match(markdown, /dataset\.testid = "chat-file-link"/);
  assert.match(markdown, /dataset\.filePath = path/);
  assert.match(markdown, /dataset\.filePath = groups\.url/);
  assert.match(markdown, /const linksToFile = Boolean\(resolveFileUrl\) && isFilePath\(groups\.url\)/);
  assert.match(app, /resolveFileUrl: role === "assistant" \? projectFileUrl : undefined/);
  assert.match(app, /url\.searchParams\.set\("nodeId", state\.activeNodeId\)/);
  assert.match(app, /url\.searchParams\.set\("download", "1"\)/);
  assert.match(app, /closest\("a\[data-file-path\]"\)/);
  assert.match(app, /file-resolution/);
  assert.match(app, /fileActionViewLink/);
  assert.match(app, /fileActionStatus/);
  assert.match(app, /CodeMirror\.fromTextArea/);
  assert.match(app, /keyMap: "vim"/);
  assert.match(app, /CodeMirror\.findModeByFileName/);
  assert.match(app, /CodeMirror\.autoLoadMode/);
  assert.match(app, /async function saveProjectFile\(closeAfterSave = true\) \{[\s\S]*const session = activeChatSession\(\);[\s\S]*Open a persisted conversation before editing files/);
  assert.match(app, /async function saveProjectFile\(closeAfterSave = true\) \{[\s\S]*const content = fileEditor\.getValue\(\);[\s\S]*JSON\.stringify\(\{ content, version, sessionId: session\.id \}\)[\s\S]*original: content/);
  assert.match(app, /CodeMirror\.commands\.save = \(\) => \{ void saveProjectFile\(false\); \}/);
  assert.match(server, /async function assertProjectFileConversationOwner\([\s\S]*listHarnessSessions\(project\)[\s\S]*requireLocalConversationOwner\([\s\S]*session\.id\)/);
  assert.match(server, /await assertProjectEditable\(project\);\s*await assertProjectFileConversationOwner\(project, payload\.sessionId\);[\s\S]*await readFile\(resolved\)/);
  for (const testid of ["file-action-dialog", "file-action-view-link", "file-action-download-link", "file-action-cancel-button", "file-action-edit-button", "file-editor-mode", "file-editor-textarea", "file-editor-cancel-button", "file-editor-save-button"]) assert.ok(html.includes(testid));
  assert.match(app, /dataset\.testid = "file-editor-input"/);
  assert.ok(html.indexOf('id="fileActionCancelButton"') < html.indexOf('id="fileActionViewLink"'));
  assert.match(styles, /\.file-editor-card\s*\{[^}]*width:\s*min\(440px,/);
  assert.match(styles, /\.file-editor-card:has\(#fileEditorView:not\(\[hidden\]\)\)/);
  assert.match(styles, /\.file-editor-path\s*\{[^}]*border:\s*1px solid var\(--line\)/);
  assert.match(styles, /\.file-editor-actions\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /#fileActionViewLink, #fileActionDownloadLink\s*\{[^}]*text-decoration:\s*none;[^}]*background:\s*var\(--field\)/);
  assert.match(styles, /\.file-editor-card \.CodeMirror\s*\{/);
  assert.match(styles, /#fileActionEditButton\s*\{[^}]*background:\s*var\(--accent\)/);
  assert.match(html, /id="fileActionEditButton"[^>]*autofocus/);
  assert.match(app, /Discard unsaved changes\?/);
  assert.match(server, /app\.get\("\/api\/cluster\/project-file-resolution"/);
  assert.match(server, /app\.get\("\/api\/cluster\/project-file"/);
  assert.match(server, /Readable\.fromWeb\(routed\.body as unknown as import\("node:stream\/web"\)\.ReadableStream\)\.pipe\(response\)/);
  assert.match(server, /async function searchProjectFile\(/);
  assert.match(server, /matchingPathSuffix\(/);
  assert.match(server, /File is outside the project directory/);
  assert.match(server, /project-file-content/);
  assert.match(server, /await rename\(temporary, resolved\)/);
  assert.match(serviceWorker, /const CACHE_NAME = "joint-bob-v70"/);
  assert.match(serviceWorker, /\/vendor\/codemirror\/lib\/codemirror\.js/);
  assert.match(serviceWorker, /\/vendor\/codemirror\/keymap\/vim\.js/);
  assert.match(serviceWorker, /self\.addEventListener\("fetch"/);
  assert.match(serviceWorker, /fetch\(request\)\.catch\(async \(\) => \(await caches\.match\(request\)\) \|\| caches\.match\("\/"\)\)/);
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
