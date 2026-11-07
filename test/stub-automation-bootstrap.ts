// Test-only stand-ins for the agents Bob uses for automations and for arranging projects, which a dev node has none to run. Preloaded by
// test/control-center-automations-api.test.ts and test/control-center-organize-api.test.ts; nothing in src/ reads it.
// - intent.json in JOINT_BOB_TEST_AUTOMATION_DIR is what Bob's agent "answers" when it is asked what a message means.
// - report.txt in the same directory is the report Bob's agent "writes"; without the file the agent fails, as a node with no agent would.
// - organize.json is what Bob's agent "answers" when it is asked which workspace, project or conversation a message changes. Since
//   the node gives conversations their keys, "conversation-titled:<title>" in it stands for the key of the conversation with that title.
// - display.json is what Joint Bob's display agent "answers" for a message about how the app looks.
// - JOINT_BOB_TEST_REVIEW_CHECK_MS shortens the wait before Bob checks a conversation that stopped.
// - JOINT_BOB_TEST_RECHECK_MODEL_AFTER_MS shortens how old an open item must be before the decision model judges it.
import { readFile } from "node:fs/promises";
import path from "node:path";

if (process.env.NODE_ENV !== "test" || !process.env.JOINT_BOB_TEST_AUTOMATION_DIR) throw new Error("The automation stub requires NODE_ENV=test and JOINT_BOB_TEST_AUTOMATION_DIR");
const directory = process.env.JOINT_BOB_TEST_AUTOMATION_DIR;

// The chat and report modules load route modules when they load, so they are imported only once the server has registered its own and listens.
const { server } = await import("../src/server/state.js");
server.once("listening", () => {
  void import("../src/server/control-center-automation-chat.js").then(({ setAutomationInterpreter }) => setAutomationInterpreter(() => readFile(path.join(directory, "intent.json"), "utf8")));
  void import("../src/server/control-center-reports.js").then(({ setReportWriter }) => setReportWriter(() => readFile(path.join(directory, "report.txt"), "utf8")));
  void import("../src/server/control-center-organize.js").then(({ setOrganizeInterpreter }) => setOrganizeInterpreter(async ({ world }) => (await readFile(path.join(directory, "organize.json"), "utf8"))
    .replace(/"conversation-titled:([^"]+)"/g, (_match, title: string) => JSON.stringify(world.conversations.find((entry) => entry.title === title)?.key ?? "missing"))));
  void import("../src/server/control-center-display.js").then(({ setDisplayInterpreter }) => setDisplayInterpreter(() => readFile(path.join(directory, "display.json"), "utf8")));
  if (process.env.JOINT_BOB_TEST_REVIEW_CHECK_MS) void import("../src/server/control-center-review-check.js").then(({ setReviewCheckDelay }) => setReviewCheckDelay(Number(process.env.JOINT_BOB_TEST_REVIEW_CHECK_MS)));
  if (process.env.JOINT_BOB_TEST_RECHECK_MODEL_AFTER_MS) void import("../src/server/control-center-recheck.js").then(({ setRecheckModelDelay }) => setRecheckModelDelay(Number(process.env.JOINT_BOB_TEST_RECHECK_MODEL_AFTER_MS)));
});
