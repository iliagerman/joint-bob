// Seeds a fresh promo environment, starts its nodes and keeps them up until interrupted.
// For looking at the staged data in a browser while working on the capture.
//
//   node --import tsx promo-video/capture/serve.ts --root <dir>      (run from the repository root)
import { loadEnvironment, pairTwins, seed, startNode, stopNode } from "./env.js";
import { existsSync } from "node:fs";
import path from "node:path";

const rootIndex = process.argv.indexOf("--root");
const root = rootIndex === -1 ? undefined : process.argv[rootIndex + 1];
if (!root) throw new Error("--root <dir> is required");

const environment = existsSync(path.join(root, "environment.json")) ? await loadEnvironment(root) : await seed(root);
const fresh = !existsSync(path.join(root, "paired"));
const children = await Promise.all(environment.nodes.map((node) => startNode(node, (line) => console.log(line))));
if (fresh) {
  await pairTwins(environment);
  (await import("node:fs")).writeFileSync(path.join(root, "paired"), "");
}
console.log(`READY ${environment.nodes.map((node) => `${node.name} ${node.url}`).join(" | ")}`);

const stop = async (): Promise<void> => { await Promise.all(children.map(stopNode)); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
