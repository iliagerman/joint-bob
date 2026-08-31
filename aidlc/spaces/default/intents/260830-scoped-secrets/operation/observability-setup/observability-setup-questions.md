# Observability Setup — Clarifying Questions

**Stage**: observability-setup · **Intent**: `260830-scoped-secrets` · **Depth**: Minimal

## What already exists, observed from the deployed system

No NFR Design or Infrastructure Design artifact exists — both are SKIP under the `express`
scope — so the observable surface below was read from the running nodes and the workspace, not
from a design document. Nothing here is invented.

| Signal | Where it lives | Notes |
|---|---|---|
| Service liveness | `GET /api/health` | 200 on both nodes; port 8790 (Mac), 8787 (homeserver) |
| Application log | `~/.joint-bob/logs/node.log` | plain text |
| Error log | `~/.joint-bob/logs/node.error.log` | plain text |
| Deploy log | `~/.joint-bob/logs/push-deploy.log` | appended per push-triggered deploy |
| Audit trail | `audit_events` table in `~/.joint-bob/node.db` | in-app, queryable |
| Service supervision | `systemctl --user` (Linux) / launchd (macOS) | restart behaviour lives here |
| Operator notification | VAPID web push (`src/push.ts`) | already used for long-run completion |

There is **no** CloudWatch, no X-Ray, no metrics backend, no log aggregation, and no alerting
pipeline. This is a single-user self-hosted product on two machines.

---

## Q1. Should this stage add instrumentation code, or document what exists?

- A. **Documentation only.** Write down the signals, the queries, and the checks against what is
  already there. No code change, no new dependency.
- B. **Add a small amount of instrumentation** — for example a structured log line whenever
  credential resolution produces no token for a project, since that is the new failure mode this
  change introduces.
- C. **Add a metrics backend** (Prometheus endpoint or similar) so signals can be graphed over
  time.
- X. Other (please specify)

[Answer]:

## Q2. What should happen when something goes wrong?

There is no alerting pipeline, but the product already sends web push notifications to the
operator's devices.

- A. **Nothing automated.** The operator notices and investigates; this document tells them
  where to look.
- B. **Reuse web push** for operational alerts — for example, notify when an agent's git push
  fails to authenticate.
- C. **Design an alerting pipeline** (external monitor hitting `/api/health`, notifying on
  failure).
- X. Other (please specify)

[Answer]:

## Q3. What is worth watching specifically because of this change?

Pick the ones that matter; this shapes what the runbook tells someone to check.

- A. **Credential resolution failures** — a project that resolves no token where it used to
  resolve one. This is the regression the migration could cause.
- B. **Identity drift** — `gh` and `git push` resolving different identities. Structurally
  impossible now, but worth a check that proves it.
- C. **Replication behaviour** — a node-local account unexpectedly leaving the node.
- D. **All three.**
- X. Other (please specify)

[Answer]:
