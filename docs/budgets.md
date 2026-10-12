# Spend budgets

A cluster's manager can cap spending for everything shared into the cluster. Open **Settings → Cluster**, pick the cluster and choose **Budget**.

- **Whole cluster:** one limit per period (hour, day, week, month, year, total) for all projects shared into the cluster, added up across every node.
- **Defaults:** a limit applied to each workspace, each project and each conversation in the cluster.
- **Owner limits:** the owner of a project, a conversation or (on the admin) a workspace can add limits of their own through `/api/budgets/limits`. A turn starts only when every applicable budget still has room, so an owner limit can only tighten the cluster's.
- **Delivery:** the manager's budget is pushed to every member and again to anyone who joins; the tab lists members that have not confirmed it. A member that is offline enforces the previous budget until it hears the new one. Management passing to another node keeps the budget.
- **Periods:** calendar periods in the manager's timezone, so every node resets together. A total never resets.

## What a budget counts

Spend is the ledger's API-equivalent price (see [usage-dashboard.md](usage-dashboard.md)), not an invoice, so subscription usage counts at list price. Requests with no known price add nothing, and Kiro records no cost, so it is not counted. Image descriptions and classifier calls are not in the ledger and are not counted.

## What happens at the limit

- A turn, goal turn, compaction, ticket run or internal review that would start is refused with the reason ("Budget reached: the daily limit of $20.00 for project X is used up…") and the time the period resets. Queued prompts stay queued.
- A turn already running is stopped within about a minute; the reason is recorded in the conversation.
- A scheduled task whose run is refused is recorded as failed and stays enabled.
- A warning shows at 80% (`GET /api/budgets/status`).
- If the budget check itself breaks, the turn is allowed and a warning is logged.

## Limits of the design

Each node enforces on its own copy, so this is a guard rail rather than a security boundary: a modified node ignores it. A budget can be overshot by one model request per running conversation plus spend by other nodes that has not replicated yet. A workspace total counts only the projects this node holds.
