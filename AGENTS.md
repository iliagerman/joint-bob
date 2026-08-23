# Joint Bob agent notes

## Workflow

- Read before editing and preserve unrelated working-tree changes.
- Keep Joint Bob-owned state in node-local SQLite under `~/.joint-bob`.
- Keep repositories, transcripts, worktrees, and Syncthing data filesystem-owned.
- Run `npm run typecheck`, `npm test`, and `npm run build` before delivery.
- Run Terraform format, validate, and tests when `deploy/aws-ec2-test` changes.

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

## PWA cache

When changing the frontend shell or icons, bump `CACHE_NAME` in `public/sw.js` and verify every asset in `APP_SHELL` exists.
