# Project-Level Rules

> Project-specific specialisation and corrections. Loaded after `org.md` and
> `team.md` as strict-additive guidance; contradictions with broader policy
> are rejected. Populated by practices-discovery and the self-learning loop.
>
> Use sparingly: most teams don't need a project layer. Reach for it
> only when this specific project needs stable, durable guidance beyond the
> team practice (for example, package-specific release checks or an additional
> regression suite for a legacy component).

## Way of Working

<!-- Project-specific specialisation. Example: -->
<!-- This monorepo requires package-scoped branch names and a package owner -->
<!-- review in addition to the team's normal merge policy. -->

## Walking Skeleton

<!-- Project-specific specialisation. Example: -->
<!-- The walking skeleton must exercise the legacy service adapter as well -->
<!-- as the new service boundary. -->

## Testing Posture

<!-- Project-specific specialisation. -->

## Deployment

<!-- Project-specific specialisation. -->

## Code Style

<!-- Project-specific specialisation. -->

## Tech Stack

<!-- Technology choices locked for this project. -->

## Decided

<!-- Decisions made in earlier stages that should not be re-asked. -->
<!-- Format: DECIDED: [decision] (Stage [slug], [date]) -->

## Scope Overrides

<!-- Custom scope rules for this project. -->

## Forbidden

<!-- Populated by practices-discovery affirmation gate. -->
<!-- Format: NEVER [behavior] (affirmed [date]) -->
<!-- Example: NEVER throw exceptions across service layer boundaries (affirmed 2026-05-17) -->

## Mandated

<!-- Populated by practices-discovery affirmation gate. -->
<!-- Format: ALWAYS [behavior] (affirmed [date]) -->
<!-- Example: ALWAYS use Result<T,E> for fallible operations in service layer (affirmed 2026-05-17) -->

## Corrections

<!-- Project-specific corrections from human feedback. -->
<!-- Format: NEVER/ALWAYS [behavior] (learned [date]) -->
- Always disclose when a repository rescan replaces a broader knowledge store with narrower deep coverage, including the discarded paths recoverable from Git history. (learned 2026-08-28) <!-- cid:260827-conversation-review-sync:reverse-engineering:cd336ae5c1a43fa61ae3bfca40382331458a4bde84fb13e10477a9f816cfc62f -->
- Determine transcript recency from the latest valid conversation event, not filesystem modification time, because synchronization can change file timestamps. (learned 2026-08-28) <!-- cid:260827-conversation-review-sync:requirements-analysis:9e5d4d59a7ba77602eb7da38073dd149b47d50bafed029bbc35d16dcac0a9b1c -->
- When resolving synchronized transcript conflicts, move obsolete copies to temporary storage rather than merging divergent event streams or deleting recovery data directly. (learned 2026-08-28) <!-- cid:260827-conversation-review-sync:requirements-analysis:0755b772ce335d284dcdcc708fa918cd5e1b5208def7e9699c7f52341db739a2 -->
