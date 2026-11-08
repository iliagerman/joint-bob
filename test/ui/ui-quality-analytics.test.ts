import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Browser } from 'playwright-core';
import { launchChrome } from './launch-chrome.js';
import { seedDevEnvironment, startDevNode, stopDevNode } from '../dev-nodes.js';

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
