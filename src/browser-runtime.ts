import { constants } from "node:fs";
import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type BrowserContext, type Page, type CDPSession, type Dialog, type FileChooser, type Locator } from "playwright-core";
import { WebSocket } from "ws";
import { resolveDataDirectory } from "./data-directory.js";
import { getClusterNode } from "./cluster.js";
import { BrowserStore, type RecoveryState } from "./browser-store.js";
import { prepareProfile, profileDirectory } from "./browser-profile-files.js";
import { browserCommandSchema, browserStartSchema, type BrowserActor, type BrowserCapability, type BrowserCommand, type BrowserProfile, type BrowserSessionView, type BrowserStart } from "./browser-types.js";

interface DetectionOptions {
  platform?: string;
  executable?: string;
  candidates?: string[];
}

/** Detect installed browsers on this node; never download a browser. */
export async function browserCapability(options: DetectionOptions = {}): Promise<BrowserCapability> {
  const unavailable = (supported: boolean, reason: string): BrowserCapability => ({ supported, available: false, executable: null, reason });
  const override = options.executable ?? process.env.JOINT_BOB_BROWSER_EXECUTABLE;
  if (override && !path.isAbsolute(override)) return unavailable(true, "JOINT_BOB_BROWSER_EXECUTABLE must be an absolute executable path on this node.");
  const candidates = override ? [override] : options.candidates ?? await installedCandidates(options.platform ?? process.platform);
  for (const executable of candidates) {
    try {
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      return { supported: true, available: true, executable, reason: null };
    } catch { /* Try other installed locations, never install. */ }
  }
  return unavailable(true, override
    ? `Browser executable unavailable on this node: ${override}. Install Chrome and set JOINT_BOB_BROWSER_EXECUTABLE to its absolute executable path.`
    : "Chrome is not installed on this node. Install Google Chrome or Playwright Chromium, or set JOINT_BOB_BROWSER_EXECUTABLE to an installed absolute executable path.");
}

async function installedCandidates(platform: string): Promise<string[]> {
  const candidates = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", chromium.executablePath()];
  if (platform === "darwin") {
    for (const directory of ["/Applications", path.join(os.homedir(), "Applications")]) {
      candidates.unshift(path.join(directory, "Google Chrome.app/Contents/MacOS/Google Chrome"), path.join(directory, "Chromium.app/Contents/MacOS/Chromium"));
    }
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ms-playwright");
  for (const name of (await readdir(cache).catch(() => [] as string[])).sort().reverse()) {
    if (!/^chromium(?:_headless_shell)?-\d+$/.test(name)) continue;
    for (const binary of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-linux/headless_shell", "chrome-headless-shell-linux64/headless_shell"]) candidates.push(path.join(cache, name, binary));
  }
  return candidates;
}

export function validateBrowserUploads(files: Array<{ name: string; data: string }>): Array<{ name: string; buffer: Buffer }> {
  let bytes = 0;
  const names = new Set<string>();
  return files.map(file => {
    if (!file.name || /[\\\x00-\x1f:]/.test(file.name) || file.name.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Upload name must be a safe relative file path");
    if (names.has(file.name)) throw new Error("Duplicate upload name");
    names.add(file.name);
    if (file.data.length % 4 || /[^A-Za-z0-9+/=]/.test(file.data)) throw new Error("Upload data must be valid base64");
    const buffer = Buffer.from(file.data, "base64");
    if (buffer.toString("base64") !== file.data) throw new Error("Upload data must be canonical base64");
    bytes += buffer.length;
    if (bytes > 20 * 1024 * 1024) throw new Error("Uploads exceed cumulative 20 MiB limit");
    return { name: file.name, buffer };
  });
}

interface LiveSession {
  id: string;
  profileId: string;
  restoring: boolean;
  context: BrowserContext;
  pages: Map<string, Page>;
  activePageId: string | null;
  human: string | null;
  chooser: { id: string; pageId: string; page: Page; chooser: FileChooser } | null;
  dialog: { id: string; pageId: string; page: Page; dialog: Dialog } | null;
  dialogSignal?: () => void;
  downloads: BrowserSessionView["downloads"];
  transfers: Set<Promise<void>>;
  viewers: Set<WebSocket>;
  errors: string[];
  queue: Promise<unknown>;
  cdp?: CDPSession;
  streamGeneration: number;
  stopped: boolean;
  stopSignal: AbortController;
  stopping?: Promise<void>;
}
const profileLeases = new Set<string>();
const readOnly = new Set(["snapshot", "screenshot", "wait"]);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class BrowserRuntime {
  private readonly store = new BrowserStore();
  private readonly sessions = new Map<string, LiveSession>();
  private readonly viewerActors = new WeakMap<WebSocket, BrowserActor>();
  private readonly root = path.join(resolveDataDirectory(), "browser");
  private initialization?: Promise<void>;
  private readonly recoveries = new Map<string, Promise<void>>();
  private readonly cancelledRecoveries = new Set<string>();
  private creates: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly options: { capability?: () => Promise<BrowserCapability> } = {}) {}

  ready(): Promise<void> {
    return this.initialization ??= this.restore();
  }

  private async restore(): Promise<void> {
    const pending = this.store.list().filter(row => row.restoreOnRestart && row.profileId && !profileLeases.has(profileDirectory(row.profileId)));
    this.store.interruptRunning([...profileLeases].map(directory => path.basename(directory)));
    for (const row of pending) {
      const job = (async () => {
        try {
          const profile = this.store.profile(row.profileId!, row.projectId);
          if (!profile.persistent) throw new Error("Legacy browser profile requires explicit start");
          await this.launchSession(row, row.id, this.store.recovery(row.id));
        } catch (error) {
          if (!this.cancelledRecoveries.has(row.id)) this.store.finish(row.id, "interrupted", `Browser restore failed: ${message(error)}`, true);
        }
      })().finally(() => this.recoveries.delete(row.id));
      this.recoveries.set(row.id, job);
    }
    await Promise.all(this.recoveries.values());
  }

  create(input: BrowserStart): Promise<BrowserSessionView> {
    const start = browserStartSchema.parse(input);
    const job = this.creates.then(() => { void this.ready(); return this.createSession(start); });
    this.creates = job.catch(() => {});
    return job;
  }

  private async createSession(start: BrowserStart): Promise<BrowserSessionView> {
    if (this.closed) throw new Error("Browser runtime on this node is closed");
    const associated = this.store.list(start);
    if (!start.profileId && !start.profileName) {
      const ids = [...new Set(associated.map(row => row.profileId).filter((id): id is string => Boolean(id)).filter(id => this.store.profiles(start.projectId).some(profile => profile.id === id)))];
      if (ids.length > 1) throw new Error("Multiple browser profiles associated; supply explicit profileId");
      start = { ...start, profileId: ids[0] };
    }
    if (start.profileId) {
      this.store.profile(start.profileId, start.projectId);
      const existing = associated.find(row => row.state === "running" && row.profileId === start.profileId);
      if (existing) return this.view(existing.id);
      const pending = associated.find(row => row.restoreOnRestart && row.profileId === start.profileId);
      if (pending) {
        if (this.recoveries.has(pending.id)) return this.view(pending.id);
        return this.launchSession(start, pending.id, this.store.recovery(pending.id));
      }
      this.store.assertProfileUnused(start.profileId, start.projectId);
    } else {
      const capability = await (this.options.capability ?? browserCapability)();
      if (!capability.supported || !capability.available || !capability.executable) throw new Error(capability.reason || "Browser unavailable on this node");
      const labels = new Set(this.store.profiles(start.projectId).map(profile => profile.label));
      let label = "Default";
      for (let n = 2; labels.has(label); n++) label = `Default ${n}`;
      start = { ...start, profileId: this.store.createProfile(start.projectId, start.profileName ?? label).id };
    }
    return this.launchSession(start);
  }

  private async launchSession(start: BrowserStart, restoreId?: string, recovery?: RecoveryState): Promise<BrowserSessionView> {
    const profile = this.store.profile(start.profileId!, start.projectId);
    const lease = profileDirectory(profile.id);
    if (profileLeases.has(lease)) throw new Error("Browser profile already in use");
    profileLeases.add(lease);
    let context: BrowserContext | undefined;
    let session: LiveSession | undefined;
    let id = restoreId;
    try {
      // Reserve in SQLite before yielding to native launch or filesystem I/O.
      if (!id) id = this.store.create(start).id;
      const capability = await (this.options.capability ?? browserCapability)();
      if (!capability.supported || !capability.available || !capability.executable) throw new Error(capability.reason || "Browser unavailable on this node");
      const directory = await prepareProfile(profile.id);
      if (this.closed || (restoreId && this.cancelledRecoveries.has(restoreId))) throw new Error("Browser start cancelled");
      // server.ts owns TERM/INT shutdown. A second Playwright close force-kills Chrome before cookies flush.
      context = await chromium.launchPersistentContext(directory, { executablePath: capability.executable, headless: true, handleSIGTERM: false, handleSIGINT: false, args: ["--window-size=1100,740"], viewport: { width: 1100, height: 740 }, acceptDownloads: true });
      if (this.closed || (restoreId && this.cancelledRecoveries.has(restoreId))) throw new Error("Browser start cancelled");
      if (!profile.persistent) {
        try { await context.setStorageState(this.store.profileState(profile.id, start.projectId) as Parameters<BrowserContext["setStorageState"]>[0]); }
        catch { throw new Error("Browser profile import failed"); }
        if (this.closed || (restoreId && this.cancelledRecoveries.has(restoreId))) throw new Error("Browser start cancelled");
        this.store.markPersistent(profile.id, start.projectId);
      }
      context.setDefaultTimeout(10000);
      context.setDefaultNavigationTimeout(20000);
      const row = this.store.get(id);
      this.store.resume(id);
      session = { id: row.id, profileId: profile.id, restoring: true, context, pages: new Map(), activePageId: null, human: recovery ? recovery.human : null, chooser: null, dialog: null, downloads: [], transfers: new Set(), viewers: new Set(), errors: [], queue: Promise.resolve(), streamGeneration: 0, stopped: false, stopSignal: new AbortController() };
      this.sessions.set(row.id, session);
      const live = session;
      context.on("page", page => this.addPage(live, page));
      context.on("close", () => { if (!live.stopped) void this.stop(live, "interrupted", "Browser context stopped unexpectedly. Explicitly restart the session.", true); });
      await Promise.race([
        this.openSessionPages(session, start.url, recovery),
        new Promise<void>(resolve => session!.stopSignal.signal.addEventListener("abort", () => resolve(), { once: true })),
      ]);
      if (session.stopped) { await session.stopping; return this.view(row.id); }
      session.restoring = false;
      this.checkpoint(session);
      return this.view(row.id);
    } catch (error) {
      if (session) await this.stop(session, "interrupted", message(error), Boolean(restoreId));
      else {
        await context?.close().catch(() => {});
        if (id) this.store.finish(id, this.cancelledRecoveries.has(id) ? "closed" : "interrupted", message(error), Boolean(restoreId) && !this.cancelledRecoveries.has(id));
      }
      profileLeases.delete(lease);
      throw new Error(`Browser start failed on this node: ${message(error)}`);
    }
  }

  private async openSessionPages(session: LiveSession, url?: string, recovery?: RecoveryState): Promise<void> {
    // Keep a replacement tab alive before closing Chromium's startup tabs.
    // Never reuse or navigate startup action URLs.
    const startupPages = [...session.context.pages()];
    const urls = recovery ? recovery.origins : [url ?? "about:blank"];
    for (const target of urls.length ? urls : ["about:blank"]) {
      if (session.stopped) return;
      const page = await session.context.newPage();
      if (session.stopped) return;
      if (target !== "about:blank") await page.goto(target, { waitUntil: "domcontentloaded" });
    }
    if (session.stopped) return;
    for (const page of startupPages) {
      if (session.stopped) return;
      await page.close();
    }
    if (session.stopped) return;
    if (recovery) session.activePageId = [...session.pages.keys()][recovery.activeIndex] ?? null;
  }

  async list(identity?: { projectId?: string; engine?: string; conversationId?: string }): Promise<BrowserSessionView[]> {
    void this.ready();
    return Promise.all(this.store.list(identity).map(row => this.view(row.id)));
  }

  async get(id: string): Promise<BrowserSessionView> {
    void this.ready();
    return this.view(id);
  }

  private async view(id: string): Promise<BrowserSessionView> {
    const row = this.store.get(id);
    const live = this.sessions.get(id);
    const profileLabel = row.profileId ? this.store.profiles(row.projectId).find(profile => profile.id === row.profileId)?.label : undefined;
    return { ...row, nodeId: (await getClusterNode()).id, profileLabel, tabs: live ? await Promise.all([...live.pages].map(async ([id, page]) => ({ id, url: page.url(), title: live.restoring ? page.url() : await page.title().catch(() => page.url()) }))) : [], activePageId: live?.activePageId ?? null, owner: (live ? live.human : row.restoreOnRestart && this.store.recoveryHuman(id)) ? "human" : "agent", fileChooser: Boolean(live?.chooser), fileChooserRequest: live?.chooser ? { id: live.chooser.id, pageId: live.chooser.pageId } : null, dialog: live?.dialog ? { id: live.dialog.id, pageId: live.dialog.pageId, type: live.dialog.dialog.type(), message: live.dialog.dialog.message(), defaultValue: live.dialog.dialog.defaultValue() } : null, downloads: this.store.downloads(id) };
  }

  async profiles(projectId: string): Promise<BrowserProfile[]> { void this.ready(); return this.store.profiles(projectId); }
  async deleteProfile(id: string, projectId: string): Promise<void> {
    void this.ready();
    const job = this.creates.then(async () => {
      this.store.assertProfileUnused(id, projectId);
      if (profileLeases.has(profileDirectory(id))) throw new Error("Browser profile in use");
      await rm(profileDirectory(id), { recursive: true, force: true });
      this.store.deleteProfile(id, projectId);
    });
    this.creates = job.catch(() => {});
    return job;
  }

  async download(id: string, downloadId: string): Promise<{ path: string; name: string }> {
    void this.ready();
    this.store.get(id);
    const download = this.store.downloads(id).find(item => item.id === downloadId);
    if (!download?.ready) throw new Error(download?.error || "Browser download not found or not ready");
    const file = path.join(this.root, id, "downloads", download.id);
    await access(file);
    return { path: file, name: download.name };
  }

  execute(id: string, input: BrowserCommand, actor: BrowserActor): Promise<unknown> {
    // Admission stays synchronous, including while other profiles recover.
    void this.ready();
    let command: BrowserCommand;
    let session: LiveSession;
    try {
      command = browserCommandSchema.parse(input);
      if (actor.kind === "human" && (!actor.id || actor.id.length > 500)) throw new Error("Authenticated human actor ID must contain 1..500 characters");
      if (command.action === "close" && !this.sessions.has(id)) return this.endRecovery(id, actor);
      session = this.live(id);
      if (command.action === "dialog" || command.action === "upload") {
        this.authorize(session, command, actor);
        if (command.action === "upload" && command.selector) {
          if (actor.kind === "human" || command.requestId) throw new Error("Use the pending file chooser, not an upload selector, for a request response");
        } else {
          const pending = command.action === "dialog" ? session.dialog : session.chooser;
          if (actor.kind === "human" && (!command.requestId || !command.expectedPageId)) throw new Error("Human response requires the displayed request and page target");
          // Legacy agent commands mean the request pending at admission, never a
          // replacement that appears while this command waits in the queue.
          if (pending || command.requestId || command.expectedPageId || command.action === "dialog") {
            command = { ...command, requestId: command.requestId ?? pending?.id, expectedPageId: command.expectedPageId ?? pending?.pageId };
            this.assertPending(session, command, pending);
          }
          // With no pending chooser or supplied identity, a legacy agent upload
          // may wait for the preceding queued click to open its first chooser.
        }
      }
      // Control, dialogs, and End browser must remain usable even during an unbounded page promise.
      if (["takeControl", "resumeAgent", "dialog", "close"].includes(command.action)) {
        this.authorize(session, command, actor);
        if (command.action === "takeControl" && actor.kind === "human") session.human = actor.id;
        return this.run(session, command, actor).finally(() => this.broadcastState(session));
      }
      if (session.restoring) throw new Error("Browser profile is still restoring; retry when ready");
    } catch (error) { return Promise.reject(error); }
    const job = session.queue.then(async () => {
      this.live(id);
      this.authorize(session, command, actor); // Recheck after queued work, not at enqueue time.
      if (command.action === "upload") {
        if (command.selector) command = { ...command, expectedPageId: command.expectedPageId ?? session.activePageId ?? undefined };
        else if (!command.requestId && !command.expectedPageId) command = { ...command, requestId: session.chooser?.id, expectedPageId: session.chooser?.pageId };
      }
      if (command.expectedPageId && !(command.action === "upload" && !command.selector) && session.activePageId !== command.expectedPageId) throw new Error("Browser tab changed; input from an old page was discarded");
      try {
        const operation = this.run(session, command, actor);
        // Upload preparation cannot cause a blocking dialog. Keep its actual
        // result while immediate dialog responses and End remain available.
        if (command.action === "upload") return await operation;
        const dialog = new Promise<unknown>(resolve => { session.dialogSignal = () => resolve({ dialogPending: true }); });
        return await Promise.race([operation, dialog]);
      } finally { session.dialogSignal = undefined; this.broadcastState(session); }
    });
    session.queue = job.catch(() => {});
    return job;
  }

  private async endRecovery(id: string, actor: BrowserActor): Promise<BrowserSessionView> {
    const row = this.store.get(id);
    const recovery = this.recoveries.get(id);
    if (row.state !== "interrupted" || !row.restoreOnRestart || !row.profileId || (profileLeases.has(profileDirectory(row.profileId)) && !recovery)) throw new Error("Browser session is not an inactive recovery");
    if (actor.kind === "human") {
      if (!actor.id) throw new Error("Authenticated human required to end browser recovery");
    } else if (this.store.recovery(id).human) throw new Error("Browser is under human control; agent input paused");
    this.cancelledRecoveries.add(id);
    // Hold the SQLite lease while a native launch or close is still in flight.
    if (recovery) this.store.resume(id);
    this.store.setRestoreIntent(id, false);
    await recovery;
    this.store.finish(id, "closed");
    return this.view(id);
  }

  private authorize(session: LiveSession, command: BrowserCommand, actor: BrowserActor): void {
    if (command.action === "takeControl" || command.action === "resumeAgent") {
      if (actor.kind !== "human" || !actor.id) throw new Error("Only a human can change browser control");
      if (session.human && session.human !== actor.id && !(command.action === "takeControl" && command.force)) throw new Error("Browser control owned by another human; explicitly take over to recover control");
      if (command.action === "resumeAgent" && !session.human) throw new Error("Take control before resuming the agent");
      return;
    }
    if (readOnly.has(command.action)) return;
    if (actor.kind === "agent" && session.human) throw new Error("Browser is under human control; agent input paused");
    if (actor.kind === "human" && session.human !== actor.id) throw new Error(session.human ? "Browser control owned by another human" : "Take control before browser input");
  }

  private live(id: string): LiveSession {
    const session = this.sessions.get(id);
    if (!session || session.stopped) throw new Error("Browser session is not running. Explicitly restart it.");
    return session;
  }

  private page(session: LiveSession): Page {
    const page = session.activePageId ? session.pages.get(session.activePageId) : undefined;
    if (!page) throw new Error("No active browser tab. Open a new tab.");
    return page;
  }

  private locator(page: Page, selector: string): Locator {
    if (selector.startsWith("label=")) return page.getByLabel(selector.slice(6), { exact: true });
    // Playwright also accepts CSS, text=, role=button[name=Submit], and chained selectors.
    return page.locator(selector);
  }

  private assertPending(session: LiveSession, command: Extract<BrowserCommand, { action: "dialog" | "upload" }>, pending: { id: string; pageId: string; page: Page } | null): void {
    this.live(session.id);
    if (!pending || pending.id !== command.requestId || pending.pageId !== command.expectedPageId || session.pages.get(pending.pageId) !== pending.page) throw new Error("Browser request changed; response to an old dialog or file chooser was discarded");
  }

  private async run(session: LiveSession, command: BrowserCommand, actor: BrowserActor): Promise<unknown> {
    switch (command.action) {
      case "takeControl": // Actor id is assigned by execute, never trusted from the wire command.
        return this.get(session.id);
      case "resumeAgent": session.human = null; return this.get(session.id);
      case "close": await this.stop(session, "closed"); return this.get(session.id);
      case "saveProfile": return this.store.renameProfile(session.profileId, this.store.get(session.id).projectId, command.label);
      case "newTab": { const page = await session.context.newPage(); if (command.url) await page.goto(command.url, { waitUntil: "domcontentloaded" }); return this.get(session.id); }
      case "selectTab": {
        if (!session.pages.has(command.pageId)) throw new Error("Browser tab not found");
        session.activePageId = command.pageId; this.restartStream(session); return this.get(session.id);
      }
      case "closeTab": {
        const page = session.pages.get(command.pageId); if (!page) throw new Error("Browser tab not found");
        if (session.pages.size === 1) await this.stop(session, "closed");
        else await page.close();
        return this.get(session.id);
      }
      case "dialog": {
        const pending = session.dialog;
        this.assertPending(session, command, pending);
        // Consume before awaiting so a duplicate approval cannot race this one.
        session.dialog = null;
        if (command.accept) await pending!.dialog.accept(command.promptText); else await pending!.dialog.dismiss();
        return undefined;
      }
    }
    const page = this.page(session);
    switch (command.action) {
      case "navigate": await page.goto(command.url, { waitUntil: "domcontentloaded" }); break;
      case "back": await page.goBack({ waitUntil: "domcontentloaded" }); break;
      case "forward": await page.goForward({ waitUntil: "domcontentloaded" }); break;
      case "reload": await page.reload({ waitUntil: "domcontentloaded" }); break;
      case "click": await page.mouse.click(command.x, command.y, { button: command.button, clickCount: command.clickCount }); break;
      case "key": await page.keyboard.press(command.key); break;
      case "text": await page.keyboard.insertText(command.text); break;
      case "scroll": await page.mouse.wheel(command.x, command.y); break;
      case "clickElement": await this.locator(page, command.selector).click(); break;
      case "fill":
        if (command.expectedOrigin) {
          // Check in the same DOM turn that sets the value. Navigation during locator
          // resolution must not put a credential into a different origin's field.
          await this.locator(page, command.selector).evaluate((element, input) => {
            if (element.ownerDocument.location.origin !== input.origin) throw new Error("Browser origin changed; credential fill refused");
            if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || element.disabled || element.readOnly) throw new Error("Credential target must be an editable input or textarea");
            const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, "value")?.set;
            element.focus(); setter!.call(element, input.text);
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
          }, { origin: new URL(command.expectedOrigin).origin, text: command.text });
        } else await this.locator(page, command.selector).fill(command.text);
        break;
      case "select": await this.locator(page, command.selector).selectOption(command.values); break;
      case "check": await this.locator(page, command.selector).setChecked(command.checked); break;
      case "wait": await this.locator(page, command.selector).waitFor({ state: command.state }); break;
      case "evaluate": return page.evaluate(command.expression);
      case "snapshot": return { pageId: session.activePageId, url: page.url(), title: await page.title(), accessibility: (await page.locator("body").ariaSnapshot({ timeout: 5000 })).slice(0, 50000), errors: [...session.errors] };
      case "screenshot": return { pageId: session.activePageId, mimeType: "image/png", data: (await page.screenshot({ timeout: 10000 })).toString("base64") };
      case "upload": await this.upload(session, page, command, actor); break;
    }
    return this.get(session.id);
  }

  private async upload(session: LiveSession, page: Page, command: Extract<BrowserCommand, { action: "upload" }>, actor: BrowserActor): Promise<void> {
    const files = validateBrowserUploads(command.files);
    const chooser = command.selector ? null : session.chooser;
    if (!command.selector) this.assertPending(session, command, chooser);
    const target = command.selector ? await this.locator(page, command.selector).elementHandle() : chooser!.chooser.element();
    if (!target) throw new Error("No upload input found");
    const directory = await target.evaluate(element => (element as Element).hasAttribute("webkitdirectory"));
    const staging = path.join(this.root, session.id, "staging", randomUUID());
    try {
      this.live(session.id);
      await mkdir(staging, { recursive: true, mode: 0o700 });
      const paths: string[] = [];
      for (const file of files) {
        this.live(session.id);
        const destination = path.join(staging, file.name);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        this.live(session.id);
        await writeFile(destination, file.buffer, { mode: 0o600, flag: "wx" });
        paths.push(destination);
      }
      const roots = new Set(files.map(file => file.name.split("/")[0]));
      if (directory && (roots.size !== 1 || files.some(file => !file.name.includes("/")))) throw new Error("Directory uploads require one common relative root directory");
      const upload = directory ? path.join(staging, [...roots][0]) : paths;
      // File inspection and staging yield. Revalidate immediately before giving
      // Chrome the bytes, and never resolve a new chooser or selector here.
      this.live(session.id);
      this.authorize(session, command, actor);
      if (command.selector) {
        if (session.pages.get(command.expectedPageId!) !== page || session.activePageId !== command.expectedPageId) throw new Error("Browser tab changed; upload was discarded");
        await target.setInputFiles(upload);
      } else {
        this.assertPending(session, command, session.chooser);
        session.chooser = null;
        await chooser!.chooser.setFiles(upload);
      }
      // Chrome reads successful uploads lazily, until context close.
    } catch (error) {
      // End does not wait on page work. A write already in flight can finish
      // after its cleanup, so failed preparation must clean its own directory.
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private addPage(session: LiveSession, page: Page): void {
    const id = randomUUID();
    session.pages.set(id, page); session.activePageId = id;
    const report = (error: string) => { session.errors.push(error.slice(0, 2000)); if (session.errors.length > 50) session.errors.shift(); };
    page.on("console", entry => { if (entry.type() === "error" || entry.type() === "warning") report(`${entry.type()}: ${entry.text()}`); });
    page.on("pageerror", error => report(`JavaScript: ${error.message}`));
    page.on("requestfailed", request => report(`Request: ${request.url()} ${request.failure()?.errorText}`));
    page.on("response", response => { if (response.status() >= 400) report(`HTTP ${response.status()}: ${response.url()}`); });
    page.on("filechooser", chooser => { session.chooser = { id: randomUUID(), pageId: id, page, chooser }; this.broadcastState(session); });
    page.on("dialog", dialog => { session.dialog = { id: randomUUID(), pageId: id, page, dialog }; session.dialogSignal?.(); this.broadcastState(session); });
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) { if (session.chooser?.page === page) session.chooser = null; this.broadcastState(session); } });
    page.on("domcontentloaded", () => this.broadcastState(session));
    page.on("download", download => {
      const item = { id: randomUUID(), name: path.basename(download.suggestedFilename()).replace(/[\x00-\x1f]/g, "_") || "download", ready: false, error: undefined as string | undefined };
      session.downloads.push(item); this.store.saveDownload(session.id, item); this.broadcastState(session);
      const transfer = (async () => {
        const dir = path.join(this.root, session.id, "downloads"); await mkdir(dir, { recursive: true, mode: 0o700 });
        await download.saveAs(path.join(dir, item.id));
        const failure = await download.failure(); if (failure) throw new Error(failure);
        item.ready = true;
      })().catch(error => { item.error = message(error); }).finally(() => {
        this.store.saveDownload(session.id, item);
        session.transfers.delete(transfer);
        this.broadcastState(session);
      });
      session.transfers.add(transfer);
    });
    page.on("close", () => {
      session.pages.delete(id);
      if (session.chooser?.page === page) session.chooser = null;
      if (session.dialog?.page === page) session.dialog = null;
      if (session.activePageId === id) { session.activePageId = session.pages.keys().next().value ?? null; this.restartStream(session); }
      // A crashed context closes its pages before emitting context.close. Do
      // not replace the recovery snapshot with a shrinking shutdown tab list.
      this.publishState(session);
    });
    this.restartStream(session); this.broadcastState(session);
  }

  async attachViewer(id: string, ws: WebSocket, actor: BrowserActor): Promise<void> {
    void this.ready();
    const session = this.live(id);
    session.viewers.add(ws);
    this.viewerActors.set(ws, actor);
    ws.on("message", raw => {
      void (async () => {
        const text = raw.toString();
        if (Buffer.byteLength(text) > 30_000_000) throw new Error("Browser command too large");
        const envelope = JSON.parse(text);
        if (envelope.type !== "browserCommand") throw new Error("Expected browserCommand");
        await this.execute(id, browserCommandSchema.parse(envelope.command), actor);
      })().catch(error => this.send(ws, { type: "browserError", error: message(error) }));
    });
    ws.on("close", () => { session.viewers.delete(ws); if (!session.viewers.size) this.restartStream(session); });
    ws.on("error", () => { session.viewers.delete(ws); if (!session.viewers.size) this.restartStream(session); });
    this.send(ws, { type: "browserState", session: await this.get(id) });
    this.restartStream(session);
  }

  private send(ws: WebSocket, value: unknown): void {
    if (value && typeof value === "object" && "type" in value && value.type === "browserState" && "session" in value) {
      const view = value.session as BrowserSessionView;
      const actor = this.viewerActors.get(ws);
      value = { ...value, session: { ...view, canControl: actor?.kind === "human" && this.sessions.get(view.id)?.human === actor.id } };
    }
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1024 * 1024) ws.send(JSON.stringify(value), () => {});
  }

  private checkpoint(session: LiveSession): void {
    if (session.stopped) return;
    if (session.restoring) {
      this.store.checkpoint(session.id, { ...this.store.recovery(session.id), human: session.human });
      return;
    }
    if (!session.pages.size) return;
    const origins = [...session.pages.values()].slice(0, 100).map(page => {
      const url = new URL(page.url());
      return ["http:", "https:"].includes(url.protocol) ? url.origin : "about:blank";
    });
    this.store.checkpoint(session.id, { origins, activeIndex: Math.min(99, [...session.pages.keys()].indexOf(session.activePageId!)), human: session.human });
  }

  private broadcastState(session: LiveSession): void {
    this.checkpoint(session);
    this.publishState(session);
  }

  private publishState(session: LiveSession): void {
    if (!session.viewers.size) return;
    void this.view(session.id).then(view => { for (const ws of session.viewers) this.send(ws, { type: "browserState", session: view }); }).catch(() => {});
  }

  private restartStream(session: LiveSession): void {
    const generation = ++session.streamGeneration;
    const previous = session.cdp; session.cdp = undefined;
    void (async () => {
      await previous?.detach().catch(() => {});
      if (session.stopped || !session.viewers.size || !session.activePageId) return;
      const id = session.activePageId;
      const page = session.pages.get(id); if (!page) return;
      const cdp = await session.context.newCDPSession(page);
      if (generation !== session.streamGeneration) { await cdp.detach(); return; }
      session.cdp = cdp;
      await page.bringToFront();
      cdp.on("Page.screencastFrame", frame => {
        if (generation === session.streamGeneration) for (const ws of session.viewers) this.send(ws, { type: "browserFrame", pageId: id, data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight });
        void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      });
      // Never resize individual pages or screencast output: Playwright preserves popup window features.
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 75, everyNthFrame: 1 });
    })().catch(error => { if (!session.stopped && generation === session.streamGeneration) for (const ws of session.viewers) this.send(ws, { type: "browserError", error: message(error) }); });
  }

  private stop(session: LiveSession, state: "closed" | "interrupted", error?: string, restoreOnRestart = false): Promise<void> {
    if (session.stopping) return session.stopping;
    if (state === "closed") this.cancelledRecoveries.add(session.id);
    this.checkpoint(session);
    session.stopped = true;
    session.stopSignal.abort();
    return session.stopping = (async () => {
      this.store.setRestoreIntent(session.id, restoreOnRestart);
      this.restartStream(session);
      await session.context.close().catch(() => {});
      try {
        this.store.finish(session.id, state, error, restoreOnRestart);
        await Promise.all(session.transfers);
        await rm(path.join(this.root, session.id, "staging"), { recursive: true, force: true });
      } finally { await this.releaseSession(session); }
    })();
  }

  private async releaseSession(session: LiveSession): Promise<void> {
    session.pages.clear(); session.activePageId = null; session.chooser = null; session.dialog = null;
    profileLeases.delete(profileDirectory(session.profileId));
    session.queue = Promise.resolve();
    this.sessions.delete(session.id);
    try {
      const view = await this.view(session.id);
      for (const ws of session.viewers) this.send(ws, { type: "browserState", session: view });
    } finally {
      for (const ws of session.viewers) ws.close(1000, "Browser session ended");
      session.viewers.clear(); session.errors.length = 0; session.downloads.length = 0;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    return this.closing = (async () => {
      const stopping = Promise.allSettled([...this.sessions.values()].map(session => this.stop(session, "interrupted", "Browser runtime stopped; profile will restore on restart.", true)));
      await this.initialization;
      await this.creates;
      const stopped = await stopping;
      for (const session of this.sessions.values()) for (const ws of session.viewers) ws.close(1001, "Browser runtime on this node stopped");
      this.store.close();
      const errors = stopped.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Browser shutdown failed");
    })();
  }
}
