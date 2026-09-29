import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the composer is not nested inside the ticket form", async () => {
  const html = await readFile("public/index.html", "utf8");

  // A <form> inside a <form> is invalid HTML and the browser drops it, so the
  // chat host must be a sibling of #taskForm, not a descendant.
  const dialog = html.slice(html.indexOf('<dialog id="taskDialog">'), html.indexOf('<dialog id="taskDialog">') + 6000);
  const formStart = dialog.indexOf('id="taskForm"');
  const formEnd = dialog.indexOf("</form>", formStart);
  const hostAt = dialog.indexOf('id="taskChatHost"');
  assert.notEqual(hostAt, -1, "the ticket dialog has no chat host");
  assert.ok(hostAt > formEnd, "the chat host is inside #taskForm");
});

