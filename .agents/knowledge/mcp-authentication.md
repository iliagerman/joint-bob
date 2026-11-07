# mcp-authentication

MCP sign-in ownership and agent access.

## r-c7b24

Keep MCP login credentials local to the user and execution node. Sharing a server definition must not sync its login credentials to other machines.

Evidence: User explicitly said "teh login fo mcps should remain node specific" while authorizing removal of the broken shared Figma definition · Added 2026-11-05

## r-5af91

Support MCP access for Pi and Kiro through either a supported shared login on the same node or their own node-local sign-ins; a connected Claude-only plugin is not proof that the other agents have access.

Evidence: User requested "allow pi/kiro either share the login or create their own" · Added 2026-11-05
