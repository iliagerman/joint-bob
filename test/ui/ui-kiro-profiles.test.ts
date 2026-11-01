import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("Kiro IAM profiles have their own management, native sign-in and scoped choices", { timeout: 120_000 }, async (t) => {
  const root=await mkdtemp(path.join(os.tmpdir(),'kiro-profile-ui-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const executable=path.join(root,'kiro-fixture.mjs');
  await writeFile(executable,`#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const marker=path.join(process.env.HOME,'fixture-login');
if(process.argv.includes('--version'))process.exit(0);
if(process.argv.includes('--list-models')){console.log(JSON.stringify({models:[{model_id:'fixture-model',model_name:'Fixture model'}]}));process.exit(0)}
if(process.argv.includes('whoami'))process.exit(fs.existsSync(marker)?0:1);
if(process.argv.includes('logout')){fs.rmSync(marker,{force:true});process.exit(0)}
if(process.argv.includes('login')){console.log('Open https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH');console.log('Confirmation code: ABCD-EFGH');console.error('fixture-private-provider-output');setTimeout(()=>{fs.writeFileSync(marker,'fixture-token');process.exit(0)},1500)}
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
  await page.getByTestId('settings-tab-engines').click();
  await page.getByTestId('kiro-profiles').waitFor();
  await page.locator('[data-testid="settings-save-button"]:enabled').waitFor();
  const add=async(label:string)=>{
    await page.getByTestId('kiro-profile-label').fill(label);
    await page.getByTestId('kiro-profile-start-url').fill('https://fixture.awsapps.com/start');
    await page.getByTestId('kiro-profile-region').fill('us-east-1');
    assert.equal(await page.getByTestId('kiro-profile-label').inputValue(),label,'name remains entered');
    assert.equal(await page.getByTestId('kiro-profile-start-url').inputValue(),'https://fixture.awsapps.com/start','SSO URL remains entered');
    assert.equal(await page.getByTestId('kiro-profile-region').inputValue(),'us-east-1','region remains entered');
    const created=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/provider-profiles'&&response.request().method()==='POST');
    await page.getByTestId('kiro-profile-add').click();
    assert.equal((await created).status(),201);
    const card=page.getByTestId('kiro-profile-row').filter({hasText:label});
    try {await card.waitFor();} catch(error) {throw new Error(`Kiro profile did not render: ${await page.getByTestId('kiro-profiles').innerText()} | ${await page.locator('.toast-message').allTextContents()}`,{cause:error});}
    return card;
  };
  const first=await add('Kiro work');await add('Kiro other');
  assert.equal(await page.getByTestId('provider-profile-row').count(),0,'Kiro never enters Claude/Pi connection management');
  await first.getByTestId('kiro-profile-signin').click();
  const link=first.getByTestId('kiro-profile-login-link');await link.waitFor();
  assert.match((await link.getAttribute('href'))!,/^https:\/\/device\.sso\./);
  assert.match(await first.getByTestId('kiro-profile-device-code').innerText(), /ABCD-EFGH/);
  await first.getByTestId('kiro-profile-status').filter({hasText:'Signed in'}).waitFor();
  assert.doesNotMatch(await first.innerText(),/fixture-private|fixture-token/);
  await page.waitForFunction(async()=>{const {state}=await import('/app/state.js');return state.harnesses.find((item:{id:string;ready?:boolean})=>item.id==='kiro')?.ready===true;});
  const id=(await first.getAttribute('data-profile-id'))!;
  await page.getByTestId('kiro-profile-selection-scope').selectOption('default');
  await page.getByTestId('kiro-profile-selection-profile').selectOption(id);
  await page.getByTestId('kiro-profile-selection-save').click();
  await page.getByTestId('confirm-accept-button').click();
  await page.getByTestId('kiro-profile-selection-row').filter({hasText:'Default'}).filter({hasText:'Kiro work'}).waitFor();
  await page.reload();await page.getByTestId('settings-open-button').click();await page.getByTestId('settings-tab-engines').click();
  await page.getByTestId('kiro-profile-row').filter({hasText:'Kiro work'}).getByTestId('kiro-profile-status').filter({hasText:'Signed in'}).waitFor();
  await page.getByTestId('kiro-profile-row').filter({hasText:'Kiro other'}).getByTestId('kiro-profile-status').filter({hasText:'Not signed in'}).waitFor();
  await page.locator('[data-testid="settings-save-button"]:enabled').waitFor();
  await page.getByTestId('kiro-profile-selection-row').getByTestId('kiro-profile-selection-remove').click();await page.getByTestId('confirm-accept-button').click();
  await page.getByTestId('kiro-profile-selection-row').waitFor({state:'detached'});
});
