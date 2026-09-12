import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveDataDirectory } from "./data-directory.js";

export function profileDirectory(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid browser profile ID");
  return path.join(resolveDataDirectory(), "browser", "profiles", id);
}

export async function prepareProfile(id: string): Promise<string> {
  const directory = profileDirectory(id);
  await mkdir(path.join(directory, "Default"), { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(path.join(directory, "Default", "Preferences"), JSON.stringify({
      credentials_enable_service: false,
      profile: { password_manager_enabled: false },
    }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return directory;
}
