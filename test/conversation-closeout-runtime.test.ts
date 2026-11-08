import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { beginConversationCloseout, finishConversationCloseout, type CloseoutRuntime } from "../src/server/conversation-closeout.js";
import { sessionDoneOverrides, sessionFeedbackOverrides, setSessionDone, setSessionFeedback } from "../src/names.js";
import { addRule, listProposals, readSubjects, writeNote } from "../src/project-knowledge.js";
import type { ProjectRecord } from "../src/types.js";

const lesson = { subject: "tests", text: "Run the focused tests before committing.", evidence: "Skipped a failing test" };
const runtime = (): CloseoutRuntime => ({
  load: async () => ({ lastHarness: "pi", messages: [{ id: "m1", role: "user", text: "Fix this", timestamp: "2020-01-01T00:00:00Z" }] }),
  models: () => ({ classify: async () => "bad", describe: async () => ({ description: "Tests were skipped.", rules: [lesson] }), select: async () => [0] }),
});

async function fixture(run: (project: ProjectRecord, id: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "closeout-runtime-"));
  const project = { id: randomUUID(), path: root } as ProjectRecord;
  const id = randomUUID();
  try { await run(project, id); }
  finally { await setSessionFeedback(id, null); await setSessionDone(id, false); await rm(root, { recursive: true, force: true }); }
}

test("automatic closeout marks Done, persists inferred feedback, and proposes rather than installs a rule", async () => {
  await fixture(async (project, id) => {
    const record = await beginConversationCloseout(project, "pi", id, null);
    assert.ok((await sessionDoneOverrides())[id]);
    assert.equal(record.status, "pending");
    assert.equal(await finishConversationCloseout(project, id, record, runtime()), undefined);
    const saved = (await sessionFeedbackOverrides())[id];
    assert.equal(saved.source, "automatic");
    assert.equal(saved.status, "complete");
    assert.deepEqual(saved.feedback, { rating: "bad", description: "Tests were skipped." });
    assert.equal(listProposals(project.path)[0].text, lesson.text);
    assert.deepEqual(readSubjects(project.path), [], "rules still need manual acceptance");
  });
});

test("an unimportant closeout never reads the transcript or calls a model", async () => {
  await fixture(async (project, id) => {
    const record = await beginConversationCloseout(project, "pi", id, { rating: "unimportant", description: "" });
    const boundary = runtime();
    boundary.load = async () => { throw new Error("must not run"); };
    assert.equal(await finishConversationCloseout(project, id, record, boundary), undefined);
    assert.equal((await sessionFeedbackOverrides())[id].status, "complete");
    assert.ok((await sessionDoneOverrides())[id]);
    assert.deepEqual(listProposals(project.path), []);
  });
});

test("a failed review remains Done with a visible error and can resume after interruption", async () => {
  await fixture(async (project, id) => {
    const record = await beginConversationCloseout(project, "pi", id, { rating: "bad", description: "" });
    const failed = runtime();
    failed.models = () => ({ ...runtime().models(project, id, { messages: [], lastHarness: "pi" }), select: async () => { throw new Error("Decision model offline"); } });
    assert.equal(await finishConversationCloseout(project, id, record, failed), "Decision model offline");
    const saved = (await sessionFeedbackOverrides())[id];
    assert.equal(saved.status, "error");
    assert.equal(saved.error, "Decision model offline");
    assert.ok((await sessionDoneOverrides())[id]);
    assert.deepEqual(listProposals(project.path), []);
    await finishConversationCloseout(project, id, saved, runtime());
    assert.equal((await sessionFeedbackOverrides())[id].status, "complete");
    assert.equal((await sessionFeedbackOverrides())[id].error, undefined);
    assert.equal(listProposals(project.path).length, 1);
  });
});

test("a manual unimportant rating arriving during automatic inference wins", async () => {
  await fixture(async (project, id) => {
    const automatic = await beginConversationCloseout(project, "pi", id, null);
    const boundary = runtime();
    boundary.models = () => ({
      classify: async () => "bad",
      describe: async () => {
        await beginConversationCloseout(project, "pi", id, { rating: "unimportant", description: "" });
        return { description: "Old inference", rules: [lesson] };
      }, select: async () => [0],
    });
    await finishConversationCloseout(project, id, automatic, boundary);
    assert.equal((await sessionFeedbackOverrides())[id].feedback?.rating, "unimportant");
    assert.deepEqual(listProposals(project.path), []);
  });
});

test("reopening while feedback is inferred invalidates that work", async () => {
  await fixture(async (project, id) => {
    const record = await beginConversationCloseout(project, "pi", id, { rating: "good", description: "" });
    const boundary = runtime();
    boundary.models = () => ({
      classify: async () => "good",
      describe: async () => {
        await setSessionFeedback(id, null);
        await setSessionDone(id, false);
        return { description: "Old inference", rules: [lesson] };
      }, select: async () => [0],
    });
    await finishConversationCloseout(project, id, record, boundary);
    assert.equal((await sessionDoneOverrides())[id], undefined);
    assert.equal((await sessionFeedbackOverrides())[id], undefined);
    assert.deepEqual(listProposals(project.path), []);
  });
});

test("new interaction during automatic classification reopens instead of applying lessons", async () => {
  await fixture(async (project, id) => {
    const record = await beginConversationCloseout(project, "pi", id, null);
    const boundary = runtime();
    let loads = 0;
    boundary.load = async () => ({ lastHarness: "pi", messages: [{ id: "m1", role: "user", text: "Hi", timestamp: loads++ ? new Date().toISOString() : "2020-01-01T00:00:00Z" }] });
    await finishConversationCloseout(project, id, record, boundary);
    assert.equal((await sessionDoneOverrides())[id], undefined);
    assert.deepEqual(listProposals(project.path), []);
  });
});

test("accepted and dismissed rules are not proposed again", async () => {
  await fixture(async (project, id) => {
    addRule(project.path, lesson);
    const record = await beginConversationCloseout(project, "pi", id, { rating: "bad", description: "" });
    await finishConversationCloseout(project, id, record, runtime());
    assert.deepEqual(listProposals(project.path), []);
    assert.equal(readSubjects(project.path)[0].rules.length, 1);
    writeNote(project.path, { conversationId: id, updatedAt: new Date().toISOString(), problems: [], dismissed: ["another lesson"] });
    const next = await beginConversationCloseout(project, "pi", id, { rating: "good", description: "" });
    const boundary = runtime();
    boundary.models = () => ({ classify: async () => "good", describe: async () => ({ description: "Done", rules: [{ ...lesson, text: "Another lesson." }] }), select: async () => [0] });
    await finishConversationCloseout(project, id, next, boundary);
    assert.deepEqual(listProposals(project.path), []);
  });
});

// Each hourly sweep retried every failed closeout (about 500 on the homeserver), rewriting and
// replicating the same error and logging it every time.
test("a closeout that fails the same way again is not rewritten or logged again", async () => {
  await fixture(async (project, id) => {
    const record = await beginConversationCloseout(project, "pi", id, { rating: "bad", description: "" });
    const failed = runtime();
    failed.models = () => ({ ...runtime().models(project, id, { messages: [], lastHarness: "pi" }), select: async () => { throw new Error("Decision model offline"); } });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      assert.equal(await finishConversationCloseout(project, id, record, failed), "Decision model offline");
      const stored = (await sessionFeedbackOverrides())[id];
      assert.equal(await finishConversationCloseout(project, id, stored, failed), "Decision model offline");
      assert.deepEqual((await sessionFeedbackOverrides())[id], stored, "the stored error is left as it was");
      assert.equal(warnings.filter((line) => line.includes(id)).length, 1, "logged once");
    } finally { console.warn = warn; }
  });
});
