import assert from "node:assert/strict";
import test from "node:test";
import { conversationProjects, conversationsChanged, placeConversationsWith, resetSharedProjectListings, sessionListingChanged, sharedProjectListing } from "../src/session-listing-revisions.js";

function counter() {
  const computed: string[] = [];
  const list = (projectId: string, viewer = "ilia", now?: number, state = "") => sharedProjectListing(projectId, `${projectId}:${viewer}`, async () => { computed.push(`${projectId}:${viewer}`); return computed.length; }, state, now);
  return { computed, list };
}

test("pages and lists asking for the same project together share one computation", async () => {
  resetSharedProjectListings();
  const { computed, list } = counter();
  // Two open pages, each asking for the running list and the review inbox.
  const answers = await Promise.all([list("a"), list("a"), list("a"), list("a"), list("b")]);
  assert.deepEqual(computed, ["a:ilia", "b:ilia"]);
  assert.deepEqual(answers, [1, 1, 1, 1, 2]);
  await list("a", "someone-else");
  assert.equal(computed.length, 3, "another person's list is their own");
});

test("a change in one project recomputes that project only", async () => {
  resetSharedProjectListings();
  const { computed, list } = counter();
  await Promise.all([list("a"), list("b"), list("c")]);
  sessionListingChanged("b");
  await Promise.all([list("a"), list("b"), list("c")]);
  assert.deepEqual(computed.slice(3), ["b:ilia"]);
  sessionListingChanged();
  await Promise.all([list("a"), list("b"), list("c")]);
  assert.equal(computed.length, 7, "a change that names no project reaches all of them");
});

test("an answer in flight when the project changes is not kept as current", async () => {
  resetSharedProjectListings();
  const release = Promise.withResolvers<string>();
  let computations = 0;
  const list = () => sharedProjectListing("a", "a", () => { computations += 1; return computations === 1 ? release.promise : Promise.resolve("after the change"); });
  const first = list();
  sessionListingChanged("a");
  const second = list();
  release.resolve("before the change");
  assert.equal(await first, "before the change", "the request already waiting gets what it asked for and is told to ask again");
  assert.equal(await second, "after the change");
  assert.equal(await list(), "after the change");
  assert.equal(computations, 2);
});

test("an unannounced change is seen within a minute, or at once when the caller read it, and a failure is not kept", async () => {
  resetSharedProjectListings();
  const { computed, list } = counter();
  const start = Date.now();
  await list("a", "ilia", start);
  await list("a", "ilia", start + 59_000);
  assert.equal(computed.length, 1, "pages asking every fifteen seconds reuse the answer");
  await list("a", "ilia", start + 60_000);
  assert.equal(computed.length, 2);
  // What the caller read just now differs from what the kept answer was computed against.
  await list("a", "ilia", start + 60_001, "a terminal session started");
  await list("a", "ilia", start + 60_002, "a terminal session started");
  assert.equal(computed.length, 3, "state that changed without an announcement computes again at once");

  let attempts = 0;
  const failing = () => sharedProjectListing("z", "z", async () => { attempts += 1; if (attempts === 1) throw new Error("disk went away"); return "ok"; });
  await assert.rejects(failing(), /disk went away/);
  assert.equal(await failing(), "ok");
});

// With a few conversations running, something starts, stops or reports progress every few
// seconds. Marking every project for it threw every kept answer away on almost every request.
test("a change to one conversation recomputes only the project it belongs to", async (t) => {
  resetSharedProjectListings();
  placeConversationsWith((engine, sessionId) => engine === "pi" && sessionId === "in-b" ? ["b"] : engine === "claude" && sessionId === "in-a-and-c" ? ["a", "c"] : []);
  t.after(() => placeConversationsWith(undefined));
  const { computed, list } = counter();
  await Promise.all([list("a"), list("b"), list("c")]);

  conversationsChanged([{ engine: "pi", sessionId: "in-b" }]);
  await Promise.all([list("a"), list("b"), list("c")]);
  assert.deepEqual(computed.slice(3), ["b:ilia"]);
  conversationsChanged([{ engine: "claude", sessionId: "in-a-and-c" }]);
  await Promise.all([list("a"), list("b"), list("c")]);
  assert.deepEqual(computed.slice(4).sort(), ["a:ilia", "c:ilia"]);

  assert.equal(conversationProjects([{ engine: "pi", sessionId: "in-b" }, { engine: "pi", sessionId: "unknown" }]), undefined);
  conversationsChanged([{ engine: "pi", sessionId: "unknown" }]);
  await Promise.all([list("a"), list("b"), list("c")]);
  assert.equal(computed.length, 9, "a conversation that cannot be placed reaches every project, as before");
  conversationsChanged([]);
  await Promise.all([list("a"), list("b"), list("c")]);
  assert.equal(computed.length, 9, "nothing changed, nothing recomputed");
});
