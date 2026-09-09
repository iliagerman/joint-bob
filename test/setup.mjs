import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = mkdtempSync(path.join(os.tmpdir(), "joint-bob-test-runner-"));
process.env.HOME = testHome;
process.env.JOINT_BOB_BIND_HOST = "127.0.0.1";
delete process.env.JOINT_BOB_DATA_DIR;
process.env.PI_WEB_DATA_DIR = path.join(testHome, "data");
mkdirSync(process.env.PI_WEB_DATA_DIR, { recursive: true });

process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));
