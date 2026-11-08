import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Browser } from 'playwright-core';
import { launchChrome } from './launch-chrome.js';
import { seedDevEnvironment, startDevNode, stopDevNode } from '../dev-nodes.js';
import { nativeUiFixture } from './native-ui-fixture.js';

test('Quality Settings shows the local opt-in, coverage, issues and paginated reasons', { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jb-quality-ui-'));
  const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(node.url);
    await page.locator('#loginDialog[open], .project-card').first().waitFor({ timeout: 60000 });
    if (await page.locator('#loginDialog[open]').count()) {
      await page.getByTestId('login-username-input').fill(environment.username);
      await page.getByTestId('login-password-input').fill(environment.password);
      await page.getByTestId('login-submit-button').click();
    }
    await page.locator('#loginDialog[open]').waitFor({ state: 'hidden' });
    await page.locator('.project-card').first().waitFor();
    await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('quality'); });
    const panel = page.getByTestId('settings-panel-quality'); await panel.waitFor();
    await page.getByTestId('quality-enabled').waitFor();
    assert.equal(await page.getByTestId('quality-enabled').isChecked(), false);
    assert.match(await panel.innerText(), /Only conversations already available on this machine/);
    assert.match(await page.getByTestId('quality-summary').innerText(), /0 evaluated replies/);
    await page.route('**/api/quality-analytics?*', async route => {
      const url = new URL(route.request().url());
      assert.equal(url.searchParams.get('issue'), 'verification');
      await route.fulfill({ json: { enabled: false, projects: [], totals: { replies: 1, issues: 1, good: 0, unknown: 0 }, trends: [], issues: [], jobs: [], failures: [], feedback: [], versions: [], lessons: [], page: 0, pageSize: 8, total: 1, rows: [{ projectId: 'p', conversationId: 'c', replyId: '1', at: '2025-01-01', harness: 'claude', model: 'fixture', result: { outcome: 'issue', reason: 'Claim was not verified', confidence: .9, issues: [{ type: 'verification', reason: 'No test evidence', lesson: 'Run tests before claiming success', ruleId: '', adoptedAt: '' }] } }] } });
    });
    await page.getByTestId('quality-view').selectOption('rows');
    await page.getByTestId('quality-filters-toggle').click();
    await page.getByTestId('quality-issue-filter').fill('verification');
    await page.getByTestId('quality-refresh').click();
    await page.getByText('Claim was not verified', { exact: true }).waitFor();
    assert.match(await panel.innerText(), /Run tests before claiming success/);
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await panel.evaluate(element => ({ width: element.getBoundingClientRect().width, scroll: element.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.width + 2, JSON.stringify(bounds));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});

test('Quality controls fit a phone without full-width checkboxes or cramped filters', { timeout: 90_000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId('login-username-input').fill(environment.username);
  await page.getByTestId('login-password-input').fill(environment.password);
  await page.getByTestId('login-submit-button').click();
  await page.locator('.project-card').first().waitFor();
  await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('quality'); });
  await page.getByTestId('quality-summary').getByText('0 evaluated replies', { exact: false }).waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const toggle = await page.getByTestId('quality-enabled').boundingBox();
    assert.ok(toggle && toggle.width <= 24 && toggle.height <= 24, `checkbox must not stretch: ${JSON.stringify(toggle)}`);
    const label = await page.getByTestId('quality-enabled').locator('..').boundingBox();
    assert.ok(label && toggle.y < label.y + 24, 'checkbox stays beside its label');
    const refresh = await page.getByTestId('quality-refresh').boundingBox();
    assert.ok(refresh && refresh.height >= 44, 'dashboard actions have phone-sized touch targets');
    await page.getByTestId('quality-filters-toggle').click();
    const project = await page.locator('#qualityProject').boundingBox(), from = await page.locator('#qualityFrom').boundingBox();
    assert.ok(project && from && Math.abs(project.x - from.x) < 2 && from.y > project.y, 'phone filters use full-width rows');
    const panel = await page.getByTestId('settings-panel-quality').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(panel.scroll <= panel.width + 2, JSON.stringify(panel));
    await page.getByTestId('quality-filters-toggle').click();
  }
});

test('Quality saves inline, reports failures, and never submits unrelated settings', { timeout: 90_000 }, async t => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId('login-username-input').fill(environment.username);
  await page.getByTestId('login-password-input').fill(environment.password);
  await page.getByTestId('login-submit-button').click();
  await page.locator('.project-card').first().waitFor();
  await page.evaluate(async () => { const { openSettings } = await import('/app/settings.js'); await openSettings('quality'); });
  const toggle = page.getByTestId('quality-enabled'), status = page.getByTestId('quality-save-status');
  await page.getByTestId('quality-summary').getByText('0 evaluated replies', { exact: false }).waitFor();
  assert.equal(await page.getByTestId('settings-save-button').isVisible(), false, 'Quality is autosaved, not part of the general form');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let fail = true, enabled = false;
  await page.route('**/api/quality-analytics/settings', async route => {
    assert.deepEqual(route.request().postDataJSON(), { enabled: true });
    await pending;
    if (fail) await route.fulfill({ status: 503, json: { error: 'Collection settings unavailable' } });
    else { enabled = true; await route.fulfill({ json: { enabled } }); }
  });
  await page.route('**/api/quality-analytics?*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), enabled } });
  });
  const settingsWrites: string[] = [];
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/api/settings')) settingsWrites.push(request.url()); });
  try {
    await toggle.check();
    await status.getByText('Saving', { exact: false }).waitFor();
    assert.equal(await toggle.isDisabled(), true);
    release();
    await status.getByText('Collection settings unavailable', { exact: false }).waitFor();
    assert.equal(await toggle.isChecked(), false);
    await page.locator('#qualityEnabled:enabled').waitFor();
    fail = false;
    await toggle.check();
    await status.getByText('Saved', { exact: false }).waitFor();
    await page.locator('#qualityEnabled:enabled').waitFor();
    assert.equal(await toggle.isChecked(), true);
    await page.getByTestId('quality-filters-toggle').click();
    await page.locator('#qualityModel').press('Enter');
    await page.evaluate(() => document.querySelector<HTMLFormElement>('#settingsForm')!.requestSubmit());
    assert.deepEqual(settingsWrites, [], 'filter Enter must not run the general save');
    assert.equal(await page.locator('#settingsForm button[type=submit]').innerText(), 'Save settings');
    assert.equal(await page.locator('#settingsDialog').evaluate((element: HTMLDialogElement) => element.open), true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('settings-tab-account').click();
    assert.equal(await page.getByTestId('settings-save-button').isVisible(), true, 'other tabs still offer their save action');
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
