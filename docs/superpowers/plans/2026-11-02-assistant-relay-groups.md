# Discoverable assistants and relay groups — implementation plan

Spec: `docs/superpowers/specs/2026-11-02-assistant-relay-groups-design.md` (approved 2026-11-02).
Approved UI: `mockups/assistant-relay-groups.html`.

Builds on the uncommitted chat-first assistant work in `public/assistant.*`, `src/personal-assistants.ts` and `src/server/routes/personal-assistants.ts`. Keep its behavior and tests passing.

## Global constraints

- Decision model (`typesafe` / `laya`, user copy "decision model") makes every authorization judgment. Code validates IDs, inputs and access; it never substitutes an affirmative decision. A missing or invalid answer pauses the request as `failed` with nothing executed.
- Public work never starts an agent session and never reads the owner's private chats, topics, browser profiles, secrets other than the one bound to an operation, or project files.
- Social machine endpoints are signed `POST /api/cluster/v2/social/*`, allowed only between members of a shared active relay sharing group. Each handler authorizes its own operation and account.
- Persist before effects. Stable IDs make every send, accept and approval idempotent. An effect whose outcome is unknown becomes `uncertain`, never retried automatically.
- Tests use the isolated harness in `TESTING.md`, loopback fixture servers for the decision model and Google Calendar, and synthetic accounts. No live decision-service or calendar calls.
- List views fit the height and page; no vertical scrolling of lists.

## Task 1: Assistant resources

Files: `src/assistant-resources.ts` (new), `src/personal-assistants.ts`, `src/server/routes/personal-assistants.ts`, `src/scoped-skills.ts`, `src/server/browser.ts`.

- Store per assistant: disabled skill names, disabled plugin names, attached browser profile IDs (with the grants this feature created).
- Enforce: skills unavailable for topic conversations of the assistant when disabled or from a disabled plugin; MCP tools of disabled plugins filtered with the existing tool filter.
- Browser logins: attach creates conversation grants for every topic (existing and new); detach revokes only grants it created. New sign-in creates a profile on the execution node and starts it for the source conversation. Login requests on an attached profile become a "Sign in" activity item.
- API: `GET/PUT /api/personal-assistants/:id/resources`, `POST /api/personal-assistants/:id/logins` (new sign-in), `POST …/logins/attach`, `DELETE …/logins/:profileId`.
- Tests: store + enforcement unit tests; API test with a dev node.

## Task 2: Social foundation and discovery

Files: `src/social/store.ts`, `src/social/network.ts`, `src/social/directory.ts`, `src/server/routes/social.ts`, `src/relay/sharing-groups.ts`.

- Tables: per-account profile (default assistant, limits), discovery switches per relay for the person and each assistant, blocks.
- `socialPeers()`: members of active relay sharing groups with their relays.
- Machine endpoint `social/directory/search`: answers only for listings published on a relay both machines share. Listings carry kind, stable ID, name, description, owner, home node, public actions; never email or private data.
- Local API: `GET /api/social/me`, `PUT /api/social/discovery`, `PUT /api/social/default-assistant`, `GET /api/social/search?q=` (fan-out, dedupe by ID, routes kept, unavailable relays reported), blocks.
- Tests: unit tests for listing filtering and merge; relay e2e (relay + two machines) for search.

## Task 3: Groups

Files: `src/social/groups.ts`, `src/social/store.ts`, `src/server/routes/social.ts`.

- Host tables: groups, members (intervals, link `with`/`alone`, companion owner), invitations (pending/accepted/declined/revoked/expired, 7-day expiry), ordered messages with client IDs.
- Member tables: group index, received invitations, outbox for an offline host.
- Machine endpoints: invite delivery, respond, invite, send, list messages (only within the member's intervals), members, leave, remove, close, changed (push).
- Local API mirrors them for the signed-in person. Accepting adds the person and the then-default assistant atomically; leaving removes the recorded companion; removing a person removes their companion.
- Tests: host-store unit tests (atomic companion, intervals, idempotency, expiry, creator-only removal); relay e2e for invite → accept → message → leave.

## Task 4: Direct requests

Files: `src/social/threads.ts`.

- Threads hosted on the assistant's execution node, one per requester. Requester node keeps an index. Machine endpoints: open, send, list, changed.
- Tests: caller isolation, catalog only, resume same thread.

## Task 5: Public actions, decisions and approvals

Files: `src/social/actions.ts`, `src/social/calendar.ts`, `src/social/time-parse.ts`, `src/social/decisions.ts`, `src/social/requests.ts`, `src/classifiers/typesafe.ts`.

- Catalog per assistant: name, description, inputs, private instructions, operations (`calendar.freebusy`, `calendar.create`, `info.share`), status draft/published/disabled, revision. No operation → draft only.
- Pipeline per message for each member assistant: record → limits → decision (attention + action) → code parses inputs → decision on the concrete proposal (execute / ask owner / decline) → approval if needed → execution boundary recheck → effect → reply → receipts. Owner notices for `notify`.
- Assistant-authored messages can only notify the owner; never start public execution.
- Test runs (`POST …/actions/:id/test`) use the decision model and a dry-run adapter; no external effect.
- Owner activity API: list, approve once, reject, edit (new proposal + new check), dismiss notice, resolve uncertain.
- Tests: decision fixture server; calendar fixture server; executor cannot self-authorize; stale/edited/duplicate proposals refused; uncertain not retried; record-only starts nothing.

## Task 6: Assistant UI

Files: `public/assistant.html`, `public/assistant.js`, `public/assistant/*.js` (new modules), `test/ui/ui-personal-assistant.test.ts`, `test/ui/ui-assistant-social.test.ts` (new).

- Replace the single-column page with the approved shell: rail (desktop) / bottom tabs (mobile); assistant tabs Chat, Resources, Public actions, Settings, Saved items; Find, Groups, Invitations, Requests, Who can find you; Activity drawer.
- Keep chat turns, settings, execution, MCP, secrets, saved items, automations and copy link working.
- UI test: journey on one dev node with fixture decision/calendar servers.

## Task 7: Verify

- `npm run typecheck`, `npm run build`, focused tests for touched files, UI tests, `git diff --check`.
- Code review of the diff.
