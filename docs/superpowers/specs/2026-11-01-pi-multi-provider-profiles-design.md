# Pi profiles with multiple providers

## Approved requirement

The user approved both configurations:
- One Pi profile containing several providers, each with its own API key or supported OAuth login.
- Several Pi profiles containing one provider each, including different accounts for the same provider.

Model selection uses credentials from the selected Pi profile. Claude profiles stay separate. Existing ChatGPT profiles keep working. z.ai API-key authentication is the concrete acceptance case.

## Implementation decisions

These are implementation choices, not additional user requirements.

- Add the profile kind `pi`; retain existing `claude` and `openai-codex` kinds and their IDs, selections, credentials, and pool behavior. Do not perform an automatic credential migration.
- A Pi profile's existing private `auth.json` contains a credential keyed by each actual Pi provider ID. Do not conflate the profile kind `pi` with a model provider such as `zai` or `openai`.
- Discover supported providers and authentication methods from the installed Pi runtime, including app-configured provider extensions. Do not hardcode another provider allowlist or expose unrelated machine extensions.
- Add, authenticate, replace, and disconnect providers independently. Disconnecting one must preserve the others.
- A selected Pi profile is an exclusive credential boundary. Missing credentials fail explicitly; never fall through to machine credentials or another profile. Existing unassigned-node behavior stays unchanged.
- Keep profile metadata under existing ownership, sharing, and replication rules. New Pi-profile credentials remain node-local. Do not extend OAuth token-borrowing endpoints to export API keys or refresh tokens. A replicated profile with no local sign-ins reports that configuration is required on this node.
- Preserve scope precedence: conversation, project, workspace, default. An explicit Pi-kind selection takes precedence for Pi turns; legacy selections remain usable when no Pi-kind selection exists.
- Pi profiles can be pool members. For this change, a Pi member can attempt the requested model provider when configured locally. A member missing that provider is unavailable, not permission to use node credentials. Preserve existing Claude/ChatGPT cross-provider fallback settings; do not invent automatic model choices for arbitrary providers.
- Show provider-level status without returning credentials. Support API-key-provider metadata fields required by the SDK's login flow, not just a bare password field.

## Interface and UI

Keep management inside Settings > Harnesses. Add a Pi profile type alongside existing types. Its expanded editor contains a searchable provider selector and a paginated provider list, with authentication methods supplied by Pi. Credential inputs are write-only. Existing login prompt handling remains the basis for OAuth and provider-specific input.

Offer Pi profiles in existing scope and automation selectors. Display the configured provider names so profiles with several providers are distinguishable. Preserve unavailable saved assignments instead of silently clearing them.

## Non-goals

No automatic account migration, new secret synchronization, automatic fallback-model guessing, custom-endpoint editor, new provider implementation, deployment, or unrelated UI refactoring.

## Acceptance and verification

Use synthetic credentials and isolated test nodes only:
- Store z.ai and another API-key provider in one Pi profile; remove one without affecting the other.
- Create two profiles for the same provider and prove execution uses the selected profile's credential.
- A missing provider or revoked profile never reads ambient/node credentials.
- Provider metadata, status, logs, and API responses never expose credentials.
- Scoped and automation selections resolve correctly; existing Claude/ChatGPT and pool tests remain passing.
- Browser journey creates both profile layouts and exercises provider authentication and removal.
