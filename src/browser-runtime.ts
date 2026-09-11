import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession, type Dialog, type FileChooser, type Locator } from "playwright-core";
import { WebSocket } from "ws";
import { resolveDataDirectory } from "./data-directory.js";
import { BrowserStore } from "./browser-store.js";
import { browserCommandSchema, browserStartSchema, type BrowserActor, type BrowserCapability, type BrowserCommand, type BrowserProfile, type BrowserSessionView, type BrowserStart } from "./browser-types.js";

interface DetectionOptions {
  platform?: string;
  osRelease?: string;
  executable?: string;
  candidates?: string[];
}

/** Detection never downloads a browser or treats an Ubuntu derivative as Ubuntu. */
export async function browserCapability(options: DetectionOptions = {}): Promise<BrowserCapability> {
  const unavailable = (supported: boolean, reason: string): BrowserCapability => ({ supported, available: false, executable: null, reason });
  if ((options.platform ?? process.platform) !== "linux") return unavailable(false, "Browser executor requires Ubuntu. Select an Ubuntu executor node.");
  const release = options.osRelease ?? await readFile("/etc/os-release", "utf8").catch(() => "");
  if (!/^ID=(?:ubuntu|"ubuntu"|'ubuntu')\s*$/m.test(release)) return unavailable(false, "Browser executor requires Ubuntu, not another Linux distribution. Select an Ubuntu executor node.");
  const override = options.executable ?? process.env.JOINT_BOB_BROWSER_EXECUTABLE;
  if (override && !path.isAbsolute(override)) return unavailable(true, "JOINT_BOB_BROWSER_EXECUTABLE must be an absolute executable path on this Ubuntu node.");
  const candidates = options.candidates ?? await installedCandidates();
  for (const executable of override ? [override] : candidates) {
    try {
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      return { supported: true, available: true, executable, reason: null };
    } catch { /* Try other installed locations, never install. */ }
  }
  return unavailable(true, override
    ? `Browser executable unavailable: ${override}. Install Chrome and set JOINT_BOB_BROWSER_EXECUTABLE to its absolute executable path.`
    : "Chrome is not installed on this Ubuntu executor. Install Google Chrome or Playwright Chromium, or set JOINT_BOB_BROWSER_EXECUTABLE to an installed absolute executable path.");
}

async function installedCandidates(): Promise<string[]> {
  const candidates = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", chromium.executablePath()];
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

type Proxy = { server: string; close: () => Promise<void> };
interface LiveSession {
  id: string;
  context: BrowserContext;
  proxy: Proxy;
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
  stopping?: Promise<void>;
}
const readOnly = new Set(["snapshot", "screenshot", "wait"]);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class BrowserRuntime {
  private readonly store = new BrowserStore();
  private readonly sessions = new Map<string, LiveSession>();
  private readonly viewerActors = new WeakMap<WebSocket, BrowserActor>();
  private readonly root = path.join(resolveDataDirectory(), "browser");
  private browser?: Promise<Browser>;
  private creates: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly options: { proxyFor: (start: BrowserStart) => Promise<Proxy>; capability?: () => Promise<BrowserCapability> }) {
    this.store.interruptRunning();
  }

  create(input: BrowserStart): Promise<BrowserSessionView> {
    const start = browserStartSchema.parse(input);
    const job = this.creates.then(() => this.createSession(start));
    this.creates = job.catch(() => {});
    return job;
  }

  private async createSession(start: BrowserStart): Promise<BrowserSessionView> {
    if (this.closed) throw new Error("Browser executor is closed");
    const existing = this.store.list(start).find(row => row.state === "running");
    if (existing) {
      if (existing.appNodeId !== start.appNodeId || existing.profileId !== start.profileId) throw new Error("Browser session conflict: app node or profile differs from the running conversation");
      return this.get(existing.id);
    }
    const capability = await (this.options.capability ?? browserCapability)();
    if (!capability.supported || !capability.available || !capability.executable) throw new Error(capability.reason || "Browser executor unavailable");
    const storageState = start.profileId ? this.store.profileState(start.profileId, start.projectId) as Awaited<ReturnType<BrowserContext["storageState"]>> : undefined;
    const browser = await this.getBrowser(capability.executable);
    const proxy = await this.options.proxyFor(start);
    let context: BrowserContext | undefined;
    let session: LiveSession | undefined;
    try {
      context = await browser.newContext({ proxy: { server: proxy.server, bypass: "<-loopback>" }, viewport: { width: 1100, height: 740 }, acceptDownloads: true, storageState });
      context.setDefaultTimeout(10000);
      context.setDefaultNavigationTimeout(20000);
      const row = this.store.create(start);
      session = { id: row.id, context, proxy, pages: new Map(), activePageId: null, human: null, chooser: null, dialog: null, downloads: [], transfers: new Set(), viewers: new Set(), errors: [], queue: Promise.resolve(), streamGeneration: 0, stopped: false };
      this.sessions.set(row.id, session);
      const live = session;
      context.on("page", page => this.addPage(live, page));
      context.on("close", () => { if (!live.stopped) void this.stop(live, "interrupted", "Browser context stopped unexpectedly. Explicitly restart the session."); });
      const page = await context.newPage();
      if (start.url) await page.goto(start.url, { waitUntil: "domcontentloaded" });
      return this.get(row.id);
    } catch (error) {
      if (session) await this.stop(session, "interrupted", message(error));
      else { await context?.close().catch(() => {}); await proxy.close().catch(() => {}); }
      throw new Error(`Browser start failed on this executor: ${message(error)}`);
    }
  }

  private async getBrowser(executablePath: string): Promise<Browser> {
    if (!this.browser) {
      this.browser = chromium.launch({ executablePath, headless: true, args: ["--window-size=1100,740"] }).then(browser => {
        browser.on("disconnected", () => {
          this.browser = undefined;
          for (const session of this.sessions.values()) if (!session.stopped) void this.stop(session, "interrupted", "Chrome disconnected. Explicitly restart the session.");
        });
        return browser;
      }).catch(error => { this.browser = undefined; throw new Error(`Unable to start Chrome on this executor: ${message(error)}`); });
    }
    return this.browser;
  }

  async list(identity?: { projectId?: string; engine?: string; conversationId?: string }): Promise<BrowserSessionView[]> {
    return Promise.all(this.store.list(identity).map(row => this.get(row.id)));
  }

  async get(id: string): Promise<BrowserSessionView> {
    const row = this.store.get(id);
    const live = this.sessions.get(id);
    return { ...row, tabs: live ? await Promise.all([...live.pages].map(async ([id, page]) => ({ id, url: page.url(), title: await page.title().catch(() => page.url()) }))) : [], activePageId: live?.activePageId ?? null, owner: live?.human ? "human" : "agent", fileChooser: Boolean(live?.chooser), fileChooserRequest: live?.chooser ? { id: live.chooser.id, pageId: live.chooser.pageId } : null, dialog: live?.dialog ? { id: live.dialog.id, pageId: live.dialog.pageId, type: live.dialog.dialog.type(), message: live.dialog.dialog.message(), defaultValue: live.dialog.dialog.defaultValue() } : null, downloads: this.store.downloads(id) };
  }

  async profiles(projectId: string): Promise<BrowserProfile[]> { return this.store.profiles(projectId); }
  async deleteProfile(id: string, projectId: string): Promise<void> { this.store.deleteProfile(id, projectId); }

  async download(id: string, downloadId: string): Promise<{ path: string; name: string }> {
    this.store.get(id);
    const download = this.store.downloads(id).find(item => item.id === downloadId);
    if (!download?.ready) throw new Error(download?.error || "Browser download not found or not ready");
    const file = path.join(this.root, id, "downloads", download.id);
    await access(file);
    return { path: file, name: download.name };
  }

  execute(id: string, input: BrowserCommand, actor: BrowserActor): Promise<unknown> {
    let command: BrowserCommand;
    let session: LiveSession;
    try {
      command = browserCommandSchema.parse(input);
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
      case "saveProfile": return this.store.saveProfile(this.store.get(session.id).projectId, command.label, await session.context.storageState({ indexedDB: true }));
      case "newTab": { const page = await session.context.newPage(); if (command.url) await page.goto(command.url, { waitUntil: "domcontentloaded" }); return this.get(session.id); }
      case "selectTab": {
        if (!session.pages.has(command.pageId)) throw new Error("Browser tab not found");
        session.activePageId = command.pageId; this.restartStream(session); return this.get(session.id);
      }
      case "closeTab": {
        const page = session.pages.get(command.pageId); if (!page) throw new Error("Browser tab not found");
        await page.close(); return this.get(session.id);
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
      this.broadcastState(session);
    });
    this.restartStream(session); this.broadcastState(session);
  }

  async attachViewer(id: string, ws: WebSocket, actor: BrowserActor): Promise<void> {
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

  private broadcastState(session: LiveSession): void {
    if (!session.viewers.size) return;
    void this.get(session.id).then(view => { for (const ws of session.viewers) this.send(ws, { type: "browserState", session: view }); }).catch(() => {});
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

  private stop(session: LiveSession, state: "closed" | "interrupted", error?: string): Promise<void> {
    if (session.stopping) return session.stopping;
    session.stopped = true;
    return session.stopping = (async () => {
      this.store.finish(session.id, state, error);
      this.restartStream(session);
      await session.context.close().catch(() => {});
      await Promise.all(session.transfers);
      await session.proxy.close().catch(() => {});
      await rm(path.join(this.root, session.id, "staging"), { recursive: true, force: true });
      session.pages.clear(); session.activePageId = null; session.chooser = null; session.dialog = null;
      const view = await this.get(session.id);
      for (const ws of session.viewers) {
        this.send(ws, { type: "browserState", session: view });
        ws.close(1000, "Browser session ended");
      }
      session.viewers.clear(); session.errors.length = 0; session.downloads.length = 0;
      session.queue = Promise.resolve();
      this.sessions.delete(session.id);
    })();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    return this.closing = (async () => {
      await this.creates;
      await Promise.all([...this.sessions.values()].map(session => this.stop(session, "interrupted", "Browser executor stopped. Explicitly restart the session.")));
      for (const session of this.sessions.values()) for (const ws of session.viewers) ws.close(1001, "Browser executor stopped");
      await (await this.browser?.catch(() => undefined))?.close();
      this.store.close();
    })();
  }
}
