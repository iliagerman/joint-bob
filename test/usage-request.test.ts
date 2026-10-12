import assert from 'node:assert/strict';
import test from 'node:test';
import { requestComparison } from '../public/app/usage-request.js';

test('comparison retries one timeout then returns the later snapshot', async () => {
  let calls = 0;
  const result = await requestComparison('/days', async (_path, options) => {
    calls++;
    if (calls === 1) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    return { days: [2] };
  }, new AbortController().signal, 1);
  assert.equal(calls, 2);
  assert.deepEqual(result, { days: [2] });
});

test('cancellation never retries and cannot commit an old scope', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = requestComparison('/days', async (_path, options) => {
    calls++;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  }, controller.signal, 1000);
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(calls, 1);
});
