import { settingsDatabase, value, save } from "./settings-store.js";

/**
 * Whether this node may hold more than one person. A second user needs the machine wall:
 * every person runs under their own OS account, and the self-test proved two accounts can't
 * reach each other's files, processes or ports. Until then "Add user" stays off.
 */
export interface MultiUserStatus {
  ready: boolean;
  helperInstalled: boolean;
  selfTest: { passed: boolean; at: string | null; failures: string[] };
}

/** Disposable test nodes can't install a root helper; they prove the app wall alone. */
function testOverride(): boolean {
  return process.env.NODE_ENV === "test" && process.env.JOINT_BOB_TEST_MULTI_USER_READY === "1";
}

export function multiUserStatus(): MultiUserStatus {
  let selfTest: MultiUserStatus["selfTest"] = { passed: false, at: null, failures: [] };
  try { selfTest = { ...selfTest, ...JSON.parse(value("multiUser.selfTest", "{}")) as Partial<MultiUserStatus["selfTest"]> }; } catch { /* a malformed record is a failed one */ }
  const helperInstalled = value("multiUser.helperInstalled", "false") === "true";
  if (testOverride()) return { ready: true, helperInstalled: true, selfTest: { passed: true, at: selfTest.at, failures: [] } };
  return { ready: helperInstalled && selfTest.passed, helperInstalled, selfTest };
}

export function recordSelfTest(passed: boolean, failures: string[], helperInstalled: boolean): MultiUserStatus {
  const db = settingsDatabase();
  save(db, "multiUser.selfTest", JSON.stringify({ passed, at: new Date().toISOString(), failures: failures.slice(0, 20) }));
  save(db, "multiUser.helperInstalled", String(helperInstalled));
  return multiUserStatus();
}
