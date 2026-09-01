# Joint Bob agent notes

## Workflow

- Read before editing and preserve unrelated working-tree changes.
- Keep Joint Bob-owned state in node-local SQLite under `~/.joint-bob`.
- Keep repositories, transcripts, worktrees, and Syncthing data filesystem-owned.
- Run `npm run typecheck`, `npm test`, and `npm run build` before delivery.
- Run Terraform format, validate, and tests when `deploy/aws-ec2-test` changes.

## AI-DLC bypass

- Bypass AI-DLC for one request only when the user explicitly says `bypass AI-DLC` or `skip AI-DLC`.
- Park any active AI-DLC workflow before changing feature code under that bypass.
- Never infer a bypass from urgency, blanket approval, or a request to avoid questions.

## Deployment

Production services run from `~/.local/share/joint-bob/app`, never from a source checkout.

Linux service:

```text
joint-bob.service
```

macOS launch agent:

```text
com.joint-bob.node
```

Node-specific proxy URLs, model aliases, credentials, and executable overrides belong in `~/.joint-bob/env` or an untracked native-service override. Public templates stay machine-neutral.

See `README.md` for installation, node pairing, private HTTPS, EC2 smoke testing, and service commands.

## Changelog

Every deployment is a version. `package.json` holds the semantic version; `CHANGELOG.md` holds one `## <version> — <date>` section per release, newest first. The app shows the newest ten in Settings and opens a "What's new" dialog once after an upgrade.

`scripts/hooks/pre-commit` has Claude Haiku add one `## Unreleased` bullet for each staged change under `src/`, `public/`, or `bin/`. On a push to `main`, `scripts/hooks/pre-push` has Haiku review the full pushed commit range, replace those entries with coherent release notes, bump `package.json`, and refuse the push. Commit the generated release files and push again. Only pushes containing application changes deploy. Run `./scripts/install-git-hooks.sh` once per clone to install both hooks, and `node scripts/changelog-gate.mjs <base-sha> <head-sha> --check` to check without calling Claude.

## Credentials

One model: a secret account holds named environment variables, encrypted at rest with the node's key. Attach an account to a **workspace**, a **project**, or a **conversation**; resolution merges those three in that order and the most specific scope wins per variable name. A `github`-provider account holds exactly one `GH_TOKEN`, from which `GITHUB_TOKEN`, `PI_GITHUB_TOKEN`, `GIT_ASKPASS` and `GIT_TERMINAL_PROMPT` are derived. There is no separate GitHub credential system, and nothing in the resolution path is special-cased by provider.

An agent's environment is composed once, at spawn. Changing an attachment on a running conversation is saved but takes effect the next time it runs.

## PWA cache

When changing the frontend shell or icons, bump `CACHE_NAME` in `public/sw.js` and verify every asset in `APP_SHELL` exists.
