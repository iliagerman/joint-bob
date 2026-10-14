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

export const scenarios = [
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
