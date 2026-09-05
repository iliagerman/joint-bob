import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Source-text assertions used to read one file. The server now lives in
 * `src/server.ts` plus `src/server/**`, and the app shell in `public/app.js`
 * plus `public/app/**`, so these read the whole module set in a stable order.
 */
async function concatenate(files: string[]): Promise<string> {
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  return contents.join("\n");
}

async function listFiles(directory: string, extension: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  // Files before subdirectories, so helpers read before the routes that use them.
  const sorted = entries.sort((left, right) => Number(left.isDirectory()) - Number(right.isDirectory()) || left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of sorted) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full, extension));
    else if (entry.name.endsWith(extension)) files.push(full);
  }
  return files;
}

export async function serverSource(): Promise<string> {
  return concatenate(["src/server.ts", ...await listFiles("src/server", ".ts")]);
}

export async function appSource(): Promise<string> {
  return concatenate(["public/app.js", ...await listFiles("public/app", ".js")]);
}
