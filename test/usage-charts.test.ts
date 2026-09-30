import assert from "node:assert/strict";
import test from "node:test";
import { groupKnownCosts, selectCostDays } from "../public/app/usage-charts.js";

const row = (key: string, apiCostUsd: unknown) => ({ key, totals: { apiCostUsd } });

test("cost chart groups sorted top values and sums the remainder", () => {
  assert.deepEqual(groupKnownCosts([
    row("small", 1), row("largest", 9), row("middle", 4), row("also-small", 2),
  ], 2), [
    { name: "largest", value: 9 }, { name: "middle", value: 4 }, { name: "Other", value: 3 },
  ]);
});

test("cost chart excludes unknown, zero, negative, and non-finite costs", () => {
  assert.deepEqual(groupKnownCosts([
    row("unknown", null), row("zero", 0), row("credit", -3), row("bad", "unknown"), row("ok", 2),
  ], 5), [{ name: "ok", value: 2 }]);
});

test("historical chart selects the latest 30 populated days chronologically", () => {
  const rows = Array.from({ length: 35 }, (_, index) => row(`2025-01-${String(index + 1).padStart(2, "0")}`, index + 1));
  rows.reverse(); rows.push(row("not-a-date", 100), row("2025-01-36", -1));
  const selected = selectCostDays(rows);
  assert.equal(selected.length, 30);
  assert.equal(selected[0].name, "2025-01-06");
  assert.equal(selected.at(-1)?.name, "2025-01-35");
  assert.deepEqual(selected.map((item) => item.name), [...selected.map((item) => item.name)].sort());
});
