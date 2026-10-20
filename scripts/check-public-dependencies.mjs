#!/usr/bin/env node
// Run before npm ci and against the packed release. npm ships shrinkwrap, not package-lock.
import { readFileSync } from "node:fs";

export function checkPublicDependencies(lock, label) {
  if (!lock.packages || typeof lock.packages !== "object" || Object.keys(lock.packages).length < 2) {
    throw new Error(`${label}: missing locked packages`);
  }
  for (const [name, record] of Object.entries(lock.packages)) {
    if (!name) continue;
    const fail = (reason) => { throw new Error(`${label}: ${name}: ${reason}`); };
    if (!record || typeof record !== "object" || record.link) fail("linked dependencies cannot ship");
    let url;
    try { url = new URL(record.resolved); } catch { fail("missing or invalid resolved URL"); }
    if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.port || url.username || url.password || url.search || url.hash) {
      fail("dependency must use public HTTPS registry.npmjs.org without credentials");
    }
    if (typeof record.integrity !== "string" || !/^(sha512|sha1)-[A-Za-z0-9+/]+={0,2}$/.test(record.integrity)) {
      fail("missing or invalid integrity hash");
    }
  }
}

for (const file of process.argv.slice(2)) {
  checkPublicDependencies(JSON.parse(readFileSync(file, "utf8")), file);
  console.log(`Public dependency URLs verified: ${file}`);
}
