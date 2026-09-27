import type { Locator, Page } from "playwright-core";

/** Helpers for the check-box filter dropdowns built by public/app/multi-select.js. */

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function multiSelect(page: Page, testid: string) {
  const root = page.getByTestId(testid);
  const trigger = root.getByTestId(`${testid}-trigger`);
  const option = (label: string): Locator => root.getByTestId(`${testid}-option`)
    .filter({ has: page.locator(".multi-select-option-label", { hasText: new RegExp(`^${escape(label)}$`) }) });
  async function open(): Promise<void> {
    if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  }
  async function close(): Promise<void> {
    if (await trigger.getAttribute("aria-expanded") === "true") await trigger.click();
  }
  return {
    root,
    trigger,
    open,
    close,
    /** Labels of every option, in list order. */
    async labels(): Promise<string[]> {
      await open();
      const labels = await root.locator(".multi-select-option-label").allTextContents();
      await close();
      return labels;
    },
    /** Labels of the chosen options. */
    async selected(): Promise<string[]> {
      await open();
      const labels = await root.locator(`[data-testid="${testid}-option"][aria-selected="true"] .multi-select-option-label`).allTextContents();
      await close();
      return labels;
    },
    /** Flips each named option, leaving the list closed. */
    async toggle(...labels: string[]): Promise<void> {
      await open();
      for (const label of labels) await option(label).click();
      await close();
    },
    /** Chooses exactly the named options. */
    async choose(...labels: string[]): Promise<void> {
      await open();
      const clear = root.getByTestId(`${testid}-clear`);
      if (await clear.isVisible()) await clear.click();
      await open();
      for (const label of labels) await option(label).click();
      await close();
    },
  };
}
