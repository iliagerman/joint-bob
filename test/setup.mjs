import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = mkdtempSync(path.join(os.tmpdir(), "joint-bob-test-runner-"));
process.env.HOME = testHome;
if (process.platform === "darwin" || process.platform === "linux") {
  const testBin = path.join(testHome, "bin");
  mkdirSync(testBin, { mode: 0o700 });
  writeFileSync(path.join(testBin, "kiro-cli"), `#!${process.execPath}
const expected = ["chat", "--list-models", "--format", "json"];
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(expected)) {
  process.stderr.write(\`Unsupported kiro-cli fixture invocation: \${args.join(" ")}\\n\`);
  process.exit(2);
}
process.stdout.write('{"models":[{"model_id":"default","model_name":"Kiro default"}]}\\n');
`, { mode: 0o700 });
  process.env.PATH = `${testBin}${path.delimiter}${process.env.PATH}`;
}
process.env.JOINT_BOB_BIND_HOST = "127.0.0.1";
// Native-service launch settings must not leak into disposable test fixtures.
delete process.env.JOINT_BOB_RELEASE;
delete process.env.MASTER_BOB_RELEASE;
delete process.env.JOINT_BOB_INSECURE_COOKIE;
process.umask(0o022);
if (process.platform !== "win32") process.env.SHELL = "/bin/sh";
delete process.env.JOINT_BOB_DATA_DIR;
process.env.PI_WEB_DATA_DIR = path.join(testHome, "data");
mkdirSync(process.env.PI_WEB_DATA_DIR, { recursive: true });

process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));
