# Security Test Instructions — Scoped Secrets

The Minimal test strategy generates no security suite by default. This change is an exception
the stage explicitly allows: it rewrites the credential model of the product, so security is
the subject matter, not a cross-cutting concern.

## Threat model for this change (STRIDE, scoped to the credential path)

| Threat | Concrete question for this change | Control in the code |
|---|---|---|
| **Information disclosure** | Can a secret value reach the browser? | `publicAccount` (`src/secrets.ts:138`) projects each account to `{ id, label, provider, replicate, variables: [{ name, kind, configured }] }`. No code path serialises a decrypted value to an HTTP response. |
| **Information disclosure** | Can a secret leave the node unintentionally? | Replication reads only `WHERE replicate = 1` (`src/secret-replication.ts:96`); accounts with `replicate = 0` are actively removed from the outbox (line 91). Node-local is the default for new accounts. |
| **Tampering** | Can a peer inject an account this node did not ask for? | The peer link is `Authorization: Bearer <peer token>` behind `requireHttpAuth` + `requireCsrf`; a received account is re-encrypted with the receiving node's own key before storage (line 150), and a local overwrite wins afterwards. |
| **Spoofing** | Can `gh` and `git push` end up as different identities? | This was a real defect before the change. One resolved `GH_TOKEN` now fans out to `GITHUB_TOKEN`, `PI_GITHUB_TOKEN` and the `GIT_ASKPASS` helper from a single value (`src/secrets.ts:294-301`), so divergence is no longer expressible. |
| **Elevation of privilege** | Can a lower scope read a higher scope's secret? | Not a threat in this product: it is single-user with no tenant or role model (constraint C7). Scoping is an ergonomics feature, not an authorization boundary — do not test it as one. |
| **Repudiation** | Is credential movement auditable? | Replication writes events, deliveries and inbox rows, so a credential's journey between nodes is reconstructible. |

## Checks performed on this change

| Check | Method | Result |
|---|---|---|
| No secret value in an HTTP response | Read every projection in `src/secrets.ts`; `publicAccount` is the only shape returned | **Pass** — names and kinds only |
| Node-local accounts never enqueued | `src/secret-replication.ts` outbox query is gated on `replicate = 1` | **Pass** |
| Received material re-encrypted locally | `encryptSecretValue` on the receive path | **Pass** |
| No hardcoded credential in source or tests | Fixtures use `ghp_test_alpha` / `ghp_test_beta` | **Pass** |
| Encryption unchanged | AES-256-GCM with the node key; no new crypto introduced | **Pass** |
| File-kind secret material permissions | `0600` inside a `0700` directory, unchanged | **Pass** |
| Dependency vulnerability scan | `npm audit --omit=dev` | **Could not run** — see below |

## The one check that could not run

`npm audit` fails in this environment:

```
npm warn audit 400 Bad Request - POST http://100.83.230.57:4873/-/npm/v1/security/audits/quick
npm error audit endpoint returned an error
```

The repository resolves packages through a private registry that does not implement the audit
endpoint. This is an environment limitation, not a finding about this change — which adds no
dependency. Run dependency scanning against the public registry, or with a separate SCA tool,
as a standing practice rather than as a gate on this change.

## Manual security verification before trusting this on a real cluster

1. Open the browser devtools network tab, load the secrets settings, and confirm no response
   body contains a token.
2. Mark an account node-local, trigger a sync, and confirm nothing about it appears in the
   outbox or on the peer.
3. Upgrade a node that holds real credential groups **after backing up
   `~/.joint-bob/node.db`**, then confirm each project still pushes as the identity it used
   before.
4. Confirm the old `github-auth.json` legacy path and any leftover `secret-files/` entries for
   deleted accounts are cleaned up as expected.
