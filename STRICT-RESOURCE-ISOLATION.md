# Runtime resource isolation

`strictResourceIsolation` defaults to `true`. Joint Bob sessions load managed and
project resources, not resources discovered from the native harness's user
configuration. Each harness implements its own loading policy.

- **Claude:** `--setting-sources project,local` excludes user skills, commands,
  hooks and enabled plugins. `--strict-mcp-config` excludes implicitly discovered
  MCP servers. Joint Bob supplies managed plugins and their MCP servers explicitly,
  preserving `plugin:<plugin>:<server>` names and plugin/project path variables.
  The merged MCP configuration is written atomically to a private runtime file,
  never placed in process arguments where configured credentials could leak.
  The CLI expands ordinary environment variables. Project `.mcp.json` entries are
  supplied only after explicit approval in the user's Claude settings, legacy
  project approval record, or provably untracked `.claude/settings.local.json`.
  Rejected and disabled servers stay disabled. Repository settings cannot grant
  approval. Local-file approval is conservatively ignored for symlinked/tracked
  files, non-Git directories, Windows, or when `/usr/bin/git` cannot prove the file
  untracked. Approve through user settings or the legacy project record instead.
  Authentication and transcript locations stay unchanged.

  With administrator `managed-mcp.json`, Claude's native exclusive enterprise
  loading replaces the strict flag. Joint Bob supplies no dynamic MCP arguments;
  managed-plugin and project MCP are subordinate to enterprise policy. Invalid or
  oversized enterprise files fail before launch rather than enabling native user
  discovery. Other administrator settings remain enforced by Claude.

  Directory-plugin `.mcp.json`, inline manifest MCP maps and manifest-referenced
  JSON files are supported. Zipped plugins, MCP bundles and `user_config` MCP
  substitutions fail explicitly in strict mode. Unpack plugins and configure
  ordinary environment variables instead. Plugin and project MCP `headersHelper`
  declarations also fail explicitly: promoting them to CLI servers would lose
  their native working directory, environment and credential-scrubbing boundary.
  Use explicit headers or an explicitly managed dynamic MCP server instead.
  Existing managed dynamic MCP helpers retain their original CLI semantics.
  Managed-agent frontmatter `mcpServers`
  also fails explicitly because the pinned CLI suppresses it under strict mode;
  move those declarations to the managed plugin MCP configuration. Nested managed
  commands and agents retain their relative directory paths.
- **Pi:** command discovery and sessions use the same resource loader. A read-only
  settings view excludes native packages, extensions, skills, prompts and themes
  before executable extensions load. This includes `~/.agents/skills`. Managed
  resources can live at any configured path. Project `.pi` settings and packages
  remain available. Native agent-directory instructions and system prompts are
  excluded; project and Joint Bob instructions remain. Workers receive the same
  policy as in-process sessions.
- **Kiro:** generated profiles contain explicit managed and project skills.
  `includeMcpJson: false` prevents implicit native MCP discovery. Managed MCP and
  the project's `.kiro/settings/mcp.json` are merged into the profile, with project
  entries winning name collisions. Native user prompt expansion is disabled.

Strict maintenance does not import native resources, replace native files with
symlinks, or rewrite Pi's native settings. Generated Joint Bob runtime files are
still written. Resources already imported into Joint Bob's managed directory
remain managed; enabling isolation does not delete or undo earlier imports.

This controls automatic resource loading, not OS file access. It is not a sandbox.
An agent with file tools can still read accessible files, and previously loaded
instructions can remain in a resumed transcript. Start a new conversation when
changing policy. Managed Pi package declarations are refreshed on session open;
existing Pi sessions can reload skill changes.

## Signing in to Claude MCP servers

Claude keeps an MCP server's OAuth token under a key made from the server's name
and its type, URL and headers, in the config folder of the account that signed in.
A token saved by a native terminal `claude` is found here only when the managed copy
of the plugin matches the native one exactly. Plugins often put their version in a
header, such as Figma's `X-Figma-Plugin-Bundle`, so an older managed copy looks for a
different key and reports "needs authentication".

Settings → Resources → MCP → **Check Claude sign-ins** shows each Claude HTTP/SSE
server's state, and **Sign in** runs the CLI's own flow (`mcp_authenticate`) in a
control-only Claude process (`spawnClaudeControl`). That process loads the same
plugins, MCP configuration, account and config folder as a turn. The token therefore
lands where the next turn looks, with no terminal and no copied plugin. A browser
on the node completes the sign-in through the CLI's localhost listener. A browser
elsewhere ends on a page that won't load; pasting that address hands it to the
waiting flow (`mcp_oauth_callback_url`). **Sign out** calls `mcp_clear_auth`.

Sign-in runs as the account a turn would run as: the viewed project's account, or
the person's own account in multi-user mode. Each person's tokens stay in their own
Claude config. Projects received from a cluster run as the cluster's account, so a
sign-in there is shared by everyone working in that cluster's projects on this node.
Only the person who started a sign-in can finish or cancel it, and an abandoned one
closes after 10 minutes.

## Configuration

The node settings API accepts a boolean `strictResourceIsolation` alongside its
normal settings payload. Setting it to `false` restores legacy native discovery
and native import/link maintenance. There is no UI toggle yet.

## Verification

```sh
npm run test:file -- test/strict-resource-isolation.test.ts test/claude-service-tools.test.ts test/commands-api.test.ts test/harness-resources.test.ts
npm run typecheck
npm run build
```

Claude behavior was checked against the installed, repository-pinned CLI 2.1.239,
including plugin MCP names/expansion, approval gates, strict-mode agent suppression
and enterprise exclusive loading. A separately installed global CLI is not the
compatibility reference.

Focused fix coverage:

```sh
npm run test:file -- test/strict-resource-isolation.test.ts test/agent-resources.test.ts test/resource-inventory.test.ts test/claude-isolation-mcp.test.ts
npm run typecheck
```

Tests use disposable HOME/data directories. They exercise actual Pi resource
loading and reload, extension side effects, generated Kiro profiles, prompt
expansion, settings validation, native-file preservation, and Claude spawn
arguments with a synthetic executable. They do not make authenticated model calls.
