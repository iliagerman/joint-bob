import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteItem, deletePersonalAssistant, getPersonalAssistant, listSavedItems, personalAssistantContext, saveItem, savedImage, savePersonalAssistant } from "../src/personal-assistants.js";

test("personal assistant stores instructions and paired source images, scoped to its owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-assistant-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = root;
  try {
    const profile = await savePersonalAssistant("owner", { projectId: "project", engine: "pi", sessionId: "session", name: "Phones", instructions: "Compare prices" });
    assert.equal((await getPersonalAssistant("other", profile.id)), undefined);
    const picture = Buffer.from("fake-screenshot");
    const entry = await saveItem("owner", profile.id, { collection: "Phones", title: "Phone offer", url: "https://example.test/listing", note: "Used", images: [{ name: "screen.png", mimeType: "image/png", data: picture.toString("base64") }] });
    assert.ok(entry);
    assert.equal(entry.url, "https://example.test/listing");
    assert.deepEqual((await savedImage("owner", profile.id, entry.id, "0.png"))?.bytes, picture);
    assert.equal(await savedImage("other", profile.id, entry.id, "0.png"), undefined);
    assert.match(await personalAssistantContext("owner", "project", "pi", "session"), /https:\/\/example.test\/listing/);
    assert.equal(await personalAssistantContext("other", "project", "pi", "session"), "");
    assert.equal(await deleteItem("other", profile.id, entry.id), false);
    assert.equal((await listSavedItems("owner", profile.id))?.length, 1);
    assert.equal(await deletePersonalAssistant("owner", profile.id), true);
    assert.equal(await savedImage("owner", profile.id, entry.id, "0.png"), undefined);
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
