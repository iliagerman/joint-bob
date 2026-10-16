import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("View previews images, PDFs and both Word formats without editing binary data", async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const project = node.projects.find((entry) => entry.name === "Internal Assistant")!;
  await writeFile(path.join(project.path, "preview.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/W3sAAAAASUVORK5CYII=", "base64"));
  // A tiny valid PDF with a single visible line.
  const parts = ["%PDF-1.4\n"];
  const offsets = [0];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 43 >>\nstream\nBT /F1 18 Tf 30 150 Td (PDF preview) Tj ET\nendstream",
  ];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(parts.join(""))); parts.push(`${index + 1} 0 obj\n${object}\nendobj\n`); }
  const xref = Buffer.byteLength(parts.join(""));
  parts.push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF`);
  await writeFile(path.join(project.path, "preview.pdf"), parts.join(""));
  for (const extension of ["doc", "docx"]) await copyFile(new URL(`../fixtures/preview.${extension}`, import.meta.url), path.join(project.path, `preview.${extension}`));

  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).click();
  await page.waitForFunction(() => import("/app/state.js").then(({ state }) => Boolean(state.activeProjectId)));

  for (const extension of ["png", "pdf", "doc", "docx"]) {
    await page.evaluate((name) => import("/app/project-files.js").then(({ openFileAction }) => openFileAction(name)), `preview.${extension}`);
    const dialog = page.getByTestId("file-action-dialog");
    await dialog.getByTestId("file-action-view-button").waitFor();
    await page.waitForFunction(() => !(document.querySelector("#fileActionViewButton") as HTMLButtonElement).disabled);
    assert.equal(await dialog.getByTestId("file-action-edit-button").isDisabled(), true);
    await dialog.getByTestId("file-action-view-button").click();
    await page.locator("#fileBinaryView:not([hidden])").waitFor();
    if (extension === "png") {
      await page.waitForFunction(() => (document.querySelector("#fileImagePreview") as HTMLImageElement).naturalWidth === 1);
      assert.equal(await dialog.getByTestId("file-image-preview").isVisible(), true);
    } else {
      const frame = dialog.getByTestId("file-document-preview");
      assert.equal(await frame.isVisible(), true);
      if (extension === "pdf") {
        const result = await page.request.get(new URL((await frame.getAttribute("src"))!, node.url).href);
        assert.equal(result.headers()["content-type"], "application/pdf");
        assert.equal(result.headers()["x-frame-options"], "SAMEORIGIN");
        assert.equal((await result.body()).subarray(0, 4).toString(), "%PDF");
      } else {
        const result = await page.request.get(new URL((await frame.getAttribute("src"))!, node.url).href);
        assert.equal(result.status(), 200, await result.text());
        assert.equal(result.headers()["x-frame-options"], "SAMEORIGIN");
        await frame.contentFrame().getByTestId("file-view-markdown").getByText("Word preview fixture.", { exact: false }).waitFor();
        assert.match(await frame.contentFrame().locator("body").innerText(), /Second paragraph/);
        assert.equal(await frame.contentFrame().getByTestId("file-view-markdown").evaluate((element) => getComputedStyle(element).whiteSpace), "pre-wrap");
      }
    }
    await dialog.getByTestId("file-binary-close-button").click();
    await page.locator("#fileActionDialog[open]").waitFor({ state: "detached" });
  }

  await writeFile(path.join(project.path, "invalid.docx"), "not a Word document");
  const invalid = await page.request.get(`${node.url}/api/projects/${project.id}/file?path=invalid.docx`);
  assert.equal(invalid.status(), 415, "a corrupt Word file is not served as fake text or HTML");
  const downloaded = await page.request.get(`${node.url}/api/projects/${project.id}/file?path=preview.docx&download=1`);
  assert.equal(downloaded.status(), 200);
  assert.match(downloaded.headers()["content-disposition"], /^attachment;/);
});
