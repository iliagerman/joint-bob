import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let temporaryDataDirectory: string | undefined;

function canonicalDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  try {
    return realpathSync.native(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw error;
  }
}

function isProductionDataDirectory(directory: string): boolean {
  const resolved = canonicalDirectory(directory);
  return [os.homedir(), os.userInfo().homedir]
    .some((home) => resolved === canonicalDirectory(path.join(home, ".joint-bob")));
}

function createTemporaryDataDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "joint-bob-node-test-"));
  temporaryDataDirectory = directory;
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function resolveDataDirectory(configured = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR): string {
  if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== "test") return configured ?? path.join(os.homedir(), ".joint-bob");
  if (configured && isProductionDataDirectory(configured)) {
    throw new Error("Test process cannot use the production Joint Bob data directory");
  }
  return configured ?? temporaryDataDirectory ?? createTemporaryDataDirectory();
}
