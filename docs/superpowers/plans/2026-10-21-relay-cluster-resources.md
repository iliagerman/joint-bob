# Relay cluster resources implementation plan

> For agentic workers: use `executing-plans` or `subagent-driven-development` after approval. Checkboxes track deliverables.

**Goal:** Enforce relay resources per conversation's relay + cluster route.

**Architecture:** Resolve signed policy into a route-specific resource set; install into isolated managed storage and inject it into that conversation's harness.

**Tech stack:** Existing TypeScript, SQLite, Zod, harness adapters and browser UI. No new service.

**Spec:** [Design](../specs/2026-10-21-relay-cluster-resources-design.md). Draft for review, not execution approval.

## Global constraints

All-cluster rules win conflicts; distinct items combine. Never merge other routes or modify independently installed resources. Preserve legacy behavior until explicit migration. Resolve diverged `main` with the user before code changes; leave unrelated work untouched.

## Implementation sequence

For each step: write failing behavior tests, verify failure, implement, then rerun the focused tests before continuing.

- [ ] **1. Scoped policy resolution.** Extend `src/relay/resource-policy.ts`, `src/relay/enabled-snapshot.ts` and `src/server/routes/relay.ts` with explicit resource selections and all/selected-cluster targets. Add `src/relay/effective-resources.ts` exposing `resolveRelayResources(policy, route, harness)`. Test global precedence, additive items, overlapping-rule rejection and isolation in `test/relay-skill-policy.test.ts` and `test/relay-skill-policy-api.test.ts`.

- [ ] **2. Authoritative conversation route.** Add `src/conversation-resource-route.ts` to persist and validate `ResourceRoute = { relayNodeId: string; clusterId: string }`. Wire conversation creation, `src/conversation-records.ts`, `src/harnesses/runtime.ts`, `src/server/harness-sessions.ts`, remote forwarding and scheduled execution. Automatically select only a unique authorized route. Add `test/conversation-resource-route.test.ts` covering resume, ambiguous/missing routes, forged context, membership changes and transport reconnects. A shared running session must not switch policy because another viewer connects.

- [ ] **3. Authorized resource delivery.** Extend `src/relay/protocol.ts`, `src/relay/relay-server.ts`, `src/relay/runtime.ts` and skill delivery with versioned, digest-verified skill/MCP/plugin packages. Add `src/relay/resource-bundle.ts` and membership-proof validation before scoped policy/package access. Add `test/relay-resource-delivery.test.ts` covering unauthorized clusters, stale signatures, traversal, corrupt bundles, credential references and unsupported harnesses. Keep old-node behavior explicit; never downgrade scoped policy to machine-wide enforcement.

- [ ] **4. Isolated activation and cleanup.** Add `src/relay/resource-installs.ts` for atomic staging and ownership/reference tracking. Update `src/resource-activation.ts`, `src/resource-inventory.ts`, `src/agent-resources.ts`, harness resource builders and `src/relay/index.ts`. Replace the machine-wide relay skill path for scoped mode. Add `test/relay-resource-isolation.test.ts`: two conversations on one machine load different same-name resources, an independent copy remains unchanged, removal preserves other references and active turns, and policy refresh applies before the next turn.

- [ ] **5. Controls and migration.** Update `public/app/relay-serving.js`, `public/app/resources.js`, conversation route controls, `public/index.html` and corresponding APIs. Provide all/selected-cluster resource selection, route selection when needed, enforcement-source labels and a legacy migration preview. Extend `test/ui/ui-relay.test.ts` and add `test/ui/ui-relay-cluster-resources.test.ts` covering saved scope, locked global items, conversation isolation and migration without lost restrictions.

## Review focus

Pin each risk to the tests above: ambiguous route/resume in step 2; forged membership, mixed versions and unavailable MCP credentials in step 3; same-name independent installs, interrupted updates and busy-session cleanup in step 4; legacy restrictions in step 5.

## Verification

Run focused files with `npm run test:file -- <paths>`, then `npm run typecheck`, `npm run build` and `npm test`. Run the affected UI tests through the isolated harness in `TESTING.md`, with disposable HOME/data, synthetic accounts, loopback servers and browser cleanup. No real accounts or production profiles.

Accept only when two simultaneous conversations on one node demonstrate different cluster resource sets, global precedence, automatic updates and safe removal without changing independent installations.
