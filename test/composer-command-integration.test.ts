import assert from "node:assert/strict";
import test from "node:test";
import { dispatchComposerInput, executeComposerCommand } from "../public/composer-commands.js";

function commandHandlers(calls: Array<[string, string]>) {
  return {
    help: (argument: string) => calls.push(["help", argument]),
    skills: (argument: string) => calls.push(["skills", argument]),
    model: (argument: string) => calls.push(["model", argument]),
    tools: (argument: string) => calls.push(["tools", argument]),
    compact: (argument: string) => calls.push(["compact", argument]),
  };
}

test("composer commands execute UI actions instead of becoming prompts", () => {
  const calls: Array<[string, string]> = [];
  const prompts: string[] = [];
  const handlers = commandHandlers(calls);

  for (const command of ["/help", "/skills", "/skill", "/skils", "/model", "/tools", "/compact keep decisions"]) {
    assert.equal(dispatchComposerInput(command, false, handlers, (message) => prompts.push(message)), "command");
  }

  assert.deepEqual(calls, [
    ["help", ""],
    ["skills", ""],
    ["skills", ""],
    ["skills", ""],
    ["model", ""],
    ["tools", ""],
    ["compact", "keep decisions"],
  ]);
  assert.deepEqual(prompts, []);
});

test("agent commands, unknown slash text, and messages remain prompts", () => {
  const calls: Array<[string, string]> = [];
  const prompts: string[] = [];
  const handlers = commandHandlers(calls);

  for (const message of ["/skill:debugging", "/review", "/unknown", "inspect the tests"]) {
    assert.equal(dispatchComposerInput(message, false, handlers, (prompt) => prompts.push(prompt)), "prompt");
  }

  assert.deepEqual(calls, []);
  assert.deepEqual(prompts, ["/skill:debugging", "/review", "/unknown", "inspect the tests"]);
});

test("attachments keep slash-looking text on the prompt path", () => {
  const calls: Array<[string, string]> = [];
  const prompts: string[] = [];

  assert.equal(dispatchComposerInput("/tools", true, commandHandlers(calls), (message) => prompts.push(message)), "prompt");
  assert.deepEqual(calls, []);
  assert.deepEqual(prompts, ["/tools"]);
});

test("autocomplete can execute a selected built-in command directly", () => {
  const calls: Array<[string, string]> = [];

  assert.equal(executeComposerCommand("/tools ", commandHandlers(calls)), true);
  assert.equal(executeComposerCommand("/skill:debugging ", commandHandlers(calls)), false);
  assert.deepEqual(calls, [["tools", ""]]);
});
