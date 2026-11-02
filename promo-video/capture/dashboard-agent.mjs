// Stand-in for the dashboard agent, used only by the promo video's disposable nodes. Joint Bob
// loads it through JOINT_BOB_DASHBOARD_AGENT. It works the way the real agent is asked to: it
// writes the page and a refresh script into the draft folder named in the prompt, and reports
// its steps as it goes, so the creator shows a live step list and then the preview.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const page = `<script>
const k = JointBobKit, data = k.payload();
k.mount(
  k.grid({ columns: 4, children: [
    k.kpi({ label: "Checkout errors today", value: data.today, delta: data.today - data.lastWeek, deltaLabel: "vs same day last week", goodDirection: "down", trend: data.days.slice(-7).map((d) => d.errors) }),
    k.kpi({ label: "Failed payments", value: data.failedPayments, format: "integer", goodDirection: "down" }),
    k.kpi({ label: "New error types", value: data.newTypes, goodDirection: "down" }),
    k.kpi({ label: "Checkout success", value: data.success, format: "percent", goodDirection: "up" }),
  ] }),
  k.timeSeries({ title: "Checkout errors per hour", subtitle: "Last 48 hours", area: true, series: [{ name: "Errors", points: data.hours }], markers: [{ t: data.fixAt, label: "Fix deployed" }] }),
  k.grid({ columns: 2, children: [
    k.bar({ title: "Top errors", horizontal: true, items: data.top }),
    k.badges({ title: "Watch list", items: data.watch }),
  ] }),
  k.table({ title: "Errors seen for the first time", columns: [{ key: "error", label: "Error" }, { key: "where", label: "Where" }, { key: "count", label: "Count", align: "right", format: "integer" }, { key: "first", label: "First seen" }], rows: data.fresh, pageSize: 5 }),
  k.lastRefreshed({ generatedAt: data.generatedAt }),
);
</script>`;

// A refresh with no AI: a script that prints one JSON object. Here it invents the numbers.
const refresh = `const now = Date.now(), hour = 3_600_000;
const hours = Array.from({ length: 48 }, (_, i) => {
  const t = new Date(now - (47 - i) * hour);
  const spike = i > 30 && i < 38 ? 60 - Math.abs(34 - i) * 8 : 0;
  return { t: t.toISOString(), v: Math.round(8 + 6 * Math.sin(i / 3) + spike + (i % 5)) };
});
const days = Array.from({ length: 14 }, (_, i) => ({ day: i, errors: 140 + Math.round(40 * Math.sin(i)) }));
console.log(JSON.stringify({
  generatedAt: new Date(now).toISOString(), today: 132, lastWeek: 171, failedPayments: 9, newTypes: 2, success: 0.987,
  hours, days, fixAt: new Date(now - 10 * hour).toISOString(),
  top: [{ label: "TypeError in formatPrice", value: 214 }, { label: "Stripe timeout", value: 61 }, { label: "Cart not found", value: 23 }, { label: "Coupon expired", value: 12 }],
  watch: [{ label: "formatPrice", status: "good", detail: "none since the fix" }, { label: "Stripe timeouts", status: "warning", detail: "up 18% today" }, { label: "Guest carts", status: "info", detail: "new code path" }],
  fresh: [
    { error: "RangeError: invalid currency code", where: "src/money.ts:41", count: 7, first: "09:12" },
    { error: "Webhook signature mismatch", where: "src/webhooks/refund.ts:18", count: 3, first: "10:47" },
  ],
}));`;

export default async (input) => {
  const draft = /Draft folder \(edit here\): (.+)/.exec(input.prompt)[1].trim();
  await mkdir(draft, { recursive: true });
  const step = async (tool, target, text, ms) => { input.onActivity?.({ tool, target }); if (text) input.onText?.(text); await wait(ms); };
  await step("bash", "psql -c 'select count(*) from checkout_errors'", "Looking at the checkout error log", 1800);
  await step("read", "src/checkout/errors.ts", "Finding where errors are recorded", 1500);
  await writeFile(path.join(draft, "refresh.mjs"), refresh);
  await step("write", "refresh.mjs", "Writing a refresh script that needs no AI", 1500);
  await writeFile(path.join(draft, "index.html"), page);
  await writeFile(path.join(draft, "manifest.json"), JSON.stringify({ title: "Checkout health", refresh: { method: "script", command: 'node "$JOINT_BOB_DASHBOARD_DIR/refresh.mjs"' } }));
  await step("write", "index.html", "Laying out the page", 1600);
  await step("bash", "node refresh.mjs", "Testing the refresh", 1200);
  return "I built **Checkout health**: errors today against last week, errors per hour with the fix marked, the top errors, and errors seen for the first time. It refreshes with a script, no AI.";
};
