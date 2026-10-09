import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function generateTotpSecret() {
  return [...randomBytes(32)].map((byte) => alphabet[byte & 31]).join("");
}
function decodeSecret(secret) {
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw new Error("Invalid TOTP setup key");
  const bytes = [];
  let value = 0;
  let bits = 0;
  for (const char of secret) {
    value = value << 5 | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push(value >>> bits & 255);
    }
  }
  return Buffer.from(bytes);
}
function verifyTotp(secret, code, now = Date.now(), lastUsedStep = -1) {
  if (!/^\d{6}$/.test(code)) return void 0;
  const key = decodeSecret(secret);
  const current = Math.floor(now / 3e4);
  for (const step of [current, current - 1, current + 1]) {
    if (step < 0 || step <= lastUsedStep) continue;
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const mac = createHmac("sha1", key).update(counter).digest();
    const value = (mac.readUInt32BE(mac[mac.length - 1] & 15) & 2147483647) % 1e6;
    if (timingSafeEqual(Buffer.from(String(value).padStart(6, "0")), Buffer.from(code))) return step;
  }
  return void 0;
}
export {
  generateTotpSecret,
  verifyTotp
};
