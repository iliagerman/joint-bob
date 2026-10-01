import assert from "node:assert/strict";
import test from "node:test";
import { change, comparePeriods, isoDate, localeWeekStart, periodWindows, presetRange } from "../public/app/usage-periods.js";

const row = (key: string, apiCostUsd: number | null, partial = false) => ({ key, totals: { apiCostUsd, partial } });
const everyDay = (from: Date, days: number, cost = 1) => Array.from({ length: days }, (_, index) => row(isoDate(new Date(from.getFullYear(), from.getMonth(), from.getDate() + index)), cost));

test("the default period starts on the first of the current local month", () => {
  assert.deepEqual(presetRange("month", new Date(2026, 9, 17, 23, 30)), { from: "2026-10-01", to: "2026-10-17" });
  assert.deepEqual(presetRange("last-month", new Date(2026, 2, 31)), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(presetRange("30d", new Date(2026, 9, 1)), { from: "2026-09-02", to: "2026-10-01" });
  assert.deepEqual(presetRange("all", new Date(2026, 9, 1)), { from: "", to: "" });
});

test("weeks start on the locale's first day", () => {
  const thursday = new Date(2026, 9, 1);
  assert.equal(isoDate(periodWindows("week", thursday, 1)[0].start), "2026-09-28", "Monday start");
  assert.equal(isoDate(periodWindows("week", thursday, 0)[0].start), "2026-09-27", "Sunday start");
  assert.deepEqual(periodWindows("week", thursday, 1).map((window) => isoDate(window.start)), ["2026-09-28", "2026-09-21", "2026-09-14", "2026-09-07"]);
  assert.equal(localeWeekStart("en-GB"), 1);
  assert.equal(localeWeekStart("not a locale"), 1);
});

test("each earlier month is summed through the same day, capped at its length", () => {
  const today = new Date(2026, 2, 31);
  const comparison = comparePeriods(everyDay(new Date(2025, 11, 1), 121), "month", today, 1);
  assert.equal(comparison.elapsed, 31);
  assert.deepEqual(comparison.periods.map((period) => isoDate(period.start)), ["2026-03-01", "2026-02-01", "2026-01-01", "2025-12-01"]);
  assert.deepEqual(comparison.periods.map((period) => period.toDate), [31, 28, 31, 31], "February stops at its 28th");
  assert.deepEqual(comparison.periods.map((period) => period.total), [31, 28, 31, 31]);
  assert.equal(comparison.average, 30);
});

test("week to date compares like with like and flags unpriced days", () => {
  const today = new Date(2026, 9, 1);
  const rows = [...everyDay(new Date(2026, 8, 7), 25, 2), row("2026-09-29", null, true)];
  const comparison = comparePeriods(rows, "week", today, 1);
  assert.equal(comparison.elapsed, 4);
  assert.deepEqual(comparison.periods.map((period) => period.toDate), [6, 8, 8, 8], "an unknown cost is skipped, not guessed");
  assert.deepEqual(comparison.periods.map((period) => period.total), [6, 14, 14, 14]);
  assert.deepEqual(comparison.periods.map((period) => period.partial), [true, false, false, false]);
});

test("relative change has no baseline when nothing was spent", () => {
  assert.equal(change(12, 10), 0.2);
  assert.equal(change(5, 0), null);
});
