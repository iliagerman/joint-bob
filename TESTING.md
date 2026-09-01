# Testing

Every feature ships with tests that would fail if the feature broke. This file
describes the infrastructure available and how to use it.

## Commands

```bash
npm test          # full suite, no browser needed (~1 min)
npm run test:ui   # browser journey against a seeded node (needs Chrome)
npm run test:all  # both
npm run typecheck
npm run build
```

Run a single file while iterating:

```bash
node --import tsx --test test/canvas-ui.test.ts
```

## The three kinds of test in this repository

| Kind | Where | What it proves |
| --- | --- | --- |
| Source assertions | `test/*.test.ts` | A specific rule is present in `public/*.js`, `styles.css`, or `src/*.ts` |
| Server tests | `test/*.test.ts` | The real server, started on a free port with an isolated database, answers correctly over HTTP and WebSocket |
| Browser tests | `test/ui/*.test.ts` | A real Chrome walks a user journey and the page actually renders and works |

Source assertions are cheap and catch deletions, but they cannot see behaviour.
A regression that squashed the canvas conversation picker to an unreadable height
passed every source assertion in this repository, because the CSS rules the tests
checked for were all still there. Reach for a server test or a browser test
whenever the thing that can break is behaviour or layout.

## Test infrastructure

### `test/dev-nodes.ts`

The shared harness. It seeds a disposable environment, starts real servers
against it, and signs in.

```ts
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

const root = await mkdtemp(path.join(os.tmpdir(), "my-test-"));
const environment = await seedDevEnvironment(root, 1);   // or 2 for a paired cluster
const node = environment.nodes[0];
const server = await startDevNode(environment, node);
const session = await signIn(environment, node);

const response = await api<{ projects: Array<{ name: string }> }>(node, session, "GET", "/projects");
```

| Export | Purpose |
| --- | --- |
| `seedDevEnvironment(root, 1 \| 2)` | Builds one node, or two already-paired nodes, on free ports. Returns their ids, urls, data directories, cookie names, and seeded projects |
| `startDevNode(environment, node)` | Spawns `src/server.ts` for that node and resolves once it is listening |
| `stopDevNode(child)` | Stops it. Always call this in a `finally` or `after` |
| `signIn(environment, node)` | Signs the seeded administrator in, returns its cookie and CSRF token |
| `api(node, session, method, endpoint, body?)` | Authenticated JSON call, returns `{ status, body }` |
| `freePort()` | A free port, for tests that need one directly |

Each seeded node gets its own SQLite database and its own session cookie name.
Nothing reads or writes `~/.joint-bob`, `~/.pi`, or `~/.claude`.

### Seeded fixture data

`scripts/dev-seed.ts` writes the fixtures both the harness and `npm run dev:local`
use. Three projects — **Internal Assistant** (7 conversations), **Joint Bob** (3),
**Infra Scripts** (2) — with dummy Pi and Claude transcripts written in the exact
formats the app parses. The set is deliberately varied: short titles, a very long
title, a one-line preview, and a preview long enough to need two wrapped lines.

Add a conversation to `demoProjects` in that script when a test needs a shape that
is not there yet. Prefer extending the fixtures over inventing a one-off transcript
inside a test, so the browser suite and a developer's own browser see the same data.

### Browser suite — `test/ui/ui-smoke.test.ts`

Drives your installed Chrome through `playwright-core` (no browser download).
It signs in through the real form, opens a project, reads a transcript, and opens
the canvas picker, and it fails on any console error or any 4xx/5xx response.

It lives outside the `test/*.test.ts` glob on purpose. It needs a Chrome binary,
and a browser suite that silently skips itself reports success while testing
nothing. `npm test` stays fast and browser-free; `npm run test:ui` is explicit.

Conventions that keep it stable:

- Wait for **application state**, never a load event or a sleep. `await page.getByText("Internal Assistant").waitFor()` is a readiness signal; `waitForTimeout` is not.
- Use `data-testid` for controls and visible text for content. Every interactive element must carry a `data-testid`.
- Set a desktop viewport. The canvas is hidden below 1024px.
- Before measuring geometry, wait two animation frames.
- **Assert the precondition the bug needs.** The picker rows only collapsed once the list overflowed its maximum height, so the test selects the project with the most conversations and asserts the list is actually scrolling before it measures a single row.

`test/ui/ui-cluster-login.test.ts` covers the two-node case in one browser
context: cookies ignore the port, so both nodes must name their own session
cookie or signing into the second silently signs you out of the first.

### Cluster suite — `test/cluster-sanity.test.ts`

Runs inside `npm test`. It starts both paired nodes and checks pairing, shared
project inventory, project aliasing, live node-to-node traffic, and handing a
conversation to the other node. Extend it when you touch replication, ownership,
transfer, or anything else that only means something with two nodes.

## Writing a test that is worth having

**Prove it fails.** Break the code the test covers, run the test, and confirm it
fails with a message that names the problem. Then restore the code. A test that
passes against the broken version is worse than no test, because it is read as
coverage. This is not optional — it is how the canvas-picker assertion was found
to be checking a list too short to trigger the bug it was written for.

The rest follows from that:

- One behaviour per test, named for the behaviour.
- Assert the specific value, not that something is truthy. `assert.equal(row.height, 57)` is brittle; `assert.ok(row.height > 44, message)` names the floor that mattered. Include the actual value in the message.
- Test the failure path as well as the happy path.
- No test that cannot fail: no `assert.ok(true)`, no assertion on a value the test itself just computed, no snapshot of whatever the code currently does.
- Clean up in `finally` or `after`. Servers, browsers, and temp directories all leak otherwise.
- Never reach into `~/.joint-bob`, `~/.pi`, or `~/.claude`. Use the harness.

## When adding a feature

1. Write the test first, at the layer where the feature can actually break.
2. Watch it fail.
3. Implement until it passes.
4. Add a cluster case to `test/cluster-sanity.test.ts` if the feature spans nodes.
5. Add or extend a browser case in `test/ui/` if the feature has a UI.
6. Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:ui`
   before delivery.

Frontend shell changes also need `CACHE_NAME` bumped in `public/sw.js`; several
tests pin that value, so bump those together.
