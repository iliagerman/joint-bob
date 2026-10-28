import assert from "node:assert/strict";
import { test } from "node:test";
import { piSdkStatus } from "../src/pi-sdk.js";
import { checkPiSdkSwitch, configurePiSdkSwitch, pendingPiSdkVersion, piHarnessInstalled } from "../src/pi-sdk-switch.js";

test("a newly installed Pi restarts Joint Bob only once nothing is running, and a refused restart is retried", async () => {
  // This test process found no managed harness, so any installed version is new to it.
  assert.equal(piSdkStatus.harnessVersion, null);
  let idle = false, attempts = 0, refuse = true;
  configurePiSdkSwitch({
    idle: () => idle,
    restart: async () => { attempts += 1; if (refuse) throw new Error("Interrupted work is still recovering"); },
  });
  piHarnessInstalled("9.9.9");
  assert.equal(pendingPiSdkVersion(), "9.9.9");
  assert.equal(attempts, 0, "a running turn defers the restart");
  idle = true;
  checkPiSdkSwitch();
  assert.equal(attempts, 1);
  await new Promise((resolve) => setImmediate(resolve));
  refuse = false;
  checkPiSdkSwitch();
  assert.equal(attempts, 2, "a refused restart is tried again");
  checkPiSdkSwitch();
  assert.equal(attempts, 2, "a restart under way is not started twice");
});
