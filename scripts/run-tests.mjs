import { spawnSync } from "node:child_process";

// Test fixtures never need the attached production decision-service credential.
delete process.env.TYPESAFE_AI_API_KEY;
const env = { ...process.env };
delete env.TYPESAFE_AI_API_KEY;
const result = spawnSync(process.execPath, process.argv.slice(2), { cwd: process.cwd(), env, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
