import type { Page } from "playwright-core";

export interface BrowserLoginForm {
  origin: string;
  title: string;
  fields: Array<{ selector: string; type: string; label: string; autocomplete: string }>;
  submit: { selector: string; label: string } | null;
}

// Reads the visible sign-in form so the viewer can draw its own. Each field and the submit
// button get a data attribute (rewritten on every read) that later fill and click commands target.
const script = `(() => {
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden";
  document.querySelectorAll("[data-jb-login-field],[data-jb-login-submit]").forEach(element => { element.removeAttribute("data-jb-login-field"); element.removeAttribute("data-jb-login-submit"); });
  const textTypes = ["text", "email", "password", "tel", "number", "url", "search"];
  const fieldsIn = root => [...root.querySelectorAll("input")].filter(input => visible(input) && textTypes.includes(input.type) && !input.disabled && !input.readOnly && !(input.getAttribute("autocomplete") || "").toLowerCase().includes("one-time-code"));
  const roots = [...document.querySelectorAll('form,[role="form"],[role="dialog"]')].filter(visible).concat([document.body]);
  const root = roots.find(candidate => fieldsIn(candidate).some(input => input.type === "password")) || roots.find(candidate => fieldsIn(candidate).length);
  if (!root) return { fields: [], submit: null, title: document.title };
  const labelOf = input => {
    const byFor = input.id ? document.querySelector('label[for="' + CSS.escape(input.id) + '"]') : null;
    const text = input.getAttribute("aria-label") || (byFor || input.closest("label"))?.textContent || input.placeholder || input.name || input.type;
    return text.replace(/\\s+/g, " ").trim().slice(0, 80);
  };
  const fields = fieldsIn(root).map((input, index) => {
    input.setAttribute("data-jb-login-field", String(index));
    return { selector: '[data-jb-login-field="' + index + '"]', type: input.type, label: labelOf(input), autocomplete: (input.getAttribute("autocomplete") || "").slice(0, 40) };
  });
  const button = [...root.querySelectorAll('button,input[type="submit"],[role="button"]')].filter(visible).find(element => element.type === "submit") || [...root.querySelectorAll("button,input[type=submit]")].filter(visible)[0];
  let submit = null;
  if (button) {
    button.setAttribute("data-jb-login-submit", "1");
    submit = { selector: '[data-jb-login-submit="1"]', label: ((button.tagName === "INPUT" ? button.value : button.textContent) || "Continue").replace(/\\s+/g, " ").trim().slice(0, 40) || "Continue" };
  }
  return { fields, submit, title: document.title };
})()`;

export async function readBrowserLoginForm(page: Page): Promise<BrowserLoginForm> {
  const form = await page.evaluate(script) as Omit<BrowserLoginForm, "origin">;
  return { ...form, origin: new URL(page.url()).origin };
}
