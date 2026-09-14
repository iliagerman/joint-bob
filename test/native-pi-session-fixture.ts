import { PiSession } from "../src/harnesses/pi/runtime.js";
import type { HarnessEvent } from "../src/harnesses/runtime.js";
import type { SharedHarnessSession } from "../src/server/harness-sessions.js";

interface FixtureOptions {
  id?: string;
  projectId?: string;
  cwd?: string;
  file?: string;
  abort?: () => Promise<void>;
  steering?: string[];
  followUp?: string[];
  busy?: boolean;
  dispose?: () => void;
}

export function nativePiSessionFixture(options: FixtureOptions = {}) {
  const id = options.id ?? "native-pi-session";
  const projectId = options.projectId ?? "native-pi-project";
  const cwd = options.cwd ?? "/tmp/native-pi-project";
  let listener: (event: unknown) => void = () => {};
  const nativeSession = {
    sessionId: id,
    sessionFile: options.file,
    sessionName: undefined,
    messages: [],
    model: { provider: "test", id: "test", name: "test" },
    thinkingLevel: "off",
    isStreaming: options.busy ?? false,
    isBashRunning: false,
    isCompacting: false,
    isRetrying: false,
    pendingMessageCount: 0,
    promptTemplates: [],
    subscribe(callback: (event: unknown) => void) { listener = callback; return () => { listener = () => {}; }; },
    getActiveToolNames: () => [],
    getAvailableThinkingLevels: () => ["off"],
    getContextUsage: () => undefined,
    getSteeringMessages: () => options.steering ?? [],
    getFollowUpMessages: () => options.followUp ?? [],
    clearQueue() {},
    abortRetry() {},
    abortCompaction() {},
    abortBranchSummary() {},
    abortBash() {},
    abort: options.abort ?? (async () => {}),
  };
  const handle = {
    session: nativeSession,
    safeguardsEnabled: true,
    dispose: options.dispose ?? (() => {}),
  };
  const session = new PiSession({ projectId, cwd, sessionId: id }, handle as never);
  const shared: SharedHarnessSession = {
    engine: "pi", projectId, cwd, session, clients: new Set(), turnInFlight: 0,
    lastLocalEventAt: 0, liveEvents: [], idleTimer: null, unsubscribe: () => {},
  };
  return {
    session,
    shared,
    handle,
    emitRaw(event: unknown) { listener(event); },
    emit(event: HarnessEvent) { listener(event); },
  };
}
