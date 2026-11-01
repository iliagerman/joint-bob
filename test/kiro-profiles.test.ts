import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { createProviderProfile, setProviderProfileSelection } from "../src/provider-profiles/store.js";
import { createSubscriptionPool } from "../src/provider-profiles/pools.js";
import { getSettings, updateSettings } from "../src/settings.js";

await getClusterNode();
const input = { provider: "kiro", label: "Kiro work", kiro: { startUrl: "https://fixture.awsapps.com/start", region: "us-east-1" } };

test("Kiro IAM profiles require explicit valid SSO settings and stay out of subscription pools", () => {
  const profile = createProviderProfile("kiro-owner", input);
  assert.deepEqual(profile.kiro, input.kiro);
  for (const kiro of [undefined, { ...input.kiro, startUrl: "http://fixture.invalid" }, { ...input.kiro, region: "--bad" }]) assert.throws(() => createProviderProfile("kiro-owner", { ...input, kiro }));
  assert.throws(() => createProviderProfile("kiro-owner", { ...input, provider: "pi" }));
  assert.throws(() => createSubscriptionPool("kiro-owner", { name: "Must reject", profileIds: [profile.id] }), /standalone/);
  assert.throws(() => setProviderProfileSelection("kiro-owner", { provider: "kiro", scope: "default", scopeId: "", profileId: null, poolId: profile.id }));
});

test("Kiro native login uses independent homes, safe device metadata and per-profile logout", async () => {
  const one = createProviderProfile("kiro-owner", input);
  const two = createProviderProfile("kiro-owner", { ...input, label: "Kiro other" });
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-profile-cli-"));
  const executable = path.join(root, "kiro-fixture.mjs");
  const previous = getSettings().runtimes.kiro;
  await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const marker=path.join(process.env.HOME,'fixture-login');
if(process.argv[2]==='whoami') process.exit(fs.existsSync(marker)?0:1);
if(process.argv[2]==='logout'){fs.rmSync(marker,{force:true});process.exit(0)}
if(process.argv[2]==='login'){
  if(!process.argv.includes('--license')||!process.argv.includes('pro')||!process.argv.includes('--use-device-flow'))process.exit(2);
  console.log('Open https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH');
  console.log('Confirmation code: ABCD-EFGH');
  console.error('fixture-private-provider-output');
  setTimeout(()=>{fs.writeFileSync(marker,'fixture-native-token');process.exit(0)},150);
}
`);
  await chmod(executable, 0o700);
  updateSettings({ runtimes: { ...getSettings().runtimes, kiro: { ...previous, executable } } });
  try {
    const native = await import("../src/kiro-profiles/native.js");
    const { profileLoginState, logoutProfile } = await import("../src/provider-profiles/service.js");
    const a = await native.prepareKiroProfile(one);
    const b = await native.prepareKiroProfile(two);
    assert.notEqual(a.HOME, b.HOME);
    assert.notEqual(a.KIRO_HOME, b.KIRO_HOME);
    assert.equal(native.kiroProfileEnvironment({ KIRO_API_KEY: "fixture-ambient", PATH: "/bin" }, a).KIRO_API_KEY, undefined);
    assert.equal((await profileLoginState(one)).signedIn, false);
    await native.startKiroProfileLogin(one);
    let seenUrl = false, seenDeviceCode = false;
    for (let attempt=0;attempt<200;attempt++) {
      const status=native.kiroProfileLoginStatus(one);
      seenUrl ||= Boolean(status?.url);
      seenDeviceCode ||= status?.deviceCode === 'ABCD-EFGH';
      assert.doesNotMatch(JSON.stringify(status), /private-provider|native-token/);
      if(status?.state==='complete')break;
      if(status?.state==='failed')assert.fail(status.message);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(native.kiroProfileLoginStatus(one)?.state, 'complete');
    assert.equal(seenUrl,true);
    assert.equal(seenDeviceCode,true);
    assert.equal((await profileLoginState(one)).signedIn,true);
    assert.equal((await profileLoginState(two)).signedIn,false);
    await logoutProfile(one);
    assert.equal((await profileLoginState(one)).signedIn,false);
    const { useProviderProfile } = await import("../src/provider-profiles/execution.js");
    try {
      await assert.rejects(useProviderProfile(one, () => native.startKiroProfileLogin(one)), /busy/);
      await assert.rejects(useProviderProfile(one, () => native.logoutKiroProfile(one)), /busy/);
    } finally {
      if (native.kiroProfileLoginStatus(one)?.state === "waiting") await native.cancelKiroProfileLogin(one);
    }
  } finally {
    updateSettings({ runtimes: { ...getSettings().runtimes, kiro: previous } });
    await rm(root,{recursive:true,force:true});
  }
});
