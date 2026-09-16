import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startSupervisor } from "../../scripts/joint-bob-supervisor.mjs";
import { supervisorRequest } from "../../scripts/supervisor-client.mjs";
import { nativeUiFixture } from "./native-ui-fixture.js";

const UUID_A = "00000000-0000-4000-8000-000000000201";
const UUID_B = "00000000-0000-4000-8000-000000000202";
const FAILURE_JSON = "/tmp/jb-task-browser-failure.json";
const FAILURE_PNG = "/tmp/jb-task-browser-failure.png";

type BrowserDiagnostic = { type: string; message?: string; pathname?: string; status?: number };

function attachDiagnostics(page: Awaited<ReturnType<typeof nativeUiFixture>>["page"]) {
  const diagnostics: BrowserDiagnostic[] = [];
  const add = (diagnostic: BrowserDiagnostic) => {
    if (diagnostics.length < 100) diagnostics.push(diagnostic);
  };
  const pathname = (url: string) => {
    try { return new URL(url).pathname; } catch { return "<invalid-url>"; }
  };
  page.on("pageerror", (error) => add({ type: "pageerror", message: error.message.slice(0, 200) }));
  page.on("requestfailed", (request) => add({ type: "requestfailed", pathname: pathname(request.url()), message: (request.failure()?.errorText ?? "unknown").slice(0, 200) }));
  page.on("response", (response) => {
    if (response.status() >= 400) add({ type: "response", status: response.status(), pathname: pathname(response.url()) });
  });
  page.on("console", (message) => {
    if (message.type() === "error") add({ type: "console", message: message.text().slice(0, 200) });
  });
  return diagnostics;
}

async function recordFailure(page: Awaited<ReturnType<typeof nativeUiFixture>>["page"], diagnostics: BrowserDiagnostic[]) {
  let state: unknown;
  try {
    state = await page.evaluate(() => {
      let bootText = "";
      for (const element of document.querySelectorAll('[role="alert"], [role="status"], [id*="error" i], [id*="status" i]')) {
        const style = getComputedStyle(element);
        if (style.display !== "none" && style.visibility !== "hidden" && (element as HTMLElement).offsetParent !== null) {
          bootText += `${element.textContent?.trim() ?? ""}\n`;
        }
      }
      const loginDialog = document.querySelector("#loginDialog");
      const loginStyle = loginDialog ? getComputedStyle(loginDialog) : null;
      return {
        url: location.href,
        pathname: location.pathname,
        readyState: document.readyState,
        loginDialogOpen: loginDialog instanceof HTMLDialogElement ? loginDialog.open : Boolean(loginDialog && loginStyle?.display !== "none" && loginStyle?.visibility !== "hidden" && (loginDialog as HTMLElement).offsetParent !== null),
        projectRows: document.querySelectorAll("#projectList .list-row").length,
        bootText: bootText.trim().slice(0, 500),
      };
    });
  } catch (error) {
    state = { diagnosticError: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) };
  }
  await Promise.allSettled([
    writeFile(FAILURE_JSON, JSON.stringify({ diagnostics, state }, null, 2)),
    page.screenshot({ path: FAILURE_PNG }),
  ]);
}

async function loginAndOpenShortOne(page: Awaited<ReturnType<typeof nativeUiFixture>>["page"], environment: Awaited<ReturnType<typeof nativeUiFixture>>["environment"], node: Awaited<ReturnType<typeof nativeUiFixture>>["node"], navigate = true) {
  if (navigate) await page.goto(node.url);
  const login = page.locator("#loginUsernameInput");
  const project = page.locator("#projectList .list-row", { hasText: "Internal Assistant" });
  await Promise.race([login.waitFor(), project.waitFor()]);
  if (await login.isVisible()) {
    await login.fill(environment.username);
    await page.locator("#loginPasswordInput").fill(environment.password);
    await page.locator("#loginSubmitButton").click();
  }
  await project.locator("button").first().click();
  await page.locator('[data-filter="all"]').click();
  await page.locator("#sessionList .list-row", { hasText: "Short one" }).locator("button").first().click();
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>("#messageInput");
    return Boolean(input && !input.disabled) && import("/app/state.js").then(({ state }) => Boolean(state.activeConversationId || state.activeSessionId));
  });
}

async function activeScope(page: Awaited<ReturnType<typeof nativeUiFixture>>["page"]) {
  return await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    return { projectId: state.activeProjectId, conversationId: state.activeConversationId || state.activeSessionId };
  });
}

test("a live supervisor task streams safely, stops, and remains in history after reload", { timeout: 180_000 }, async (t) => {
  const errors: Error[] = [];
  const { page, environment, node } = await nativeUiFixture(t, (root) => ({ JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
  const diagnostics = attachDiagnostics(page);
  const runtime = await startSupervisor({ dataDirectory: node.dataDir, app: { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: environment.root, env: {} } });
  const gate = path.join(environment.root, "browser-heartbeat-gate");
  page.on("pageerror", (error) => errors.push(error));
  try {
    await loginAndOpenShortOne(page, environment, node);
    const scope = await activeScope(page);
    await supervisorRequest(node.dataDir, {
      action: "start", id: UUID_A, identity: JSON.stringify([scope.projectId, scope.conversationId]), name: "Browser heartbeat",
      executable: process.execPath,
      args: ["-e", `const fs=require('node:fs');console.log('FIRST <img src=x onerror=window.taskInjected=true>');const wait=()=>fs.existsSync(${JSON.stringify(gate)})?(console.log('SECOND'),setInterval(()=>{},1000)):setTimeout(wait,20);wait()`],
      cwd: environment.root, env: {},
    });

    const button = page.getByTestId("background-tasks-open");
    await button.click();
    const dialog = page.getByTestId("background-tasks-dialog");
    const row = page.getByTestId("background-task-row").filter({ hasText: "Browser heartbeat" });
    await row.waitFor();
    await assert.doesNotReject(() => page.waitForFunction(() => document.querySelector("#backgroundTasksBadge")?.textContent === "1"));
    await row.click();
    const output = page.getByTestId("background-task-output");
    await output.getByText("FIRST", { exact: false }).waitFor();
    assert.equal(await output.locator("img").count(), 0);
    assert.equal(await page.evaluate(() => (window as typeof window & { taskInjected?: boolean }).taskInjected), undefined);
    await page.locator("#messageInput:not(:disabled)").waitFor();
    assert.equal(await page.locator("#messageInput").isEnabled(), true, "composer stays enabled while a task runs");
    assert.equal((await supervisorRequest<{ status: string }>(node.dataDir, { action: "task", id: UUID_A })).status, "running");

    await writeFile(gate, "go");
    await output.getByText("SECOND", { exact: false }).waitFor({ timeout: 15_000 });

    const stop = page.getByTestId("background-task-stop");
    await stop.click();
    await page.getByRole("button", { name: "Stop task" }).click();
    await row.getByText("stopped", { exact: false }).waitFor();
    assert.equal(await stop.isDisabled(), true);

    await page.reload();
    await loginAndOpenShortOne(page, environment, node, false);
    await page.getByTestId("background-tasks-open").click();
    const persisted = page.getByTestId("background-task-row").filter({ hasText: "Browser heartbeat" });
    await persisted.waitFor();
    assert.match(await persisted.textContent() ?? "", /stopped/);

    for (const viewport of [{ width: 1440, height: 900, inset: 12 }, { width: 390, height: 500, inset: 8 }]) {
      await page.setViewportSize(viewport);
      const box = await dialog.locator(".dialog-card").boundingBox();
      assert.ok(box && box.x >= viewport.inset && box.y >= viewport.inset && box.x + box.width <= viewport.width - viewport.inset && box.y + box.height <= viewport.height - viewport.inset, `dialog escaped viewport: ${JSON.stringify(box)}`);
      for (const target of await dialog.locator("button:visible").all()) {
        const targetBox = await target.boundingBox();
        assert.ok(targetBox && targetBox.height >= 40, `action target shorter than 40px: ${JSON.stringify(targetBox)}`);
      }
    }
    assert.deepEqual(errors, []);
  } catch (error) {
    await recordFailure(page, diagnostics);
    throw error;
  } finally {
    await runtime.close();
  }
});

test("delayed output cannot overwrite a newer task or conversation selection", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t, (root) => ({ JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
  const diagnostics = attachDiagnostics(page);
  const runtime = await startSupervisor({ dataDirectory: node.dataDir, app: { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: environment.root, env: {} } });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let delayedOnce = false;
  let interceptedResolve!: () => void;
  const intercepted = new Promise<void>((resolve) => { interceptedResolve = resolve; });
  let fulfilledResolve!: () => void;
  const fulfilled = new Promise<void>((resolve) => { fulfilledResolve = resolve; });
  try {
    await loginAndOpenShortOne(page, environment, node);
    const scope = await activeScope(page);
    for (const [id, name, text] of [[UUID_A, "Held A", "A-OLD"], [UUID_B, "Held B", "B-ONLY"]]) {
      await supervisorRequest(node.dataDir, { action: "start", id, identity: JSON.stringify([scope.projectId, scope.conversationId]), name, executable: process.execPath, args: ["-e", `console.log(${JSON.stringify(text)});setInterval(()=>{},1000)`], cwd: environment.root, env: {} });
    }
    await page.route("**/api/background-tasks/operation", async (route) => {
      const body = route.request().postDataJSON();
      if (!delayedOnce && body.command?.action === "output" && body.command?.id === UUID_A) {
        delayedOnce = true;
        const response = await route.fetch();
        interceptedResolve();
        await delayed;
        await route.fulfill({ response });
        fulfilledResolve();
      } else {
        await route.continue();
      }
    });

    await page.getByTestId("background-tasks-open").click();
    const rowA = page.getByTestId("background-task-row").filter({ hasText: "Held A" });
    const rowB = page.getByTestId("background-task-row").filter({ hasText: "Held B" });
    await rowA.click();
    await intercepted;
    await rowB.click();
    await page.getByTestId("background-task-output").getByText("B-ONLY", { exact: false }).waitFor();
    await rowA.click();

    await page.getByTestId("background-tasks-close").click();
    const previousConversation = scope.conversationId;
    await page.locator("#sessionList .list-row", { hasText: "Thread-Based Agent Builder" }).locator("button").first().click();
    await page.waitForFunction((previous) => import("/app/state.js").then(({ state }) => (state.activeConversationId || state.activeSessionId) !== previous), previousConversation);
    release();
    await page.getByTestId("background-tasks-open").click();
    await page.locator("#backgroundTasksDetails h3").waitFor({ state: "detached" });
    assert.equal(await page.getByTestId("background-task-row").count(), 0);
    assert.doesNotMatch(await page.getByTestId("background-task-output").textContent() ?? "", /A-OLD|B-ONLY/);
    await fulfilled;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.locator("#backgroundTasksDetails h3").count(), 0);
    assert.doesNotMatch(await page.getByTestId("background-task-output").textContent() ?? "", /A-OLD|B-ONLY/);
  } catch (error) {
    await recordFailure(page, diagnostics);
    throw error;
  } finally {
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    for (const id of [UUID_A, UUID_B]) await supervisorRequest(node.dataDir, { action: "stop", id }).catch(() => {});
    await runtime.close();
  }
});
