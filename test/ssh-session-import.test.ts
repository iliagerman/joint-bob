import assert from "node:assert/strict";
import test from "node:test";
import { parseMobaSshSession } from "../public/app/ssh-session-import.js";

test("imports host, port and username from a single MobaXterm SSH bookmark", () => {
  const data = "[Bookmarks]\r\nSubRep=\r\nImgNum=42\r\nSynthetic server=#109#0%192.0.2.10%3985%deploy%ignored%fields\r\n";
  assert.deepEqual(parseMobaSshSession(data), { host: "192.0.2.10", port: "3985", username: "deploy" });
  assert.deepEqual(parseMobaSshSession("[Bookmarks]\nServer= #109#0%example.org%22%%%"), { host: "example.org", port: "22", username: "" });
});

test("MobaXterm import rejects unsupported, ambiguous and unsafe sessions", () => {
  const bookmark = "Test=#109#0%192.0.2.10%3985%%%";
  assert.throws(() => parseMobaSshSession(`[Bookmarks]\n${bookmark}\nAnother=#109#0%example.org%22%%`), /one SSH session/);
  assert.throws(() => parseMobaSshSession("[Bookmarks]\nOther=#108#0%192.0.2.10%3985%%"), /one SSH session/);
  assert.throws(() => parseMobaSshSession("[Bookmarks]\nBad=#109#0%192.0.2.10%65536%%"), /invalid host or port/);
  assert.throws(() => parseMobaSshSession("[Bookmarks]\nBad=#109#0%host;command%22%%"), /invalid host or port/);
});
