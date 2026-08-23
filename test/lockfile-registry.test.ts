import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

test("package lockfile package entries use public HTTPS registries with SRI", async () => {
  const rawLockfile = await readFile("package-lock.json", "utf8");
  assert.doesNotMatch(rawLockfile, /100\.83\.230\.57/);
  assert.doesNotMatch(rawLockfile, /http:\/\//);

  const lockfile = JSON.parse(rawLockfile) as { packages: Record<string, unknown> };
  const packageEntries = Object.entries(lockfile.packages).filter(([path, entry]) => {
    return path !== "" && !(entry && typeof entry === "object" && (entry as Record<string, unknown>).link === true);
  });
  assert.ok(packageEntries.length > 0, "lockfile must contain non-root, non-link package entries");

  const urls: string[] = [];
  for (const [path, entry] of packageEntries) {
    assert.ok(entry && typeof entry === "object", `${path} must be a package record`);
    const record = entry as Record<string, unknown>;
    const { resolved, integrity } = record;
    assert.ok(typeof resolved === "string", `${path} must have a resolved URL`);
    assert.ok(typeof integrity === "string" && /^(sha512|sha1)-/.test(integrity), `${path} must have a sha512 or sha1 integrity hash`);
    urls.push(resolved);

    const url = new URL(resolved);
    assert.equal(url.protocol, "https:", `${resolved} must use HTTPS`);
    assert.equal(url.hostname === "localhost" || url.hostname.endsWith(".localhost"), false, `${resolved} uses localhost`);
    assert.equal(url.hostname === "::1" || url.hostname === "[::1]" || isPrivateIpv4(url.hostname), false, `${resolved} uses a private or loopback IP`);
    assert.equal(url.hostname.endsWith(".local") || url.hostname.endsWith(".homeserver"), false, `${resolved} uses a local registry hostname`);
  }

  assert.equal(urls.length, packageEntries.length, "every checked package must contribute one resolved URL");
});
