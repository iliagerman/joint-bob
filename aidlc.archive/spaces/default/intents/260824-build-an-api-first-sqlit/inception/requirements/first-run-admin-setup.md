# First-run administrator setup

## Requirement

A newly installed node has no username or password. Its first browser visitor must create the node-local administrator by choosing both values. Setup signs that administrator in immediately and can run only once.

## Acceptance criteria

- Installer never creates, accepts, stores, or prints administrator credentials.
- An empty user table returns `setupRequired: true`.
- Setup accepts a valid owner-selected username and password, creates the sole administrator, and returns an authenticated secure-cookie session with no forced password change.
- Normal login shows no new-password field.
- Setup hides the current-password field and shows one owner-selected password field.
- Existing configured nodes remain configured during ordinary upgrades.
