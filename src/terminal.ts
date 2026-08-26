import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class TerminalLaunchError extends Error {}

async function launchTerminal(directory: string): Promise<void> {
  const configuredExecutable = process.env.JOINT_BOB_TERMINAL_EXECUTABLE?.trim();
  if (configuredExecutable) {
    await execFileAsync(configuredExecutable, [directory]);
    return;
  }
  if (process.platform === "darwin") {
    await execFileAsync("open", ["-a", "Terminal", directory]);
    return;
  }
  if (process.platform === "linux") {
    await execFileAsync("x-terminal-emulator", ["--working-directory", directory]);
    return;
  }
  throw new TerminalLaunchError(`Opening a terminal is not supported on ${process.platform}`);
}

export async function openTerminal(directory: string): Promise<void> {
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) throw new TerminalLaunchError("Project path is not a directory on this node");
    await launchTerminal(directory);
  } catch (error) {
    if (error instanceof TerminalLaunchError) throw error;
    throw new TerminalLaunchError("Could not open a terminal on this node");
  }
}
