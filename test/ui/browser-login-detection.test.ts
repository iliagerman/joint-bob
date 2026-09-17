import assert from "node:assert/strict";
import test from "node:test";
import { detectBrowserLogin } from "../../src/browser-login-detection.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("detects visible login and challenge DOM without reading field values", async t => {
  const { page } = await nativeUiFixture(t);
  const cases: Array<[string, "credentials" | "challenge" | null]> = [
    ['<form><input name="email"><input type="password"><button>Sign in</button></form>', "credentials"],
    ['<div role="form"><input name="email"><input type="password"><button>Sign in</button></div>', "credentials"],
    ['<div role="dialog"><input type="password" autocomplete="current-password"></div>', "credentials"],
    ['<form><input type="password" autocomplete="current-password"></form>', "credentials"],
    ['<form><input type="email"><button>Continue</button></form>', "credentials"],
    ['<form hidden><input name="email"><input type="password"><button>Sign in</button></form>', null],
    ['<form><input name="email"><input type="password" autocomplete="new-password"><button>Sign up</button></form>', null],
    ['<form><input type="password"><input type="password"><button>Change password</button></form>', null],
    ['<form><input type="email"><button>Subscribe</button></form>', null],
    ['<input autocomplete="one-time-code">', "challenge"],
    ['<iframe title="Complete CAPTCHA" srcdoc="safe"></iframe>', "challenge"],
    ['<iframe style="width:300px;height:200px" title="reCAPTCHA" src="https://captcha.example/frame?size=invisible" srcdoc="safe"></iframe>', null],
  ];
  for (const [html, expected] of cases) {
    await page.setContent(html);
    assert.equal(await detectBrowserLogin(page), expected, html);
  }
  await page.setContent('<form><input name="email" value="real-input-must-not-be-returned"><input type="password" value="secret"><button>Log in</button></form>');
  await page.evaluate(`window.__inputValueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"); Object.defineProperty(HTMLInputElement.prototype, "value", { configurable: true, get() { throw new Error("detector read credential value"); }, set: window.__inputValueDescriptor.set });`);
  try {
    assert.equal(await detectBrowserLogin(page), "credentials");
  } finally {
    await page.evaluate(`Object.defineProperty(HTMLInputElement.prototype, "value", window.__inputValueDescriptor); delete window.__inputValueDescriptor;`);
  }
});
