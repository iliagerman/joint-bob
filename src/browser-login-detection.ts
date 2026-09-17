import type { Page } from "playwright-core";

export const browserLoginDetectionScript = `(() => {
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden";
  const inputs = [...document.querySelectorAll("input")].filter(visible);
  if (inputs.some(input => (input.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/).includes("one-time-code"))) return "challenge";
  if ([...document.querySelectorAll("iframe")].filter(visible).some(frame => {
    const source = frame.getAttribute("src") || "";
    return !/[?&]size=invisible(?:&|$)/i.test(source) && /captcha|recaptcha|hcaptcha|challenges\\.cloudflare/i.test((frame.getAttribute("title") || "") + " " + source);
  })) return "challenge";
  if ([...document.querySelectorAll('[role="alert"]')].filter(visible).some(alert => /invalid|incorrect|wrong|failed/.test(alert.textContent.toLowerCase()) && /password|credentials?/.test(alert.textContent.toLowerCase()))) return "challenge";
  const submitLabel = form => [...form.querySelectorAll('button,input[type="submit"]')].filter(visible).map(element => element.tagName === "INPUT" ? element.getAttribute("value") || "" : element.textContent || "").join(" ").trim();
  const roots = [...document.querySelectorAll('form,[role="form"]')].filter(visible);
  for (const password of inputs.filter(input => input.type === "password" && !input.closest('form,[role="form"]'))) {
    const root = password.closest('[role="dialog"]') || document.body;
    if (visible(root) && !roots.includes(root)) roots.push(root);
  }
  for (const form of roots) {
    const fields = [...form.querySelectorAll("input")].filter(visible);
    const passwords = fields.filter(input => input.type === "password");
    const newPasswords = passwords.filter(input => (input.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/).includes("new-password"));
    const label = submitLabel(form);
    if (newPasswords.length || passwords.length > 1 || /sign up|register|create account|subscribe/i.test(label)) continue;
    const password = passwords[0];
    if (password) {
      const autocomplete = (password.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/);
      const identity = fields.some(input => ["email", "username"].includes((input.getAttribute("autocomplete") || "").toLowerCase()) || input.type === "email" || /user|email/.test((input.name || "") + " " + (input.id || "")));
      if (identity || autocomplete.includes("current-password") || /log in|login|sign in/i.test(label)) return "credentials";
    } else {
      const identity = fields.some(input => ["email", "username"].includes((input.getAttribute("autocomplete") || "").toLowerCase()) || input.type === "email" || /user|email/.test((input.name || "") + " " + (input.id || "")));
      if (identity && /log in|login|sign in|continue|next/i.test(label) && !/sign up|register|create account|subscribe/i.test(label)) return "credentials";
    }
  }
  return null;
})()`;

export function detectBrowserLogin(page: Page): Promise<"credentials" | "challenge" | null> {
  return page.evaluate(browserLoginDetectionScript) as Promise<"credentials" | "challenge" | null>;
}
