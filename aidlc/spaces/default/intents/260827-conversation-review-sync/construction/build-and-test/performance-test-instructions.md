# Performance Test Instructions

## Minimal-strategy scope

No separate load-test harness is required. NFR4 is covered by the targeted transcript-discovery fixture in `test/pi-session-discovery.test.ts`, as planned by `construction/code-generation/code-generation-plan.md`.

## Command and criterion

```bash
node --import tsx --test test/pi-session-discovery.test.ts
```

The fixture compares 500 and 1,000 discovered paths in one process. Doubling the path count must remain within 2.5 times the median duration, and only transcript groups containing conflict candidates may be parsed for recovery analysis.

## Environment

Run on an otherwise normally loaded development machine. The assertion is a ratio within one process rather than an absolute latency target, reducing machine-to-machine variance. A failure requires investigation; do not increase the multiplier to hide a regression.
