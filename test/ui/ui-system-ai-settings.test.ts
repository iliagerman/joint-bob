import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeUiFixture } from './native-ui-fixture.js';

test('System AI centralizes shared choices and saves only its dedicated endpoint', { timeout: 120000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t);
  const choice = { harnessId: 'claude', provider: 'claude', modelId: 'saved-unavailable-model', thinkingLevel: 'high' };
  let view = { system: { decision: { model: 'typesafe', typesafeAccountId: 'missing-account', layaAccountId: null }, operations: { feedback: null, knowledge: choice }, quality: { modelId: '' }, profiles: { claude: 'missing-profile', pi: null, kiro: null, 'openai-codex': null } }, backgroundAgent: { harnessId: '', provider: '', modelId: '', thinkingLevel: '' }, syncCheck: { ...choice, enabled: false }, dashboards: choice, node: { id: 'synthetic', name: 'Synthetic execution twin' }, secrets: [{ id: 'fixture-account', label: 'Synthetic account', variables: [{ name: 'TYPESAFE_AI_API_KEY', kind: 'secret', configured: true }] }], profiles: [], readiness: { decision: 'Selected account unavailable on this twin' } };
  const writes: any[] = [], unrelated: string[] = [];
  let fail = true;
  await page.route('**/api/system-ai', async route => {
    if (route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON());
      if (fail) return route.fulfill({ status: 503, json: { error: 'Synthetic save failure' } });
      view = { ...view, ...writes.at(-1) };
    }
    await route.fulfill({ json: view });
  });
  page.on('request', request => { if (request.method() !== 'GET' && /\/api\/settings(?:$|\/runtime-check)/.test(request.url())) unrelated.push(request.url()); });
  await page.goto(node.url);
  await page.getByTestId('login-username-input').fill(environment.username);
  await page.getByTestId('login-password-input').fill(environment.password);
  await page.getByTestId('login-submit-button').click();
  await page.locator('.project-card').first().waitFor();
  await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('system-ai'); });
  const panel = page.getByTestId('settings-panel-system-ai');
  await panel.waitFor({ timeout: 10000 });
  await page.getByTestId('system-ai-decision-model').waitFor();
  assert.match(await panel.innerText(), /trusted twins/i);
  assert.match(await panel.innerText(), /Synthetic execution twin/);
  assert.match(await panel.innerText(), /Selected account unavailable/);
  for (const id of ['settings-background-agent', 'settings-sync-check', 'settings-dashboards', 'settings-summary-writer']) assert.equal(await panel.getByTestId(id).count(), 1, id);
  assert.equal(await panel.getByTestId('quality-enabled').count(), 0);
  assert.equal(await page.getByTestId('system-ai-typesafe-account').inputValue(), 'missing-account');
  assert.equal(await page.getByTestId('system-ai-profile-claude').inputValue(), 'missing-profile');
  assert.equal(await page.getByTestId('system-ai-quality-model').inputValue(), '', 'blank preserves the Claude default');
  assert.deepEqual(await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  }), [], 'moving fieldsets must not duplicate IDs');
  await page.evaluate(() => {
    const input = document.querySelector('#settingsProjectHome') as HTMLInputElement;
    input.required = true; input.value = '';
  });
  await page.getByTestId('system-ai-feedback-harness').selectOption('claude');
  await page.getByTestId('system-ai-feedback-model').waitFor({ state: 'attached' });
  await page.getByTestId('system-ai-feedback-harness').selectOption('');
  await page.getByTestId('system-ai-quality-model').fill('fixture-quality');
  await page.getByTestId('settings-save-button').click();
  await page.getByTestId('system-ai-status').getByText('Synthetic save failure', { exact: false }).waitFor();
  fail = false;
  await page.getByTestId('settings-save-button').click();
  await page.getByTestId('system-ai-status').getByText('Saved', { exact: false }).waitFor();
  assert.equal(writes.length, 2);
  assert.deepEqual(Object.keys(writes[1]).sort(), ['backgroundAgent', 'dashboards', 'syncCheck', 'system']);
  assert.equal(writes[1].system.quality.modelId, 'fixture-quality');
  assert.equal(writes[1].system.operations.feedback, null);
  assert.deepEqual(writes[1].system.operations.knowledge, choice);
  assert.equal(writes[1].system.profiles.claude, 'missing-profile');
  assert.deepEqual(unrelated, []);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const bounds = await panel.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.width + 2, JSON.stringify(bounds));
  }
  await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('quality'); });
  await page.getByTestId('quality-system-ai-link').click();
  await panel.waitFor();
  await page.evaluate(async () => {
    const { state } = await import('/app/state.js'); state.role = 'member';
    const { applyAdminVisibility } = await import('/app/node-admin.js'); applyAdminVisibility();
    const { openSettings } = await import('/app/settings.js'); await openSettings('system-ai');
  });
  assert.equal(await panel.isVisible(), false, 'a member cannot open System AI');
  assert.equal(await page.getByTestId('settings-tab-system-ai').isVisible(), false);
});
