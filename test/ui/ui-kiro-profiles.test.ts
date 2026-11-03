import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { waitInPage } from "./wait-in-page.js";

async function choose(page: Page | Locator, testid: string, search: string, label: string): Promise<void> {
  await page.getByTestId(testid).click();
  await page.getByTestId(`${testid}-search`).fill(search);
  await page.getByTestId(`${testid}-option`).filter({ hasText: label }).first().click();
}

test("Kiro profiles sit beside the other providers, sign in natively, stay out of pools, and take scoped choices", { timeout: 120_000 }, async (t) => {
  const root=await mkdtemp(path.join(os.tmpdir(),'kiro-profile-ui-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const executable=path.join(root,'kiro-fixture.mjs');
  await writeFile(executable,`#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const marker=path.join(process.env.HOME,'fixture-login');
if(process.argv.includes('--version'))process.exit(0);
if(process.argv.includes('--list-models')){console.log(JSON.stringify({models:[{model_id:'fixture-model',model_name:'Fixture model'}]}));process.exit(0)}
if(process.argv.includes('whoami'))process.exit(fs.existsSync(marker)?0:1);
if(process.argv.includes('logout')){fs.rmSync(marker,{force:true});process.exit(0)}
if(process.argv.includes('login')){console.log('Open https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH');console.log('Confirmation code: ABCD-EFGH');console.error('fixture-private-provider-output');setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(root,'release-login'))})){fs.writeFileSync(marker,'fixture-token');process.exit(0)}},100)}
`);await chmod(executable,0o700);
  const {page,environment,node}=await nativeUiFixture(t);
  page.on('pageerror', error => console.error('Kiro UI fixture page error:', error.message));
  page.on('response', response => { if(response.status()>=400) console.error('Kiro UI fixture response:',response.status(),new URL(response.url()).pathname); });
  await page.goto(node.url);
  await page.getByTestId('login-username-input').fill(environment.username);
  await page.getByTestId('login-password-input').fill(environment.password);
  await page.getByTestId('login-submit-button').click();
  await page.locator('#loginDialog[open]').waitFor({state:'hidden'});
  await page.locator('.project-card').first().waitFor();
  await page.evaluate(async (executable)=>{
    const {api}=await import('/app/api.js');
    const settings=await api('/api/settings');
    await api('/api/settings',{method:'PUT',body:JSON.stringify({runtimes:{...settings.runtimes,kiro:{...settings.runtimes.kiro,executable}}})});
  },executable);
  await page.getByTestId('settings-open-button').click();
  await page.getByTestId('settings-tab-connections').click();
  await page.getByTestId('provider-profile-add').waitFor();
  await page.locator('[data-testid="settings-save-button"]:enabled').waitFor();
  const kiroTab=page.getByTestId('provider-profile-provider-kiro');
  assert.equal(await kiroTab.locator('svg').count(),1,'Kiro is a provider tab with its icon, like the others');
  await kiroTab.click();
  assert.match(await page.getByTestId('provider-profile-section').innerText(),/AWS IAM Identity Center/);
  const add=async(label:string)=>{
    await page.getByTestId('provider-profile-label').fill(label);
    await page.getByTestId('kiro-profile-start-url').fill('https://fixture.awsapps.com/start');
    await page.getByTestId('kiro-profile-region').fill('us-east-1');
    const created=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/provider-profiles'&&response.request().method()==='POST');
    await page.getByTestId('provider-profile-add').click();
    assert.equal((await created).status(),201);
    const card=page.getByTestId('provider-profile-row').filter({hasText:label});
    try {await card.waitFor();} catch(error) {throw new Error(`Kiro profile did not render: ${await page.getByTestId('provider-profiles').innerText()} | ${await page.locator('.toast-message').allTextContents()}`,{cause:error});}
    return card;
  };
  await page.getByTestId('provider-profile-label').fill('No URL');
  await page.getByTestId('provider-profile-add').click();
  await page.locator('.toast-message',{hasText:'Enter the IAM Identity Center start URL and AWS region'}).waitFor();
  const first=await add('Kiro work');await add('Kiro other');
  assert.match(await first.innerText(),/https:\/\/fixture\.awsapps\.com\/start · us-east-1/);
  assert.equal(await first.getByTestId('provider-profile-sharing').count(),0,'Kiro profiles cannot be shared');
  await page.getByTestId('provider-profile-provider-claude').click();
  assert.equal(await page.getByTestId('provider-profile-row').count(),0,'Kiro profiles stay on the Kiro tab');
  await kiroTab.click();

  await first.getByTestId('provider-profile-signin').click();
  const link=first.getByTestId('provider-profile-login-link');await link.waitFor();
  assert.match((await link.getAttribute('href'))!,/^https:\/\/device\.sso\./);
  assert.match(await first.getByTestId('provider-profile-login').innerText(), /ABCD-EFGH/);
  // The fixture's sign-in finishes when the test releases it, so a slow page cannot miss the link.
  await writeFile(path.join(root,'release-login'),'');
  await first.getByTestId('provider-profile-status').filter({hasText:'Signed in on this node'}).waitFor();
  assert.doesNotMatch(await first.innerText(),/fixture-private|fixture-token/);
  await waitInPage(page, async()=>{const {state}=await import('/app/state.js');return state.harnesses.find((item:{id:string;ready?:boolean})=>item.id==='kiro')?.ready===true;});

  await page.getByTestId('provider-profiles-tab-pools').click();
  await page.getByTestId('subscription-pool-new').click();
  await page.getByTestId('subscription-pool-member-0').click();
  await page.getByTestId('subscription-pool-member-0-search').fill('Kiro');
  assert.equal(await page.getByTestId('subscription-pool-member-0-option').count(),0,'Kiro profiles cannot join pools');
  await page.keyboard.press('Escape');
  await page.getByTestId('subscription-pool-cancel').click();

  await page.getByTestId('provider-profiles-tab-assignments').click();
  await page.getByTestId('provider-assignment-provider-kiro').click();
  await choose(page,'provider-assignment-default-select','Kiro work','Kiro work');
  const choiceSaved=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/provider-profiles/selection'&&response.request().method()==='PUT');
  await page.getByTestId('confirm-accept-button').click();
  assert.equal((await choiceSaved).status(),200);
  const saved=await (await page.request.get(`${node.url}/api/provider-profiles`)).json();
  assert.ok(saved.selections.some((item:{provider:string;scope:string;profileId:string})=>item.provider==='kiro'&&item.scope==='default'&&item.profileId===(saved.profiles.find((profile:{label:string})=>profile.label==='Kiro work').id)));

  await page.reload();await page.getByTestId('settings-open-button').click();await page.getByTestId('settings-tab-connections').click();
  await page.getByTestId('provider-profile-provider-kiro').click();
  await page.getByTestId('provider-profile-row').filter({hasText:'Kiro work'}).getByTestId('provider-profile-status').filter({hasText:'Signed in on this node'}).waitFor();
  await page.getByTestId('provider-profile-row').filter({hasText:'Kiro other'}).getByTestId('provider-profile-status').filter({hasText:'Not signed in'}).waitFor();
  await page.locator('[data-testid="settings-save-button"]:enabled').waitFor();
  await page.getByTestId('provider-profiles-tab-assignments').click();
  await page.getByTestId('provider-assignment-provider-kiro').click();
  assert.equal((await page.getByTestId('provider-assignment-default-select').innerText()).trim(),'Kiro work');
  await choose(page,'provider-assignment-default-select','None','None');
  const cleared=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/provider-profiles/selection'&&response.request().method()==='PUT');
  await page.getByTestId('confirm-accept-button').click();
  assert.equal((await cleared).status(),200);
  const after=await (await page.request.get(`${node.url}/api/provider-profiles`)).json();
  assert.equal(after.selections.some((item:{provider:string})=>item.provider==='kiro'),false);
});
