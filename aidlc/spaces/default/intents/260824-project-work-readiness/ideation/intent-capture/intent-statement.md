# Intent Statement

## Problem Statement

Joint Bob must remove uncertainty around when synchronized projects and ticket workspaces are safe to use while also making managed project imports and organization easier to maintain. [Q1] [Q4]

Ticket conversations currently break the expected multi-node workflow because their node controls are unavailable even when the ticket workspace and conversation have synchronized. Ticket conversations must move as one unit with ticket ownership and workspace state. [Q7]

## Target Customer

The target users are operators managing projects across one or more Joint Bob nodes, including both single-operator and multi-operator workflows. They need readiness, ownership, project organization, and active-agent state to be visible before acting. [Q2]

## Success Metrics

- Every project visibly reports whether synchronization is complete. [Q3]
- A managed project can change groups without losing files or breaking its managed path. [Q3]
- Every session visibly identifies its active agent. [Q3]
- New imports default to Move + symlink while retaining all three import choices. [Q3]
- Ticket conversations expose both **Runs on** and **Continue on**; either action moves ticket ownership, the synchronized workspace, and the same conversation together. [Q7]
- A ticket stays on its current node when the destination is offline, unmapped, or unsynchronized, and the UI shows the exact blocking reason. [Q8]

## Initiative Trigger

The current UI does not expose enough synchronization state for an operator to know whether starting work is safe. [Q4]

## Initial Scope Signal

The workflow-selected scope is `project-work-readiness`. [scope]

The confirmed product boundary includes all requested import, project-group, synchronization, session-agent, and portable ticket-conversation outcomes in one change. [Q6] [Q7]

## Assumptions & Open Questions

None.

## Review

NOT-READY

1. **Critical — Problem Statement:** The claim that ticket conversations currently fail because node controls remain unavailable after synchronization is not established by [Q7] or any registered source. Remove it, label and confirm it as an assumption, or obtain a direct answer supporting it.
2. **Major — Stakeholder grounding:** `stakeholder-map.md` attributes project-organization and active-agent interests to operators using only [Q2], but that answer establishes user types, not those interests. Cite confirmed answers that support each interest or elicit them explicitly.
3. **Major — Influencer grounding:** `stakeholder-map.md` states that no additional influencers were identified, while [Q5] confirms only the decision-maker and communication approach. Record an explicit influencer answer or mark this as an open question.
