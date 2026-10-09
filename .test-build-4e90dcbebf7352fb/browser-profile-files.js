import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveDataDirectory } from "./data-directory.js";
function profileDirectory(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid browser profile ID");
  return path.join(resolveDataDirectory(), "browser", "profiles", id);
}
async function prepareProfile(id) {
  const directory = profileDirectory(id);
  await mkdir(path.join(directory, "Default"), { recursive: true, mode: 448 });
  await chmod(directory, 448);
  try {
    await writeFile(path.join(directory, "Default", "Preferences"), JSON.stringify({
      credentials_enable_service: false,
      profile: { password_manager_enabled: false }
    }), { flag: "wx", mode: 384 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return directory;
}
export {
  prepareProfile,
  profileDirectory
};
