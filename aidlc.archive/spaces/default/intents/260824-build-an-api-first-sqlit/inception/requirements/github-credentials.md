# GitHub Credential Requirements

- Store separate homeserver GitHub tokens for Personal and Sela accounts.
- Let each project select either account.
- Let each project save or clear a token override.
- Never return saved token values through the API.
- Scope credentials to Pi/Claude child commands for that project; do not mutate global `gh` or Git credential configuration.
- Support GitHub CLI and HTTPS Git authentication.
- Keep credential files server-side with owner-only permissions.
