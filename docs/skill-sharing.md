# Selective skill sharing

Open **Resources → Skills**, expand **Share** on a locally managed skill, select the clusters whose member machines should receive it, and choose **Save sharing**. New and existing managed skills are local-only until clusters are selected. Import native or project skills first; Joint Bob never deletes arbitrary native paths.

A grant distributes the complete skill directory, including scripts and modes, to each current member machine. This is file distribution, not a sandbox: all agents and work on that receiving machine may read the files. Received skills cannot be reshared. Name conflicts are preserved and reported rather than overwritten.

Removing a local managed skill asks for confirmation, revokes its grants, moves its folder to a backup outside discovery, and prevents reconciliation from importing that name again. Explicitly importing it clears that suppression. Reload updates idle Pi sessions; start a new conversation to ensure previously read instructions are forgotten.

Revocation is authoritative only after a receiver next contacts an online owner. An offline error is shown and the receiver retains its last verified copy. Copies made outside Joint Bob, including copies distributed by older releases, cannot be remotely erased.

## Upgrade note

The legacy `joint-bob-agent-resources` Syncthing folder is paused before selective publishing. It formerly copied skills, prompts, plugins, and MCP configuration as one blanket folder. Local files remain intact, and already-created unmanaged remote copies are not revoked. Selective sharing currently covers skills only.
