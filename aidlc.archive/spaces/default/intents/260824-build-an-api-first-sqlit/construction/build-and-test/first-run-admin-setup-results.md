# First-run administrator setup results

## Built

- Removed generated administrator credentials from `scripts/install-service.sh`.
- Removed the obsolete administrator bootstrap script.
- First-run browser setup now accepts the owner-selected username/password, creates a permanent administrator, and signs it in immediately.
- Setup hides the current-password field; ordinary login hides the new-password field.
- Added a global native `hidden` rule and bumped the PWA shell cache to v52.

## Validation

- 133/133 tests passed.
- TypeScript typecheck and build passed.
- JavaScript, shell syntax, and diff checks passed.
- Deployed release `e3f50bc914a041a0404fb28656b89865b09eda04` to Mac and homeserver.
- Backed up each live SQLite database before clearing old auth records.
- Both real nodes report health `ok`, zero users/sessions, SQLite `quick_check=ok`, and `setupRequired: true` over Tailscale HTTPS.
