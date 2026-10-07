import { execFileSync } from "node:child_process";
import type { DevEnvironment, SeededNode } from "./dev-nodes.js";

/** Runs `body` (an ES module body with top-level await) against a seeded node's own data
    directory and returns what it prints. Never touches the real ~/.joint-bob. */
export function runOnNode(environment: DevEnvironment, node: SeededNode, body: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", body], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir, NODE_ENV: "test" },
    encoding: "utf8",
  });
}

/** Adds a member to a running node and returns their one-time password. */
export function addMember(environment: DevEnvironment, node: SeededNode, username: string, email: string): { userId: string; accountId: string; oneTimePassword: string } {
  const output = runOnNode(environment, node, `
    const { createLocalUser } = await import("./src/auth.ts");
    const { runAsAccount } = await import("./src/account-context.ts");
    const { seedPersonalSettings } = await import("./src/settings.ts");
    const { saveWorkspace } = await import("./src/store.ts");
    const created = createLocalUser({ username: ${JSON.stringify(username)}, email: ${JSON.stringify(email)} });
    // What the Users route does for a new person.
    seedPersonalSettings(created.user.accountId);
    await runAsAccount({ accountId: created.user.accountId, userId: created.user.userId, username: created.user.username, email: created.user.email, role: "member", isRemoteLogin: false, homeNodeId: null }, () => saveWorkspace({ label: "Personal", id: "personal" }));
    process.stdout.write(JSON.stringify({ userId: created.user.userId, accountId: created.user.accountId, oneTimePassword: created.oneTimePassword }));
  `);
  return JSON.parse(output.trim().split("\n").at(-1)!) as { userId: string; accountId: string; oneTimePassword: string };
}
