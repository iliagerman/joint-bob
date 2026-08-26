# Automatic engine detection and synchronization requirements

## Intent

Joint Bob must configure Pi, Claude, and Syncthing without requiring users to find executable, configuration, session, API endpoint, or API key paths.

## Requirements

1. Blank stored engine overrides resolve to effective node-local defaults:
   - Pi executable: `pi`
   - Pi config: `~/.pi/agent`
   - Pi sessions: `~/.pi/agent/sessions`
   - Claude executable: `claude`
   - Claude config: `~/.claude`
   - Claude sessions: `~/.claude/projects`
2. The Engines settings panel shows the effective paths and explains that they are automatically detected; advanced overrides remain optional.
3. Syncthing remains checksum-installed, started as a native user service, and discovered from its node-local config during installation/startup.
4. Normal Settings UI does not ask users for the Syncthing endpoint or API key.
5. Joint Bob automatically registers stable Syncthing folders for `~/.pi` and `~/.claude` and shares them with every paired node.
6. Existing `dot-pi` and `dot-claude` folder registrations are adopted rather than replaced.
7. Engine authentication and machine credentials never synchronize. Managed ignores include Pi authentication/model credential files and Claude credentials, credential-bearing settings, MCP authentication, OAuth locks, and daemon control keys.
8. Pi and Claude session files and shareable non-secret configuration synchronize, allowing session discovery through existing cross-node project path aliases.
9. User-authored Syncthing ignore rules remain preserved after reconciliation.
10. Failures are visible in service logs and retried automatically; users do not configure Syncthing manually.
