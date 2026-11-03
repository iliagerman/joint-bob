import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";

test("dialog headers and actions stay visible while only the body scrolls", { timeout: 60_000 }, async (t) => {
  const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../public/styles.css", import.meta.url), "utf8");
  const layout = await readFile(new URL("../../public/app/dialog-layout.js", import.meta.url), "utf8");
  const dialogs = [...html.matchAll(/<dialog\b[\s\S]*?<\/dialog>/g)].map(match => match[0]).join("\n");
  const server = createServer((request, response) => {
    const css = request.url === "/styles.css";
    const js = request.url === "/dialog-layout.js";
    response.setHeader("Content-Type", css ? "text/css" : js ? "text/javascript" : "text/html");
    response.end(css ? styles : js ? layout : `<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/styles.css">${dialogs}<script type="module" src="/dialog-layout.js"></script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await launchChrome({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ serviceWorkers: "block" });
  for (const viewport of [{ width: 390, height: 640 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.evaluate(() => {
      const dialog = document.createElement("dialog");
      dialog.className = "budget-dialog";
      dialog.id = "dynamicBudget";
      dialog.innerHTML = '<h3>Budget</h3><p>Loading</p><button>Close</button>';
      document.body.append(dialog);
      dialog.showModal();
      dialog.replaceChildren();
      dialog.innerHTML = '<h3>Budget</h3><p>Budget settings</p><div class="budget-dialog-actions"><button>Save</button></div>';
      dialog.close();
    });
    for (const id of ["autoRespondDialog", "projectDialog", "quickNoteDialog", "modelDialog", "newSessionNameDialog", "appearanceDialog", "secretScopeDialog", "taskDialog", "dynamicBudget"]) {
      const result = await page.evaluate(async (id) => {
        const dialog = document.getElementById(id) as HTMLDialogElement;
        if (id === "dynamicBudget") {
          dialog.showModal();
          dialog.innerHTML = '<h3>Budget</h3><p>Loaded settings</p><div class="budget-dialog-actions"><button>Save</button></div>';
          await new Promise(requestAnimationFrame);
          dialog.close();
        }
        const card = dialog.matches(".budget-dialog") ? dialog : dialog.querySelector(".dialog-card")!;
        const heading = card.firstElementChild!;
        const footer = card.querySelector(".dialog-actions, .budget-dialog-actions")!;
        const filler = document.createElement("div");
        filler.style.height = "1400px";
        filler.textContent = "Long dialog content";
        const existingBody = card.querySelector(".dialog-body, .task-form-body");
        if (existingBody) existingBody.append(filler);
        else footer.before(filler);
        dialog.showModal();
        await new Promise(requestAnimationFrame);
        const body = card.querySelector<HTMLElement>(".dialog-body, .task-form-body");
        const before = { heading: heading.getBoundingClientRect().top, footer: footer.getBoundingClientRect().top };
        if (body) body.scrollTop = body.scrollHeight;
        else card.scrollTop = card.scrollHeight;
        await new Promise(requestAnimationFrame);
        const after = { heading: heading.getBoundingClientRect().top, footer: footer.getBoundingClientRect().top };
        const result = { before, after, bodyScroll: body?.scrollTop ?? 0, cardScroll: card.scrollTop, footerBottom: footer.getBoundingClientRect().bottom, top: heading.getBoundingClientRect().top };
        dialog.close();
        return result;
      }, id);
      assert.ok(result.bodyScroll > 0, `${id} at ${viewport.width}px needs a scrolling body: ${JSON.stringify(result)}`);
      assert.deepEqual(result.after, result.before, `${id} header/footer must not move`);
      assert.equal(result.cardScroll, 0, `${id} card must not scroll`);
      assert.ok(result.top >= 0 && result.footerBottom <= viewport.height, `${id} controls must fit viewport`);
    }
  }
});
