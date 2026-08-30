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

`scripts/hooks/pre-push` blocks a push to `main` that changes `src/`, `public/`, or `bin/` unless the pushed commits bump `package.json` and add a matching `CHANGELOG.md` section. When they do not, the gate has Claude (Haiku) write both files in the working tree and refuses the push; commit what it wrote and push again. Run `./scripts/install-git-hooks.sh` once per clone to install the hook, and `node scripts/changelog-gate.mjs <base-sha> <head-sha> --check` to check without calling Claude.

## PWA cache

When changing the frontend shell or icons, bump `CACHE_NAME` in `public/sw.js` and verify every asset in `APP_SHELL` exists.
