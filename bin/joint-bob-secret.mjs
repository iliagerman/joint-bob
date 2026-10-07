#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { secretAgentAccounts, secretAgentAccountEnvironment } from "../dist/secret-agent.js";

const usage = "Usage: joint-bob-secret list | run ACCOUNT_ID -- COMMAND [ARGS...]";

async function main() {
  const token = process.env.JOINT_BOB_SECRET_TOKEN;
  if (!token) throw new Error("Secret account access is unavailable outside a Joint Bob conversation");
  const [verb, accountId, separator, command, ...args] = process.argv.slice(2);
  if (verb === "list" && !accountId) {
    console.log(JSON.stringify(secretAgentAccounts(token)));
    return;
  }
  if (verb !== "run" || !/^[0-9a-f-]{36}$/i.test(accountId ?? "") || separator !== "--" || !command) throw new Error(usage);
  const { values, removeNames } = secretAgentAccountEnvironment(token, accountId);
  const env = { ...process.env };
  for (const name of removeNames) delete env[name];
  delete env.JOINT_BOB_SECRET_TOKEN;
  Object.assign(env, values);
  const child = spawn(command, args, { env, stdio: "inherit" });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1)));
  });
  process.exitCode = exitCode;
}

main().catch((error) => {
  // Error paths never print variable values or the credential-bearing environment.
  console.error(error instanceof Error ? error.message : "Secret command failed");
  process.exitCode = 1;
});
