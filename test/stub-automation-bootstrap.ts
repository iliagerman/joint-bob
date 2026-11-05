// Test-only stand-ins for the two agents Bob's automations use, which a dev node has none to run. Preloaded by
// test/control-center-automations-api.test.ts; nothing in src/ reads it.
// - intent.json in JOINT_BOB_TEST_AUTOMATION_DIR is what Bob's agent "answers" when it is asked what a message means.
// - report.txt in the same directory is the report Bob's agent "writes"; without the file the agent fails, as a node with no agent would.
import { readFile } from "node:fs/promises";
import path from "node:path";

if (process.env.NODE_ENV !== "test" || !process.env.JOINT_BOB_TEST_AUTOMATION_DIR) throw new Error("The automation stub requires NODE_ENV=test and JOINT_BOB_TEST_AUTOMATION_DIR");
const directory = process.env.JOINT_BOB_TEST_AUTOMATION_DIR;

// The chat and report modules load route modules when they load, so they are imported only once the server has registered its own and listens.
const { server } = await import("../src/server/state.js");
server.once("listening", () => {
  void import("../src/server/control-center-automation-chat.js").then(({ setAutomationInterpreter }) => setAutomationInterpreter(() => readFile(path.join(directory, "intent.json"), "utf8")));
  void import("../src/server/control-center-reports.js").then(({ setReportWriter }) => setReportWriter(() => readFile(path.join(directory, "report.txt"), "utf8")));
});
