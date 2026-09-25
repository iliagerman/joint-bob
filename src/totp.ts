import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 32 uniformly random base32 symbols carry 160 bits, as recommended by RFC 4226. */
export function generateTotpSecret(): string {
  return [...randomBytes(32)].map(byte => alphabet[byte & 31]).join("");
}

function decodeSecret(secret: string): Buffer {
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw new Error("Invalid TOTP setup key");
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238: SHA-1, six digits, 30 seconds. Returns the consumed step, never a boolean. */
export function verifyTotp(secret: string, code: string, now = Date.now(), lastUsedStep = -1): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const key = decodeSecret(secret);
  const current = Math.floor(now / 30_000);
  for (const step of [current, current - 1, current + 1]) {
    if (step < 0 || step <= lastUsedStep) continue;
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const mac = createHmac("sha1", key).update(counter).digest();
    const value = (mac.readUInt32BE(mac[mac.length - 1] & 15) & 0x7fffffff) % 1_000_000;
    if (timingSafeEqual(Buffer.from(String(value).padStart(6, "0")), Buffer.from(code))) return step;
  }
  return undefined;
}
