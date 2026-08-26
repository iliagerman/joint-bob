# Scope Definition Questions

## Sources

- [intent] Upstream intent: `../intent-capture/intent-statement.md`
- [desc] Initial description: "Make Move + symlink the default project import mode. Let users change an existing project's group, moving its managed directory between group folders. Show each project's Syncthing status in the UI so users know when it is fully synced and safe to start work. Show which agent is active in every session."
- [scope] Workflow-selected scope: `project-work-readiness`.

## Q1. What is the minimum viable scope that delivers the approved value?

A. Deliver only ticket conversation handoff
B. Deliver only project imports and group moves
C. Deliver the full approved boundary as one release: import defaults, group moves, synchronization readiness, active-agent labels, and portable ticket conversations
D. Split the work across unrelated releases
X. Other (please specify)

[Answer]: C

## Q2. Which capabilities are required for this initiative? (select all that apply)

A. Move + symlink remains available and becomes the default import mode
B. Managed projects can change groups while their managed directories move safely
C. Project synchronization readiness and active-agent identity are visible
D. Runs on and Continue on perform fail-closed ticket handoff with the same conversation and workspace
E. All listed capabilities are must-have
X. Other (please specify)

[Answer]: E

## Q3. What dependency order should constrain delivery?

A. Readiness and node-local path resolution must work before ticket handoff can switch ownership
B. Ticket ownership should move before readiness checks
C. UI changes should ship without backend support
D. Capabilities have no dependencies
X. Other (please specify)

[Answer]: A

## Q4. Which sequencing preference should guide implementation?

A. Risk-first: establish readiness, mapping, path resolution, and fail-closed handoff before enabling controls
B. Value-first: enable controls before backend readiness
C. Visual-first: finish labels and styling before behavior
D. No sequencing preference
X. Other (please specify)

[Answer]: A

## Q5. Are there hard deadlines tied to specific capabilities?

A. No hard deadline; complete and validate the approved boundary as one coherent change
B. Ticket handoff must ship before all other capabilities
C. Project grouping must ship before all other capabilities
D. A deadline exists but is not yet specified
X. Other (please specify)

[Answer]: A

## Q6. Which behaviors are explicitly out of scope? (select all that apply)

A. Queueing ticket moves while a destination is not ready
B. Forcing ticket ownership changes when a node is offline, unmapped, or unsynchronized
C. Re-pairing healthy nodes or replacing existing synchronization infrastructure without evidence
D. Deployment, commit, or push without separate authorization
E. All listed behaviors are out of scope
X. Other (please specify)

[Answer]: E

## Q7. What validation proves the portable ticket conversation capability is complete?

A. Automated API and UI coverage only
B. A real ticket moves MacBook Pro to Homeserver and back, retaining ownership, workspace, and conversation, after automated checks pass
C. Visual inspection only
D. No end-to-end validation is required
X. Other (please specify)

[Answer]: B

## Consolidated Summary Confirmation

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
