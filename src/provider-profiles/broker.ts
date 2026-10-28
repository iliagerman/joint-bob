import { chmod, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Cross-process migration/login/logout gate, separate from the SDK refresh lock.
 * Never steal a lock on a timer: a suspended writer could otherwise reseed tokens.
 * A crash leaves a fail-closed lock requiring operator removal after stopping service.
 */
export async function withProfileAuthority<T>(authPath: string, work: () => Promise<T>): Promise<T> {
  const directory = path.dirname(authPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lock = path.join(directory, ".authority-lock");
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Profile authority unavailable");
      if (Date.now() >= deadline) throw new Error("Profile authority busy; retry or contact the node administrator");
      await delay(25);
    }
  }
  try { return await work(); }
  finally { await rmdir(lock); }
}
