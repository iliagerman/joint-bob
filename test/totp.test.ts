import assert from "node:assert/strict";
import test from "node:test";

test("TOTP matches RFC 6238 SHA-1 vectors, preserves leading zeroes and limits clock skew", async () => {
  const { verifyTotp, generateTotpSecret } = await import("../src/totp.js");
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  // RFC 6238 Appendix B's eight-digit values reduced to six digits.
  for (const [seconds, code] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]] as const) {
    const step = Math.floor(seconds / 30);
    assert.equal(verifyTotp(secret, code, seconds * 1000), step);
    assert.equal(verifyTotp(secret, code, seconds * 1000, step), undefined, "used time steps cannot replay");
  }
  assert.equal(verifyTotp(secret, "287082", 30_000), 1);
  assert.equal(verifyTotp(secret, "287082", 60_000), 1);
  assert.equal(verifyTotp(secret, "287082", 90_000), undefined);
  for (const invalid of ["28708", "0287082", "abcdef", "", "287082junk"]) assert.equal(verifyTotp(secret, invalid, 59_000), undefined);
  const keys = Array.from({ length: 20 }, generateTotpSecret);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.match(key, /^[A-Z2-7]{32}$/);
});
