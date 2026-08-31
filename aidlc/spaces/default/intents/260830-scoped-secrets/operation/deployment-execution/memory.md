<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->

- 2026-08-31T06:34:15Z — checked both nodes' installed version and service state after the failed first deploy BEFORE fixing anything; the installer had rolled back, so both were still on 0.2.0 with credentials untouched, which turned a scary failure into a routine fix. Establishing the actual blast radius before reacting is what made the fix safe.

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->

- 2026-08-31T06:34:15Z — the human asked for both nodes at once, superseding the one-node-first sequencing approved at Deployment Pipeline one stage earlier; recorded the supersede in the deployment log rather than silently following the newer instruction, so the artifact does not read as if the earlier decision was forgotten.

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->

- 2026-08-31T06:34:15Z — dropped the installer's `cleanupLegacyGitHubCredentialFiles()` call rather than porting it into the new migration module; the legacy `github-auth.json` path is unreadable now that its module is gone, neither node has such a file, and porting dead cleanup would have added a code path with nothing to clean.

## Open questions
- 2026-08-31T06:34:15Z — `scripts/` is verified only by string-ordering tests, so a broken reference inside a shell script reaches deployment before anything catches it; that is how the install-time import of the deleted module survived Code Generation and Build and Test.
- 2026-08-31T06:34:15Z — the machine's `gh` active account was `germanilia` while the repository belongs to `iliagerman`, and the switch made to push is global rather than repo-local; worth deciding whether that should be pinned per repository.

<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
