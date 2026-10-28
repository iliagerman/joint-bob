# Dashboard sharing: results and editing

## Intent

Let project users share a dashboard definition while keeping credential-backed results private. Recipients can view the shared definition, run it with their own credentials, or make an independent copy. Owners may grant selected recipients edit access so changes sync back to the owner and onward to recipients.

## Rules

- Sharing is scoped to the dashboard's project sharing eligibility. Owners can share with all current and future nodes that have access to the project, or choose nodes/clusters. Twins receive every project-shared dashboard by default, regardless of creator account.
- The owner shares dashboard definitions. A recipient's local refresh uses that node's own credentials and stores results locally. Results from dashboards that require credentials are never sent to other users or nodes.
- For dashboards that do not require credentials, refreshed results sync to recipients automatically. Recipients see the same published payload read-only; a recipient's local refresh remains local.
- Twins receive every project-shared dashboard by default. The credential rule still withholds payloads for credential-required dashboards. Credentials and secret values never travel in dashboard bundles.
- A recipient without edit permission can view, approve/run locally where applicable, and make a separate copy. A copy is independent of future owner changes.
- The owner may grant selected nodes/clusters edit permission. Authorized changes sync back to the owner, then to all recipients. Concurrent or stale edits must be rejected rather than silently overwriting a newer definition.
- Received scripts remain subject to the existing review-and-approval flow before running on the receiving node. A new owner version invalidates approval.
- Unsharing removes the received shared instance; locally made copies remain.
- Sharing permission cannot exceed access to the host project. No dashboard sync path grants project access or secrets access.

## Credential classification

The dashboard manifest gains an explicit `requiresCredentials` boolean. New or legacy definitions default to `true` unless an owner explicitly marks them `false`. A credential-required dashboard never exports payload, state, or run logs, including to twins. A no-credentials dashboard publishes its last successful payload to eligible recipients. Refresh state remains node-local so recipients do not overwrite their own script history. Only the owner refreshes publishable shared results; local recipient refreshes never flow upstream.

## Editing and conflict handling

The owner is authoritative for the live definition. Authorized recipients edit a local draft against the currently received digest. Save submits the base digest and complete validated definition to the owner. The owner accepts only if the sender is currently authorized and the base digest still matches. Accepted updates become a new owner version and fan out through existing dashboard change sync. Stale saves receive a conflict response and keep the receiver's draft for manual reconciliation.

## Out of scope

- Syncing credentials, secret account values, creator transcripts, run logs, or recipient-local refresh payloads.
- Automatic periodic refresh.
- General file-sync distribution of dashboards. Dashboard-specific sync remains the enforcement point for target permissions, result privacy, approval, and edits.
