// Scripted agent answers for the promo video. Everything here is invented: the company,
// the repositories, the log lines and the pull request numbers.
//
// A scenario is chosen by matching the prompt. Each step may say something, then call a tool.
// A tool with `run` does something real and reports what came back: the browser scenario
// drives the app's own browser through the same command line a real agent uses.
import { execFile } from "node:child_process";

/** The shop the browser scenario visits: a page served on this machine by the capture. */
export const shopPort = 8899;
export const shop = `http://staging.northwind.localhost:${shopPort}`;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Runs one of the command lines Joint Bob gives an agent, named by its environment variable. */
const tool = (variable, ...args) => new Promise((resolve) => {
  execFile(process.execPath, [process.env[variable], ...args], { timeout: 60_000 }, (error, stdout, stderr) => resolve((stdout || stderr || String(error ?? "")).trim().slice(0, 1200)));
});
const browser = (...args) => tool("JOINT_BOB_BROWSER_CLI", ...args);


// ---------- Control center (the `control` take) ----------
// Long jobs keep their conversation running while the board is filmed: a step, a tool, a pause.
const longRun = (steps) => steps.map(([say, command, result]) => ({ say, tool: { name: "Bash", input: { command, description: say.replace(/[.`*]/g, "").slice(0, 60) }, ms: 2_600, result }, pauseMs: 24_000 }));
// The board's running jobs: a short plan first (so the summary has something to say), then the long run.
const controlScenarios = [
  { match: /Plan moving the product grid/i, title: "Product grid on the design system", steps: [{ say: "The grid has **22 components**. I'll move them one per commit, behind the `newGrid` flag, with a visual test for each." }] },
  { match: /Go ahead and move the product grid/i, steps: longRun([
    ["Moving `ProductCard` first.", "npx codemod design-system ProductCard", "1 file changed"],
    ["Visual tests for the card.", "npm run test:visual -- ProductCard", "4 of 4 pass"],
    ["Next: `PriceTag` and `RatingStars`.", "npx codemod design-system PriceTag RatingStars", "2 files changed"],
    ["Visual tests.", "npm run test:visual -- PriceTag RatingStars", "8 of 8 pass"],
    ["Now the filters.", "npx codemod design-system Filters", "3 files changed"],
    ["Checking the grid on mobile widths.", "npm run test:visual -- --viewport 375", "11 of 11 pass"],
    ["The sort menu.", "npx codemod design-system SortMenu", "1 file changed"],
    ["Visual tests.", "npm run test:visual -- SortMenu", "3 of 3 pass"],
    ["Pagination.", "npx codemod design-system Pagination", "1 file changed"],
    ["Full visual run.", "npm run test:visual", "46 of 46 pass"],
    ["Quick-view dialog.", "npx codemod design-system QuickView", "2 files changed"],
    ["Almost there.", "npm run test:visual", "52 of 52 pass"],
  ]).concat([{ say: "All **22 components** are on the design system behind `newGrid`. 52 of 52 visual tests pass." }]) },
  { match: /annual-plan invoices go out twice/i, title: "Duplicate annual invoices", steps: [{ say: "Found it: the renewal job retries a timed-out send **without an idempotency key**, so the provider sends the invoice again." }] },
  { match: /Fix the duplicate invoices/i, steps: longRun([
    ["Adding an idempotency key to the invoice send.", "git grep -n sendInvoice src/", "src/renewals/send.ts:41"],
    ["Writing the regression test.", "npm test -- renewals", "1 failing (expected)"],
    ["Passing the key through the retry.", "npm test -- renewals", "12 of 12 pass"],
    ["Replaying last month's renewals in a dry run.", "npm run renewals:replay -- --dry-run --month 2026-10", "1,204 renewals, 0 duplicates"],
    ["Checking the provider logs for the same pattern.", "npm run logs -- --grep 'invoice.sent' --since 30d", "37 duplicate sends found"],
    ["Listing the 37 customers to refund.", "npm run renewals:duplicates -- --since 30d", "37 customers"],
    ["Full test run.", "npm test", "418 of 418 pass"],
    ["Drafting the refund script.", "npm run refunds:draft -- --list duplicates.csv", "37 refunds, $5,213 total"],
    ["Checking the script in staging.", "npm run refunds:draft -- --env staging", "37 refunds would be issued"],
    ["Writing the incident note.", "cat docs/incidents/2026-11-invoices.md | wc -l", "48"],
    ["Opening the pull request.", "gh pr create --fill", "PR #219"],
    ["Waiting for CI.", "gh pr checks 219", "6 of 6 checks pass"],
  ]).concat([{ say: "**PR #219** stops the duplicates. 37 customers were charged twice this month; the refund script is ready for you." }]) },
  { match: /What breaks if we upgrade React Native/i, title: "React Native 0.80 upgrade", steps: [{ say: "Three breaking changes affect us: the new architecture flag, `Animated` imports and two iOS pods. Android should build as is." }] },
  { match: /Do the React Native upgrade/i, steps: longRun([
    ["Bumping React Native.", "npx react-native upgrade 0.80.0", "updated 14 files"],
    ["Android build.", "cd android && ./gradlew assembleDebug", "BUILD SUCCESSFUL"],
    ["iOS pods.", "cd ios && pod install", "2 pods failed to resolve"],
    ["Updating `react-native-maps`.", "npm i react-native-maps@2.1", "updated"],
    ["iOS pods again.", "cd ios && pod install", "1 pod failed to resolve"],
    ["Patching `react-native-camera`.", "npx patch-package react-native-camera", "patch created"],
    ["iOS build.", "xcodebuild -scheme App -sdk iphonesimulator build", "BUILD SUCCEEDED"],
    ["Fixing the `Animated` imports.", "npx codemod rn-animated-imports src/", "9 files changed"],
    ["Unit tests.", "npm test", "212 of 212 pass"],
    ["End-to-end on the simulator.", "npm run e2e:ios", "31 of 31 pass"],
    ["End-to-end on Android.", "npm run e2e:android", "31 of 31 pass"],
    ["Opening the pull request.", "gh pr create --fill", "PR #77"],
  ]).concat([{ say: "React Native **0.80** builds on both platforms. **PR #77**, all tests green." }]) },
  { match: /Summarize this week's escalations/i, title: "This week's escalations", steps: [
    { say: "Reading the week's escalated calls.", tool: { name: "Bash", input: { command: "npm run calls -- --escalated --since 7d", description: "List the week's escalated calls" }, ms: 900, result: "9 escalations" } },
    { say: "**9 escalations** this week. Six were the billing hold message that loops, two were refunds and one a login issue. I drafted a reply for each in `replies/2026-11-04.md`." },
  ] },
  { match: /Get the staging cluster ready for tonight/i, title: "Staging ready for tonight", steps: [{ say: "Staging is short on disk: **38 old database snapshots** take 41 GB. I'll clear those first, then refresh the data." }] },
  { match: /Clear the old staging snapshots/i, steps: [
    { say: "Deleting the 38 snapshots older than 30 days.", guard: true, tool: { name: "Bash", input: { command: "rm -rf /srv/staging/snapshots/2025-*", description: "Delete the old staging snapshots" }, ms: 700, result: "" } },
    { say: "Removed **38 snapshots**, 41 GB free. Refreshing staging from last night's backup.", tool: { name: "Bash", input: { command: "npm run staging:refresh", description: "Refresh staging data" }, ms: 2_400, result: "staging refreshed" } },
    { say: "Staging is ready for tonight." },
  ] },
  { match: /rate limit to the coupon endpoint/i, title: "Rate limit on coupons", steps: longRun([
    ["Reading the gateway config for `/coupons`.", "cat gateway/routes/coupons.yaml", "no limit set"],
    ["Adding 20 requests a minute per customer.", "npx gateway lint gateway/routes/coupons.yaml", "ok"],
    ["Testing the limit.", "npm test -- coupons", "7 of 7 pass"],
    ["Load test on staging.", "npm run load -- /coupons --rps 50", "429s after 20/min ✓"],
  ]).concat([{ say: "The coupon endpoint is limited to **20 requests a minute** per customer. Tests pass; ready for review." }]) },
  // Bob's own agent answering questions about what is running.
  { match: /What's left before tonight's release/i, steps: [{ say: "Three things:\n1. Staging is ready: the old snapshots are cleared, after your OK.\n2. Duplicate invoices (billing-worker): the fix is close, then a refund script for 37 customers.\n3. This week's escalations are drafted and wait for your review.\n\nThe React Native upgrade isn't needed for tonight.", wordMs: 18 }] },
  { match: /Is the payment retry fix ready for tonight/i, steps: [{ say: "Yes. The double-charge fix in checkout-api is done: 48 of 48 tests pass and PR #212 waits for your review. Nothing blocks the 6 PM launch.", wordMs: 20 }] },
  // Bob's automation step: the message as the JSON Bob checks, with the project id it was given.
  { match: /^Schedule our release in checkout-api/i, steps: (prompt) => {
    const id = /- (\S+) \| checkout-api\s*$/m.exec(prompt)?.[1] ?? "unknown";
    return [{ say: JSON.stringify({ intent: "create", create: { kind: "schedule", projectId: id, name: "Monday launch", prompt: "Run the release checklist for checkout-api, deploy main to production, run the smoke tests and post the release notes.", frequency: "weekly", time: "18:00", weekday: 1 } }), wordMs: 2 }];
  } },
  { match: /Fix the payment retry double-charge and open a PR/i, title: "Payment retry double-charge", steps: [
    { say: "The retry sends the charge again after a provider timeout. Adding an idempotency key.", tool: { name: "Bash", input: { command: "npm test -- payments", description: "Run the payment tests" }, ms: 1_200, result: "48 of 48 pass" } },
    { say: "Fixed: retries reuse the idempotency key, so a timeout can't charge twice. **48 of 48 tests pass**, and **PR #212** is open." },
  ] },
];

/** Running summaries the stand-in writes, by what the conversation is about. The last is the default. */
export const summaries = [
  { match: /product grid/i, text: "Moving the product grid to the new design system: 14 of 22 components done, visual tests pass." },
  { match: /invoices/i, text: "Annual invoices go out twice: a retry without an idempotency key. Writing the fix and a regression test." },
  { match: /React Native/i, text: "React Native 0.80: Android builds. Fixing the last two iOS pods." },
  { match: /escalations/i, text: "9 escalations summarized and 9 replies drafted, ready for your review." },
  { match: /staging/i, text: "Getting staging ready for tonight: clearing 38 old snapshots (41 GB) first." },
  { match: /coupon/i, text: "Rate-limiting the coupon endpoint to 20 requests a minute per customer." },
  { match: /double-charge/i, text: "Payment retries no longer charge twice: 48 of 48 tests pass, PR #212 waits for review." },
  { match: /.*/, text: "Working on the task in this conversation." },
];

export const scenarios = [
  ...controlScenarios,
  // The release assistant. Each match is a phrase only that message has, because a topic's
  // prompt also carries the assistant's instructions.
  {
    match: /you're the release assistant/i,
    steps: [{ say: "Got it. I'll keep track of the checkout-api work and the launches, and answer here.", wordMs: 20 }],
  },
  {
    match: /how far along is the payment retry/i,
    steps: [{
      say: "Payment retries: 3 of 4 done, on track for tonight's launch.\n\n✓ Retry with backoff, merged in PR #212\n✓ A counter for retried payments, added by Maya\n✓ The checkout health dashboard\n⏳ The move to Vitest, 140 of 212 test files so far\n\nNothing is blocking it.",
      wordMs: 16,
    }],
  },
  {
    match: /ready for tonight/i,
    steps: [{
      say: "Almost. The retries and Maya's counter are merged, and the test migration is at 140 of 212 files. It should be done by 5:30, well before the 6:00 PM launch.",
      wordMs: 18,
    }],
  },
  {
    match: /book 30 minutes with maya/i,
    steps: [{
      say: "Booked “Payment retries review” with Maya, tomorrow 10:00 to 10:30, and sent her the invite with PR #212 attached.",
      wordMs: 18,
    }],
  },
  {
    match: /run the release checklist/i,
    steps: [{
      say: "checkout-api v2.4 is live.\n\n✓ Release checklist: 6 of 6\n✓ Deployed main to production at 6:00 PM\n✓ Smoke tests: 24 of 24 pass\n✓ Release notes posted to #releases",
      wordMs: 14,
    }],
  },
  {
    // Guardian: a clean-up that would delete files. The delete is paused for the person; the
    // blocked branch is what the agent does after a Block.
    match: /old customer exports/i,
    title: "Clean up old customer exports",
    steps: [
      {
        say: "The old export job left 1,204 CSV files in `exports/customers`. Removing them.",
        guard: true,
        tool: { name: "Bash", input: { command: "rm -rf ./exports/customers", description: "Delete the old customer exports" }, ms: 500, result: "" },
      },
      { say: "Removed `exports/customers`. The release folder is clean." },
    ],
    blocked: [
      {
        say: "Guardian blocked the delete, so nothing was removed. I'll archive the folder instead, which can be undone.",
        tool: { name: "Bash", input: { command: "mkdir -p archive && mv exports/customers archive/customers-2026-10", description: "Archive the old customer exports" }, ms: 600, result: "" },
      },
      { say: "**Archived** 1,204 files to `archive/customers-2026-10`. Nothing was deleted." },
    ],
  },
  {
    // Guardian: a message with a live key in it reaches the agent with the key removed.
    match: /deploy status on staging/i,
    steps: [
      {
        say: "Guardian removed the key from your message before it reached me, so it is not in this conversation or in the model's context. I'll use the project's **aws-staging** secret account instead.",
        tool: { name: "Bash", input: { command: "aws ecs describe-services --cluster staging --services checkout-api", description: "Check the staging deploy" }, ms: 1400, result: "checkout-api  ACTIVE  running 3/3  task definition checkout-api:214" },
      },
      { say: "Staging runs **checkout-api:214**, 3 of 3 tasks healthy." },
    ],
  },
  {
    // The personal assistant, answering from the links saved to it.
    match: /which (monitor|one) should I (buy|get)/i,
    steps: [
      {
        say: "From the three monitors you saved:\n\n| | Price | Warranty | USB-C power |\n|---|---|---|---|\n| **Dell U2724DE** | $529 | 3 years | 90 W |\n| LG 27UQ850 | $499 | 1 year | 96 W |\n| BenQ PD2706UA | $549 | 3 years | 90 W |\n\n**Get the Dell.** It has the 3-year warranty you asked for, and it is $20 cheaper than the BenQ. The LG is cheapest but has a 1-year warranty.",
        wordMs: 18,
      },
    ],
  },
  {
    // Laptop: the conversation that is in flight when the lid closes.
    match: /double[- ]charg/i,
    title: "Payment retry double-charges on timeout",
    steps: [
      {
        say: "I'll trace the retry path first, then reproduce the double charge.",
        tool: { name: "Grep", input: { pattern: "retryPayment|idempotencyKey", path: "src/payments" }, ms: 600,
          result: "src/payments/retry.ts:18:  export async function retryPayment(order: Order, attempt: number)\nsrc/payments/retry.ts:27:    idempotencyKey: newKey(),\nsrc/payments/client.ts:52:    headers: { \"Idempotency-Key\": request.idempotencyKey }," },
      },
      {
        say: "`retry.ts:27` creates a new idempotency key on every attempt. That is the likely cause. Reading the surrounding code.",
        tool: { name: "Read", input: { file_path: "src/payments/retry.ts" }, ms: 500,
          result: "18  export async function retryPayment(order: Order, attempt: number) {\n19    if (attempt > MAX_ATTEMPTS) throw new RetryLimitError(order.id);\n20    const response = await client.charge({\n21      orderId: order.id,\n22      amount: order.total,\n23      currency: order.currency,\n24      // A timeout does not mean the charge failed. The provider may still\n25      // complete it, and a new key lets the retry charge a second time.\n26      timeoutMs: 8_000,\n27      idempotencyKey: newKey(),\n28    });" },
      },
      {
        say: "Confirmed. When the provider times out but still completes the charge, the retry is sent with a different key, so the provider treats it as a new payment.\n\nWriting a failing test that times out the first attempt.",
        tool: { name: "Edit", input: { file_path: "test/payments/retry.test.ts", old_string: "describe(\"retryPayment\", () => {", new_string: "describe(\"retryPayment\", () => {\n  it(\"reuses the idempotency key after a timeout\", async () => {" }, ms: 700,
          result: "The file test/payments/retry.test.ts has been updated." },
      },
      {
        say: "Running it to confirm it fails for the right reason.",
        tool: { name: "Bash", input: { command: "npm test -- payments/retry", description: "Run the payment retry tests" }, ms: 2600,
          result: " FAIL  test/payments/retry.test.ts\n  retryPayment\n    ✓ gives up after MAX_ATTEMPTS (4 ms)\n    ✕ reuses the idempotency key after a timeout (12 ms)\n\n  Expected: 1 distinct key\n  Received: 2 distinct keys\n\nTests: 1 failed, 6 passed, 7 total" },
      },
      {
        say: "The test fails as expected: two distinct keys for one order.\n\n**Cause:** `retryPayment` calls `newKey()` per attempt.\n**Fix:** derive the key once per order and pass it through every attempt.\n\nNext I'll change `retry.ts`, rerun the suite, and open a pull request.",
      },
    ],
  },
  {
    // Other machine: picking the same conversation up where the laptop left it.
    match: /ship the fix|pick(ing)? (this|it) up/i,
    startTokens: 38_900,
    steps: [
      {
        say: "Picking this up from the failing test. Moving the key to the order.",
        tool: { name: "Edit", input: { file_path: "src/payments/retry.ts", old_string: "idempotencyKey: newKey(),", new_string: "idempotencyKey: order.paymentKey," }, ms: 600,
          result: "The file src/payments/retry.ts has been updated." },
      },
      {
        say: "The key now lives on the order, so every attempt sends the same one. Running the full payments suite.",
        tool: { name: "Bash", input: { command: "npm test -- payments", description: "Run the payments tests" }, ms: 2400,
          result: " PASS  test/payments/retry.test.ts\n PASS  test/payments/client.test.ts\n PASS  test/payments/refund.test.ts\n\nTests: 48 passed, 48 total\nTime:  3.9 s" },
      },
      {
        say: "All 48 tests pass. Opening the pull request.",
        tool: { name: "Bash", input: { command: "gh pr create --title \"Reuse the idempotency key across payment retries\" --fill", description: "Open a pull request" }, ms: 1500,
          result: "https://github.com/northwind-shop/checkout-api/pull/212" },
      },
      {
        say: "Done. **PR #212** reuses one idempotency key per order, so a retry after a timeout can no longer charge twice.\n\n- `src/payments/retry.ts`: key comes from the order\n- `test/payments/retry.test.ts`: regression test for the timeout case\n- 48 of 48 tests pass",
      },
    ],
  },
  {
    // A monitoring alert arrives on a webhook: find the error, fix it, open a pull request.
    match: /production error alert/i,
    startTokens: 16_200,
    steps: [
      {
        say: "An alert from production. Checking the last minutes of errors.",
        tool: { name: "Bash", input: { command: "./scripts/logs --env production --since 10m --level error | cut -d' ' -f4- | sort | uniq -c | sort -rn | head -5", description: "Group the latest production errors" }, ms: 1300,
          result: "    214 TypeError: Cannot read properties of undefined (reading 'currency') at formatPrice (src/cart/format.ts:41)\n      9 UpstreamTimeout: inventory-service GET /stock 8000ms\n      3 RateLimited: tax-service 429" },
      },
      {
        say: "One new pattern: **214 errors** from `formatPrice`, all since 03:00. Reading the code.",
        tool: { name: "Read", input: { file_path: "src/cart/format.ts" }, ms: 500,
          result: "38  export function formatPrice(cart: Cart, amount: number): string {\n39    // Guest carts restored from a saved link have no region yet,\n40    // so `cart.region` is undefined until the address step.\n41    const currency = cart.region.currency;\n42    return new Intl.NumberFormat(cart.locale, { style: \"currency\", currency }).format(amount);\n43  }" },
      },
      {
        say: "Guest carts restored from a saved link have no region, so `cart.region.currency` throws. Falling back to the store's default currency.",
        tool: { name: "Edit", input: { file_path: "src/cart/format.ts", old_string: "const currency = cart.region.currency;", new_string: "const currency = cart.region?.currency ?? cart.store.defaultCurrency;" }, ms: 600,
          result: "The file src/cart/format.ts has been updated." },
      },
      {
        say: "Adding a test for a cart without a region and running the cart suite.",
        tool: { name: "Bash", input: { command: "npm test -- cart", description: "Run the cart tests" }, ms: 1700,
          result: " PASS  test/cart/format.test.ts\n PASS  test/cart/totals.test.ts\n\nTests: 31 passed, 31 total\nTime:  2.6 s" },
      },
      {
        say: "Tests pass. Opening a pull request.",
        tool: { name: "Bash", input: { command: "gh pr create --title \"Format prices for carts that have no region yet\" --fill", description: "Open a pull request" }, ms: 1200,
          result: "https://github.com/northwind-shop/checkout-api/pull/213" },
      },
      {
        say: "**Opened PR #213.** The alert is one new error.\n\n- **What:** `TypeError` in `formatPrice`, 214 times since 03:00\n- **Why:** guest carts restored from a saved link have no region\n- **Fix:** fall back to the store's default currency, with a regression test",
      },
    ],
  },
  {
    // A teammate trying her own idea in a fork of the conversation.
    match: /cap retries/i,
    startTokens: 46_800,
    steps: [
      {
        say: "Trying it here, in the fork. The original conversation stays as it is.",
        tool: { name: "Edit", input: { file_path: "src/payments/retry.ts", old_string: "const MAX_ATTEMPTS = 5;", new_string: "const MAX_ATTEMPTS = 3;" }, ms: 600,
          result: "The file src/payments/retry.ts has been updated." },
      },
      {
        say: "Capped at three attempts in this fork. All 48 tests still pass, so you can compare the two before you choose.",
      },
    ],
  },
  {
    // A teammate continuing someone else's conversation.
    match: /metric|dashboard/i,
    startTokens: 44_100,
    steps: [
      {
        say: "Adding a counter for retried payments next to the fix from PR #212.",
        tool: { name: "Edit", input: { file_path: "src/payments/retry.ts", old_string: "const response = await client.charge({", new_string: "metrics.increment(\"payments.retry\", { attempt });\n  const response = await client.charge({" }, ms: 600,
          result: "The file src/payments/retry.ts has been updated." },
      },
      {
        say: "Pushed to the same branch. `payments.retry` is tagged by attempt number, so the dashboard can show how often a first attempt times out.",
      },
    ],
  },
];

scenarios.push(
  {
    // A long task, planned on the laptop before it is moved to the server.
    match: /vitest/i,
    title: "Migrate tests to Vitest",
    steps: [
      {
        say: "Counting what there is to move.",
        tool: { name: "Bash", input: { command: "grep -rl \"from '@jest/globals'\\|jest\\.\" test | wc -l", description: "Count the test files that use Jest" }, ms: 700, result: "     212" },
      },
      {
        say: "**212 test files** use Jest.\n\n**Plan**\n1. Swap the runner and its config\n2. Migrate the files in six batches, running the suite after each\n3. Open a pull request\n\nThis is a long one, about 40 minutes. Say go when you're ready.",
      },
    ],
  },
  {
    // The long run itself. It is started after the conversation has moved to the home server.
    match: /go ahead/i,
    startTokens: 31_200,
    steps: [
      ...[["test/invoices", 38, 264], ["test/payments", 41, 301], ["test/customers", 29, 188], ["test/mail", 36, 247], ["test/reports", 33, 229], ["test/api", 35, 251]].map(([folder, files, tests], index) => ({
        say: `Batch ${index + 1} of 6: \`${folder}\`, ${files} files.`,
        tool: { name: "Bash", input: { command: `npx vitest run ${folder}`, description: `Run the migrated tests in ${folder}` }, ms: 1700, result: ` ✓ ${folder}  (${files} files)\n\n Test Files  ${files} passed (${files})\n      Tests  ${tests} passed (${tests})` },
      })),
      {
        say: "All six batches pass. Opening the pull request.",
        tool: { name: "Bash", input: { command: "gh pr create --title \"Move the test suite from Jest to Vitest\" --fill", description: "Open a pull request" }, ms: 1200, result: "https://github.com/northwind-shop/billing-worker/pull/231" },
      },
      {
        say: "**Done.** All 212 files run on Vitest.\n\n- 1,480 of 1,480 tests pass\n- The suite takes 41 s, down from 3 min 10 s\n- Opened **PR #231**",
      },
    ],
  },
  {
    // The follow-up from a phone.
    match: /CI is green/i,
    startTokens: 52_600,
    steps: [
      {
        say: "Watching the checks on PR #231.",
        tool: { name: "Bash", input: { command: "gh pr checks 231 --watch", description: "Wait for the checks" }, ms: 1800, result: "All checks were successful\n✓ test  41s\n✓ lint  12s\n✓ build 58s" },
      },
      {
        say: "CI is green. **PR #231 is merged.**",
      },
    ],
  },
  {
    // A scheduled task on a support line: review the hour's calls, fix what is causing bad
    // ones. A scheduled run shows its report only, so the agent speaks once, at the end.
    match: /support calls/i,
    startTokens: 18_400,
    steps: [
      { tool: { name: "Bash", input: { command: "./scripts/calls --since 1h --format jsonl > /tmp/calls.jsonl && wc -l /tmp/calls.jsonl", description: "Fetch the last hour of calls" }, ms: 1100, result: "      42 /tmp/calls.jsonl" } },
      { tool: { name: "Bash", input: { command: "./scripts/score-calls /tmp/calls.jsonl", description: "Score the calls" }, ms: 1500, result: "42 calls · average 3.9 / 5 (previous hour 4.4)\n 9 × caller hung up during transfer\n 3 × refund answer cites the old policy" } },
      { tool: { name: "Edit", input: { file_path: "flows/transfer.yaml", old_string: "loop: true", new_string: "loop: false\n    then: offer_callback" }, ms: 600, result: "The file flows/transfer.yaml has been updated." } },
      { tool: { name: "Bash", input: { command: "npm test -- flows && gh pr create --fill", description: "Run the flow tests and open a pull request" }, ms: 1600, result: "Tests: 26 passed, 26 total\nhttps://github.com/northwind-shop/support-line/pull/88" } },
      {
        say: "**42 calls reviewed.** Average quality 3.9 of 5, down from 4.4.\n\n| What went wrong | Calls | Cause |\n|---|---|---|\n| Caller hung up during transfer | 9 | Hold message loops after 40 s |\n| Refund answer was out of date | 3 | Prompt still says 14 days |\n\n**Fixed both and opened PR #88.**\n\n- `flows/transfer.yaml`: the hold message plays once, then offers a callback\n- `prompts/refunds.md`: 30-day policy\n- 26 of 26 flow tests pass",
      },
    ],
  },
  {
    // The app's browser: reproduce a bug on a staging site the way a customer would, fix it,
    // and check the fix in the same browser. Every browser step here is real.
    match: /promo code/i,
    title: "Promo code breaks checkout",
    steps: [
      {
        say: "I'll reproduce it on staging first. Opening a browser.",
        tool: { name: "Bash", input: { command: `node "$JOINT_BOB_BROWSER_CLI" start ${shop}/`, description: "Open the staging shop in a browser" }, ms: 300, run: () => browser("start", `${shop}/`) },
        pauseMs: 3800,
      },
      {
        say: "The shop is up. Adding a product to the cart.",
        tool: { name: "Bash", input: { command: 'node "$JOINT_BOB_BROWSER_CLI" click "#add-mug"', description: "Add a product to the cart" }, ms: 500, run: () => browser("click", "#add-mug") },
        pauseMs: 900,
      },
      {
        say: "Going to checkout.",
        tool: { name: "Bash", input: { command: 'node "$JOINT_BOB_BROWSER_CLI" click "#checkout"', description: "Open the checkout" }, ms: 400, run: () => browser("click", "#checkout") },
        pauseMs: 900,
      },
      {
        say: "Applying a promo code, the way a customer would.",
        tool: { name: "Bash", input: { command: 'node "$JOINT_BOB_BROWSER_CLI" fill "#promo" WELCOME10 && node "$JOINT_BOB_BROWSER_CLI" click "#apply"', description: "Apply a promo code" }, ms: 400,
          run: async () => { await browser("fill", "#promo", "WELCOME10"); await pause(700); await browser("click", "#apply"); await pause(500); return browser("evaluate", "document.querySelector('#error').textContent"); } },
        pauseMs: 700,
      },
      {
        say: "**Reproduced.** The page says “Something went wrong” and the discount never arrives. The promo handler reads `promo.percent`, but codes are stored as `percentOff`.",
        tool: { name: "Edit", input: { file_path: "src/checkout/promo.ts", old_string: "total * (1 - promo.percent / 100)", new_string: "total * (1 - promo.percentOff / 100)" }, ms: 700,
          run: async () => { await fetch(`http://127.0.0.1:${shopPort}/__fix`, { method: "POST" }); return "The file src/checkout/promo.ts has been updated."; } },
      },
      {
        say: "Deployed to staging. Trying the same steps again.",
        tool: { name: "Bash", input: { command: 'node "$JOINT_BOB_BROWSER_CLI" navigate ' + `${shop}/checkout`, description: "Reload the checkout and apply the code again" }, ms: 400,
          run: async () => { await browser("navigate", `${shop}/checkout`); await pause(900); await browser("fill", "#promo", "WELCOME10"); await pause(700); await browser("click", "#apply"); await pause(500); return browser("evaluate", "document.querySelector('#total').textContent"); } },
        pauseMs: 900,
      },
      {
        say: "The code applies now. Placing a test order to be sure.",
        tool: { name: "Bash", input: { command: 'node "$JOINT_BOB_BROWSER_CLI" click "#place"', description: "Place a test order" }, ms: 400, run: async () => { await browser("click", "#place"); await pause(600); return browser("evaluate", "document.querySelector('h1').textContent"); } },
        pauseMs: 700,
      },
      {
        say: "**Fixed, and checked in the browser.**\n\n- **Bug:** a promo code threw an error at checkout\n- **Cause:** the handler read `promo.percent`; the field is `percentOff`\n- **Proof:** WELCOME10 applied and a test order went through on staging\n\nOpened **PR #58**.",
      },
    ],
  },
  {
    // A secret account attached to the project: the agent can use it, and its value is never in the chat.
    match: /pull request for the retry/i,
    title: "Pull request for the retry fix",
    steps: [
      {
        say: "Checking which accounts this project gives me.",
        tool: { name: "Bash", input: { command: 'node "$JOINT_BOB_SECRET_CLI" list', description: "List the secret accounts available here" }, ms: 500, run: () => tool("JOINT_BOB_SECRET_CLI", "list") },
      },
      {
        say: "This project has a GitHub account, **northwind-bot**. Its token is already in my environment, so I can push without ever printing it.",
        tool: { name: "Bash", input: { command: "git push -u origin retry-idempotency && gh pr create --title \"Reuse the idempotency key across payment retries\" --fill", description: "Push the branch and open a pull request" }, ms: 1500, result: "branch 'retry-idempotency' set up to track 'origin/retry-idempotency'\nhttps://github.com/northwind-shop/checkout-api/pull/214" },
      },
      {
        say: "**Opened PR #214** as northwind-bot.\n\nThe token came from the project's secret account. It does not appear anywhere in this conversation.",
      },
    ],
  },
);

export const fallbackScenario = {
  match: /.*/,
  steps: [{ say: "On it. I'll read the relevant code first and report back with a plan." }],
};
