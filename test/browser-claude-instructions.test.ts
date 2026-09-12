import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeAgentResourceArgs } from "../src/agent-resources.js";
import { browserAgentInstructions } from "../src/browser-agent.js";

test("Claude browser instructions append to configured system instructions without changing user input", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"browser-claude-system-"));
  try {
    await mkdir(path.join(root,"runtime"));await writeFile(path.join(root,"runtime/common-instructions.md"),"Keep existing project instructions.");
    const args=claudeAgentResourceArgs(root,undefined,browserAgentInstructions);
    assert.equal(args.filter(value=>value==="--append-system-prompt-file").length,1);
    const content=await readFile(args[args.indexOf("--append-system-prompt-file")+1],"utf8");
    assert.ok(content.includes("Keep existing project instructions."));
    assert.ok(content.includes(browserAgentInstructions));
    assert.ok(content.includes("Repository test exception:"), "Claude must receive the isolated native browser test exception");
    for (const boundary of ["disposable HOME/data directories", "synthetic test accounts", "loopback fixture servers", "Never use real credentials", "Manual takeover pauses agent commands"]) {
      assert.ok(content.includes(boundary), `Claude browser instructions must retain: ${boundary}`);
    }
    assert.ok(!content.includes("All web browsing and browser testing must"), "Claude must not receive the contradictory blanket test ban");
    assert.ok(content.includes("explicit start --node ID > conversation override > Settings default"), "Claude must receive browser machine precedence");
    assert.ok(content.includes("Browser localhost refers to the selected browser machine"), "Remote browser localhost is not the agent host");
    assert.ok(content.includes("Existing sessions and profiles remain pinned"), "Changing defaults must not move signed-in accounts");
    assert.ok(!args.includes("--append-system-prompt"),"Use one combined system file, never conflicting CLI flags");
    const plain=claudeAgentResourceArgs(root);
    assert.equal(await readFile(plain[plain.indexOf("--append-system-prompt-file")+1],"utf8"),"Keep existing project instructions.");
  } finally { await rm(root,{recursive:true,force:true}); }
});
