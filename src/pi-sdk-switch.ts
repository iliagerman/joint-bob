import { piSdkStatus } from "./pi-sdk.js";

/**
 * A newly installed Pi harness takes effect when Joint Bob restarts: this process keeps running
 * the frozen copy it started with. The restart happens once no conversation turn is running,
 * through the same path a release update uses, so a turn that starts meanwhile resumes after it.
 */
export interface PiSdkSwitchHooks { idle(): boolean; restart(): Promise<void> }

const IDLE_CHECK_MS = 60_000;
let hooks: PiSdkSwitchHooks | undefined;
let pendingVersion: string | null = null;
let timer: NodeJS.Timeout | undefined;
let restarting = false;

/** Only an installed node can restart itself: its supervisor starts it again. */
export function configurePiSdkSwitch(value: PiSdkSwitchHooks): void { hooks = value; }

export function pendingPiSdkVersion(): string | null { return pendingVersion; }

/** After the harness update: a version other than the one this process found waits for a restart. */
export function piHarnessInstalled(version: string): void {
  if (version === piSdkStatus.harnessVersion) return;
  pendingVersion = version;
  if (!hooks) return;
  if (!timer) { timer = setInterval(checkPiSdkSwitch, IDLE_CHECK_MS); timer.unref(); }
  checkPiSdkSwitch();
}

export function checkPiSdkSwitch(): void {
  if (!hooks || !pendingVersion || restarting || !hooks.idle()) return;
  restarting = true;
  console.log(`Restarting Joint Bob to run Pi ${pendingVersion}; no conversation turn is running.`);
  hooks.restart().catch((error) => {
    restarting = false;
    console.warn(`Restart for Pi ${pendingVersion} postponed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
