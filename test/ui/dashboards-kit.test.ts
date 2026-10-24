import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";

const kitJs = await readFile(new URL("../../public/dashboard-kit/kit.js", import.meta.url), "utf8");
const kitCss = await readFile(new URL("../../public/dashboard-kit/kit.css", import.meta.url), "utf8");
const catalog = JSON.parse(await readFile(new URL("../../public/dashboard-kit/catalog.json", import.meta.url), "utf8")) as {
  components: Array<{ name: string; summary: string; example: Record<string, unknown> }>;
};

test("the dashboard kit carries no outside URL", () => {
  for (const [name, source] of [["kit.js", kitJs], ["kit.css", kitCss]]) {
    const urls = source.replaceAll("http://www.w3.org/2000/svg", "").match(/https?:\/\/|url\(\s*["']?\/\//g);
    assert.equal(urls, null, `${name} must not reference the network`);
  }
});

async function kitPage(t: test.TestContext, payload: unknown) {
  const browser = await launchChrome();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const requests: string[] = [];
  page.on("request", (request) => { if (!request.url().startsWith("data:") && request.url() !== "about:blank") requests.push(request.url()); });
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  const embedded = JSON.stringify(payload).replaceAll("<", "\\u003c");
  await page.setContent(`<!doctype html><html data-theme="dark"><head><style>${kitCss}</style></head><body>
    <script type="application/json" id="payload">${embedded}</script>
    <main id="root"></main>
    <script>${kitJs}</script></body></html>`);
  return { page, requests, dialogs };
}

test("every catalogued component renders its example", async (t) => {
  const { page, requests } = await kitPage(t, { generatedAt: "2026-10-24T09:00:00Z" });
  const results = await page.evaluate((components) => components.map(({ name, example }) => {
    const kit = (window as unknown as { JointBobKit: Record<string, (props: unknown) => Element> }).JointBobKit;
    const node = kit[name](example);
    document.querySelector("#root")!.append(node);
    return { name, element: node instanceof Element, text: node.textContent?.length ?? 0 };
  }), catalog.components);
  for (const result of results) assert.equal(result.element, true, `${result.name} returns an element`);
  assert.deepEqual(catalog.components.map((component) => component.name).sort(), [
    "badges", "bar", "donut", "grid", "heatmap", "kpi", "lastRefreshed", "section", "stackedBar", "state", "table", "text", "timeSeries",
  ]);
  assert.deepEqual(requests, [], "rendering makes no network request");
});

test("payload text renders as text, never as markup", async (t) => {
  const attack = "</script><img src=x onerror=alert(1)>";
  const { page, dialogs } = await kitPage(t, { generatedAt: "2026-10-24T09:00:00Z", title: attack });
  const result = await page.evaluate((value) => {
    const kit = (window as unknown as { JointBobKit: Record<string, (props: unknown) => Element> & { payload: () => { title: string } } }).JointBobKit;
    const root = document.querySelector("#root")!;
    root.append(
      kit.table({ title: value, columns: [{ key: "name", label: value }], rows: [{ name: value }] }),
      kit.kpi({ label: value, value: 3 }),
      kit.badges({ items: [{ label: value, status: "critical" }] }),
      kit.text({ body: value }),
      kit.bar({ title: value, items: [{ label: value, value: 2 }] }),
    );
    return { images: root.querySelectorAll("img").length, payloadTitle: kit.payload().title, shown: root.textContent!.includes(value) };
  }, attack);
  assert.equal(result.images, 0);
  assert.equal(result.shown, true);
  assert.equal(result.payloadTitle, attack, "the embedded payload round-trips");
  await page.waitForTimeout(100);
  assert.deepEqual(dialogs, []);
});

test("tables sort and page instead of scrolling", async (t) => {
  const { page } = await kitPage(t, { generatedAt: "2026-10-24T09:00:00Z" });
  const pages = await page.evaluate(() => {
    const kit = (window as unknown as { JointBobKit: Record<string, (props: unknown) => Element> }).JointBobKit;
    const rows = Array.from({ length: 25 }, (_, index) => ({ name: `bug ${String(index).padStart(2, "0")}`, count: index }));
    const table = kit.table({ columns: [{ key: "name", label: "Bug" }, { key: "count", label: "Count", align: "right" }], rows, pageSize: 10 });
    document.querySelector("#root")!.append(table);
    // No named helpers in here: the test compiler wraps them in a function the page lacks.
    const seen = [table.querySelectorAll("tbody tr").length];
    (table.querySelector('[data-kit="next-page"]') as HTMLButtonElement).click();
    seen.push(table.querySelectorAll("tbody tr").length);
    (table.querySelector('[data-kit="next-page"]') as HTMLButtonElement).click();
    seen.push(table.querySelectorAll("tbody tr").length);
    (table.querySelector('th[data-key="count"] button') as HTMLButtonElement).click();
    (table.querySelector('th[data-key="count"] button') as HTMLButtonElement).click();
    return { seen, firstAfterSort: table.querySelector("tbody tr")!.textContent, status: table.querySelector('[data-kit="page-status"]')!.textContent };
  });
  assert.deepEqual(pages.seen, [10, 10, 5]);
  assert.match(pages.firstAfterSort!, /bug 24/, "a second click sorts descending, starting on the first page");
  assert.equal(pages.status, "1–10 of 25");
});

test("time series draws one line per series with a legend and a hover readout", async (t) => {
  const { page } = await kitPage(t, { generatedAt: "2026-10-24T09:00:00Z" });
  const result = await page.evaluate(() => {
    const kit = (window as unknown as { JointBobKit: Record<string, (props: unknown) => Element> }).JointBobKit;
    const days = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];
    const chart = kit.timeSeries({
      title: "Bugs per day",
      series: [{ name: "Bugs", points: days.map((t, index) => ({ t, v: index + 1 })) }, { name: "Errors", points: days.map((t, index) => ({ t, v: 10 - index })) }],
      markers: [{ t: "2026-10-22", label: "Fix deployed" }],
    });
    document.querySelector("#root")!.append(chart);
    const svg = chart.querySelector("svg")!;
    const box = svg.getBoundingClientRect();
    svg.dispatchEvent(new PointerEvent("pointermove", { clientX: box.right - 2, clientY: box.top + box.height / 2, bubbles: true }));
    return {
      lines: chart.querySelectorAll('[data-kit="series-line"]').length,
      legend: [...chart.querySelectorAll('[data-kit="legend-item"]')].map((item) => item.textContent),
      marker: chart.textContent!.includes("Fix deployed"),
      readout: chart.querySelector('[data-kit="tooltip"]')?.textContent ?? "",
    };
  });
  assert.equal(result.lines, 2);
  assert.deepEqual(result.legend, ["Bugs", "Errors"]);
  assert.equal(result.marker, true);
  assert.match(result.readout, /4.*Bugs|Bugs.*4/s);
});
