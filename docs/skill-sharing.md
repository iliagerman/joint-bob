# Selective skill sharing

Open **Resources → Skills**, expand **Share** on a locally managed skill, select the clusters whose member machines should receive it, and choose **Save sharing**. New and existing managed skills are local-only until clusters are selected. Import native or project skills first; Joint Bob never deletes arbitrary native paths.

A grant distributes the complete skill directory, including scripts and modes, to each current member machine. This is file distribution, not a sandbox: all agents and work on that receiving machine may read the files. Received skills cannot be reshared. Name conflicts are preserved and reported rather than overwritten.

Removing a local managed skill asks for confirmation, revokes its grants, moves its folder to a backup outside discovery, and prevents reconciliation from importing that name again. Explicitly importing it clears that suppression. Reload updates idle Pi sessions; start a new conversation to ensure previously read instructions are forgotten.

When a shared skill changes on its owner (a folder import, **Sync local skills**, or a git repository update), the owner tells each receiver to fetch it at once. Receivers also check every online owner every 30 seconds, so a skill edited by hand reaches them on that pass.

Revocation is authoritative only after a receiver next contacts an online owner. An offline error is shown and the receiver retains its last verified copy. Copies made outside Joint Bob, including copies distributed by older releases, cannot be remotely erased.

## Git repositories

**Resources → Git repos** adds a repository by URL (`https://`, `ssh://`, `git@host:path`, `file://`, or GitHub's `owner/repo`) and an optional branch or tag. Joint Bob clones it into the node's data folder and lists what it finds:

- **Skills**: every folder with a `SKILL.md`, including `.claude/skills` and skills inside plugins.
- **Plugins**: folders with `.claude-plugin/plugin.json`, and local entries of a `.claude-plugin/marketplace.json`. Claude loads them.
- **MCP servers**: each server in a `.mcp.json` or `mcp.json` outside a plugin. Claude and Kiro load them. A command written relative to its file runs from the clone.

Tick some or all of them and choose **Apply selection**. Unticking an item removes it again. A copy edited on this node is kept, both when you untick it and when an update finds it unchanged upstream. **Check** asks the remote for the ref's newest commit without installing anything; **Update** fetches it and installs the ticked items again. Remotes are checked every six hours, and **Auto-update** installs new commits as soon as a check finds them. Credentials never go in the URL: git uses the node's own credential helpers and SSH keys. The repository's own hooks, filters and submodules never run.

**Share…** on a repository picks the machines that run it too. Each of them clones the same repository at this node's commit and installs the same items, so each needs its own access to the repository. After every update, change of selection or change of machines, this node pushes the new state, and each machine follows. A machine that was away asks for it when it starts. When a machine is unticked, or the repository is removed, it removes what it installed. Skills it received this way are the owner's, and cannot be reshared from there.

## Upgrade note

The legacy `joint-bob-agent-resources` Syncthing folder is paused before selective publishing. It formerly copied skills, prompts, plugins, and MCP configuration as one blanket folder. Local files remain intact, and already-created unmanaged remote copies are not revoked. Selective sharing covers skills, and git repositories with their skills, plugins and MCP servers.
