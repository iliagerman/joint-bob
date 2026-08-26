# Prioritized intent backlog

## Prioritization method

All approved capabilities are Must Have because the confirmed scope requires one coherent release. Ordering therefore uses risk reduction and dependency unblocking rather than dropping capabilities. Relative WSJF inputs use a 1, 2, 3, 5, 8 scale. [Q1] [Q2] [Q4]

## Backlog

| Rank | ID | Proto-Unit | Priority | Value | Time criticality | Risk reduction | Size | WSJF | Depends on | Source |
|---:|---|---|---|---:|---:|---:|---:|---:|---|---|
| 1 | PW-01 | Trustworthy project mapping and synchronization readiness | Must Have | 8 | 5 | 8 | 3 | 7.0 | None | [intent] [Q2] [Q3] |
| 2 | PW-02 | Destination-local ticket workspace and conversation resolution | Must Have | 8 | 5 | 8 | 3 | 7.0 | PW-01 | [intent] [Q3] |
| 3 | PW-03 | Fail-closed ticket handoff shared by Runs on and Continue on | Must Have | 8 | 5 | 8 | 5 | 4.2 | PW-01, PW-02 | [intent] [Q2] [Q3] |
| 4 | PW-04 | Managed project group move with path preservation | Must Have | 5 | 3 | 5 | 3 | 4.3 | PW-01 | [intent] [Q2] |
| 5 | PW-05 | Move + symlink import default with all choices retained | Must Have | 5 | 3 | 2 | 2 | 5.0 | None | [intent] [Q2] |
| 6 | PW-06 | Project readiness and active-agent UI labels | Must Have | 5 | 3 | 3 | 2 | 5.5 | PW-01 | [intent] [Q2] |
| 7 | PW-07 | Automated coverage and real two-node ticket round trip | Must Have | 8 | 5 | 8 | 3 | 7.0 | PW-01 through PW-06 | [Q7] |

## Proto-Unit outcomes

### PW-01 Trustworthy project mapping and synchronization readiness

A destination is eligible only when it is online, mapped to the managed project, and synchronized. The operator sees the current readiness state and exact blocking reason. [intent] [Q3]

### PW-02 Destination-local ticket context

The destination resolves its own ticket workspace and existing conversation instead of relying on absolute paths copied from another node. [intent] [Q3]

### PW-03 Portable ticket conversation handoff

**Runs on** and **Continue on** invoke the same safe handoff. Success changes ownership and opens the same ticket conversation on the destination. Failure changes nothing and returns the exact reason. [intent] [Q2] [Q6]

### PW-04 Managed project group move

Changing a project's group moves its managed directory to the destination group and keeps the managed project usable. [intent] [Q2]

### PW-05 Import default

New imports initially select **Move + symlink**. Existing import choices remain available. [intent] [Q2]

### PW-06 Readiness and active-agent visibility

Project views expose synchronization readiness, and every session identifies its active agent. [intent] [Q2]

### PW-07 Validation

Automated checks cover success and fail-closed paths. A real ticket then moves MacBook Pro to Homeserver and back with ownership, workspace, and conversation preserved. [Q7]

## Deferred backlog

| Item | Disposition | Source |
|---|---|---|
| Queue handoffs for later execution | Won't Have | [Q6] |
| Force handoff to an unready destination | Won't Have | [Q6] |
| Re-pair healthy nodes during this initiative | Won't Have | [Q6] |
| Deploy or deliver through Git without authorization | Won't Have | [Q6] |

## Sources

- [intent] `../intent-capture/intent-statement.md`
- [Q1]-[Q7] `scope-definition-questions.md`
