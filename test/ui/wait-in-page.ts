import type { Page } from "playwright-core";

/**
 * Retries an async check in the page until it holds. page.waitForFunction takes the promise an
 * async check returns as a truthy result, so there the check runs once and passes whatever it finds.
 */
export async function waitInPage<Arg>(page: Page, check: (arg: Arg) => Promise<unknown>, arg?: Arg, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    // A reload while the check runs says nothing about the condition: ask the new page.
    const held = await page.evaluate(check, arg as Arg).catch((error: Error) => {
      if (/Execution context was destroyed|Cannot find context/.test(error.message)) return false;
      throw error;
    });
    if (held) return;
    if (Date.now() > deadline) throw new Error(`Page check did not hold within ${timeout} ms: ${check}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
