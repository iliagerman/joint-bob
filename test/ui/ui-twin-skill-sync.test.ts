import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode, pairTwinNodes } from "../dev-nodes.js";

test("Resources previews and confirms authoritative twin sync, then exposes status and pause",{timeout:120_000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"ui-twin-sync-")),servers:Awaited<ReturnType<typeof startDevNode>>[]=[];
 let browser:Awaited<ReturnType<typeof launchChrome>>|undefined;
 try{
  const ae=await seedDevEnvironment(path.join(root,"mac"),1),be=await seedDevEnvironment(path.join(root,"server"),1),a=ae.nodes[0],b=be.nodes[0];
  const ar=path.join(ae.home,"JointBob/.agent-resources/shared/skills"),br=path.join(be.home,"JointBob/.agent-resources/shared/skills");
  for(const [dir,name] of [[ar,"mac-source"],[br,"server-extra"]]){await mkdir(path.join(dir,name),{recursive:true});await writeFile(path.join(dir,name,"SKILL.md"),`---\nname: ${name}\ndescription: UI fixture\n---\n`);}
  servers.push(await startDevNode(ae,a),await startDevNode(be,b));await pairTwinNodes({...ae,nodes:[a,b]});
  browser=await launchChrome({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000},serviceWorkers:"block"});
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(a.url);await page.getByTestId("login-username-input").fill(ae.username);await page.getByTestId("login-password-input").fill(ae.password);await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant",{exact:true}).first().waitFor();await page.getByTestId("settings-open-button").click();await page.getByTestId("settings-tab-resources").click();
  await page.getByTestId("twin-skill-target").selectOption(b.nodeId);
  await page.getByTestId("twin-skill-initialize").click();
  await page.getByTestId("confirm-accept-button").waitFor();
  assert.match(await page.locator("#confirmMessage").innerText(),/mac-source/);assert.match(await page.locator("#confirmMessage").innerText(),/server-extra/);
  await page.getByTestId("confirm-cancel-button").click();assert.match(await readFile(path.join(br,"server-extra/SKILL.md"),"utf8"),/server-extra/);
  await page.getByTestId("twin-skill-initialize").click();await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("twin-skill-status").getByText(/Two-way skill sync active/).waitFor();
  assert.match(await readFile(path.join(br,"mac-source/SKILL.md"),"utf8"),/mac-source/);await assert.rejects(readFile(path.join(br,"server-extra/SKILL.md")),{code:"ENOENT"});
  await page.getByTestId("twin-skill-pause").click();await page.getByTestId("twin-skill-status").getByText(/paused/).waitFor();
  await page.getByTestId("twin-skill-pause").click();await page.getByTestId("twin-skill-status").getByText(/Two-way skill sync active/).waitFor();
  let resolutions=0;
  await page.route(`${a.url}/api/resources/skills/twin-sync/resolve`,async route=>{resolutions++;await route.fulfill({json:{}});});
  await page.route(`${a.url}/api/resources/skills/twin-sync`,async route=>{
   if(route.request().method()!=="GET"){await route.continue();return;}
   const response=await route.fetch(),body=await response.json();body.conflicts=[{name:"fixture-conflict",digest:"f".repeat(64),activeDigest:null}];
   await route.fulfill({response,json:body});
  });
  await page.getByTestId("twin-skill-refresh").click();
  await page.getByTestId("twin-skill-restore-conflict").click();await page.getByTestId("confirm-accept-button").waitFor();
  await page.evaluate((peer)=>{const select=document.querySelector("#resourcesNodeSelect") as HTMLSelectElement;select.value=peer;select.dispatchEvent(new Event("change",{bubbles:true}));},b.nodeId);
  await page.getByTestId("confirm-accept-button").click();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(resolutions,0,"a conflict confirmation opened in a previous node context must never submit");
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();for(const s of servers)await stopDevNode(s);await rm(root,{recursive:true,force:true});}
});
