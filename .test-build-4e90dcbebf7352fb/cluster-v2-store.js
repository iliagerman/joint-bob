import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureClusterIdentitySchema } from "./cluster-identity.js";
import { ensureClusterProtocolSchema } from "./cluster-protocol.js";
import { ensureClusterSharingPolicySchema } from "./cluster-sharing-policy.js";
import { ensureTwinSchema } from "./cluster-twins.js";
import { resolveDataDirectory } from "./data-directory.js";
let databasePromise;
async function clusterV2Database() {
  databasePromise ??= (async () => {
    const directory = resolveDataDirectory();
    await mkdir(directory, { recursive: true, mode: 448 });
    const database = new DatabaseSync(path.join(directory, "node.db"));
    database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    ensureClusterIdentitySchema(database);
    ensureClusterProtocolSchema(database);
    ensureClusterSharingPolicySchema(database);
    ensureTwinSchema(database);
    return database;
  })();
  return databasePromise;
}
export {
  clusterV2Database
};
