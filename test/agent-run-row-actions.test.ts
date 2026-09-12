import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

test("sub-agent task lines do not drag the row action buttons off the conversation card", async () => {
  const [app, styles] = await Promise.all([appSource(), readFile("public/styles.css", "utf8")]);

  // The card and its action lanes share a wrapper, so the buttons centre on the
  // card even when the agent run list makes the row taller.
  assert.match(app, /rowMain\.className = "list-row-main"/);
  assert.match(app, /rowMain\.append\(button, ticketRowButton\(ticketTask\), pinToggle, menuButton\)/);
  assert.match(app, /rowMain\.append\(button, pinToggle, menuButton\)/);
  assert.match(app, /if \(childToggle\) rowMain\.append\(childToggle\)/);
  assert.match(app, /row\.append\(rowMain\)/);
  assert.match(app, /row\.append\(agentRunToggle\(session, tasks, collapsed\)\)/);
  assert.match(app, /if \(!collapsed\) row\.append\(agentRunList\(tasks\)\)/);
  assert.match(styles, /\.list-row-main \{[^}]*position: relative/);
});
