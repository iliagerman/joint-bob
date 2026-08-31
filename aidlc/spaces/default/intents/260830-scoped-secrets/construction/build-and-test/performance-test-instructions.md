# Performance Test Instructions — Scoped Secrets

## Applicability

**Not applicable to this change.** The requirements
(`<record>/inception/requirements-analysis/requirements.md`) define seven non-functional
requirements — NFR1 secrecy at rest, NFR2 secrecy in transit to the browser, NFR3 no
accidental egress, NFR4 resolution determinism, NFR5 migration safety, NFR6 no regression,
NFR7 backward tolerance across node builds. **None of them is a performance target**: there
is no latency, throughput, concurrency or capacity requirement to validate, and the Minimal
test strategy generates no performance suite.

The product is also single-user and self-hosted, so there is no concurrency dimension to load
test.

## What was checked instead

The one place this change could plausibly have degraded a hot path is secret resolution, which
runs at agent spawn. The relevant facts:

- Resolution is three indexed SQLite reads against a local file — the same shape as the two it
  replaces, plus one.
- A new index, `secret_assignments_account_id`, was added so account deletion and alias
  re-keying are index lookups rather than full scans. The change is net favourable.
- Injection is single-shot at spawn, so resolution cost is paid once per agent process, never
  per request.

## If a performance question arises later

Measure spawn-to-first-token for an agent in a project with attachments at all three scopes,
against the same measurement before this change. Anything else would be measuring SQLite, not
this feature.
