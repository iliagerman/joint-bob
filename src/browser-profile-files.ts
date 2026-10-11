import { chmod, cp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { serviceRuntime, type RuntimeAccount } from "./account-runtime.js";
import { resolveDataDirectory } from "./data-directory.js";

/** A profile's place in the service's own data. It is also the name a profile is held under
    while a browser has it open, wherever its files really are. */
export function profileDirectory(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid browser profile ID");
  return path.join(resolveDataDirectory(), "browser", "profiles", id);
}

/**
 * A folder for the browser inside a person's home (multi-user mode): their browser runs as
 * their own account and keeps its logins, uploads and downloads there. The service makes the
 * folder, so a link planted in its place is never followed out of the home.
 */
export async function accountBrowserDirectory(runtime: RuntimeAccount, ...segments: string[]): Promise<string> {
  if (!runtime.name) throw new Error("The service's own browser has no account folder");
  const directory = path.join(runtime.home, ".joint-bob-browser", ...segments);
  // Not chmod: the service reaches the home through an access list, and narrowing the mode would cut it.
  await mkdir(directory, { recursive: true, mode: 0o770 });
  if (await realpath(directory) !== path.join(await realpath(runtime.home), ".joint-bob-browser", ...segments)) throw new Error("This account's browser folder is a link; remove it and try again");
  return directory;
}

/** Where a profile's files are: in the person's home when their browser runs as their account. */
export async function profileLocation(id: string, runtime: RuntimeAccount): Promise<string> {
  const own = profileDirectory(id);
  return runtime.name ? path.join(await accountBrowserDirectory(runtime, "profiles"), id) : own;
}

export async function prepareProfile(id: string, runtime: RuntimeAccount = serviceRuntime()): Promise<string> {
  const directory = await profileLocation(id, runtime);
  if (runtime.name) {
    // A profile from before the person had an account moves into their home once.
    const before = profileDirectory(id);
    if (!await stat(directory).catch(() => undefined) && await stat(before).catch(() => undefined)) {
      await cp(before, directory, { recursive: true, errorOnExist: true, force: false });
      await rm(before, { recursive: true, force: true });
    }
    await accountBrowserDirectory(runtime, "profiles", id, "Default");
  } else {
    await mkdir(path.join(directory, "Default"), { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  try {
    await writeFile(path.join(directory, "Default", "Preferences"), JSON.stringify({
      credentials_enable_service: false,
      profile: { password_manager_enabled: false },
    }), { flag: "wx", mode: runtime.name ? 0o660 : 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return directory;
}
