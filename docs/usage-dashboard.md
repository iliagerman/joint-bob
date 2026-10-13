# Usage dashboard

Open **Costs** from the application header or with the configurable default shortcut **Ctrl+Alt+Shift+C**. The dashboard reports token usage and API-equivalent cost for the projects and conversations visible to the signed-in user. API-equivalent cost is an estimate of the corresponding metered API request; it does not allocate or amortize subscription plan fees.

Existing conversation labels and recorded difficulty classifications can filter and group usage. Native costs reported by Pi are retained exactly. Where no native cost exists, Joint Bob uses the catalog snapshot captured with the request. Catalog prices describe the catalog available at capture time and are not an invoice.

Saved ledger totals appear immediately. The dashboard reads its parts separately (`GET /api/usage?sections=summary`, then the grouping on screen, the daily trend, and the other groupings), so totals show as soon as they are read and each grouping fills in when it arrives; a grouping that fails says so without blanking the rest. Transcript discovery then runs in the background. While it runs, the open dashboard polls only `GET /api/usage/status`, which is cheap, and re-reads usage when the refresh ends or, at most every 15 seconds, when saved usage has changed. Refresh requests are accepted without waiting for a scan. Coverage includes imported native transcripts and replicated ledger events. Historical backfill may be partial, copied fork records are excluded, and Kiro sessions whose token details are unavailable remain explicitly unknown rather than being estimated. Draft sessions are not treated as missing usage.

Subscription prices are grouped by the actual harness you select, not inferred from provider identity. Multiple account plans can belong to one harness. Older provider-only records remain under **Unassigned — choose a harness** until you edit them; they are never assigned automatically.

Conversation costs are paged 20 at a time and ordered by known cost, then stable conversation ID. Charts show only positive known API-equivalent cost: the eight largest projects, five largest models, and populated days from the last 30 days. Remaining known cost is preserved as Other. Missing and unpriced usage is labeled and is never drawn as zero.

## Skills & time

The **Skills & time** tab uses the same filters and answers two questions: which skills do agents load and what do those turns look like, and when and how long do turns run.

A skill counts as used when an agent loads it: a successful read of its `SKILL.md`, Claude's Skill tool, or a `/skill:name` command. Each skill is one row, whichever folder or node it was loaded from. A row shows its turns and conversations, the cost of those turns in total and per turn, the share of tool calls that failed, the median turn time, and when it was last used. Selecting a row shows which models ran it. A turn that loads several skills is counted under each of them, so rows overlap and do not add up.

The totals above the list compare turns that loaded a skill with the rest of the period. The cards under them say what stands out: the most used skill, and a skill whose turns fail, run or cost clearly more than turns with any skill (at least five turns; one and a half times the comparison for failures and cost, twice for time). These are observations; they do not show that a skill caused anything.

**Not used** lists the skills installed on this node that no agent loaded in the period and scope. Kiro sessions and skills that exist only on another node are not covered. **Days** joins cost and requests with turns, failed turns, and the median turn, queue and tool-call time for each day. **Hours of day** adds the period up by local hour. Both need a period of 151 days or less, and turn times cannot be filtered by model, provider, label or difficulty. **Cluster**, shown on a node that is in one, reports the projects explicitly shared with the cluster chosen in the filter. **Repeated work** looks for repeated conversation titles in one project and drafts a skill or script for you to review; it reads saved titles, turn times and usage only, and installs nothing without approval.

Lists fit the window and page instead of scrolling. Each report is read separately, so one that fails says so and leaves the others in place.

Skills Claude loads through its Skill tool are counted from this version on. Each Claude transcript is read once more in the background to find them, so earlier Claude use fills in after the first refresh.

Claude may report its login method and subscription type through its own local `auth status --json` command. Joint Bob keeps only those two bounded fields; account identities and raw command output are discarded. This reported plan is not a billed price. Pi, Kiro, and harnesses without a safe plan/price status interface are shown as unsupported. Detection never reads credential files, signs in, persists a plan, infers a fee, or reports quota.

Subscription prices and quota windows are manual records only. Joint Bob does not claim to query, refresh, or automate provider quotas. The timestamp shown for a quota is when that manual snapshot was changed; editing only a plan price does not refresh it. Subscription setup loads and saves independently of usage estimates, so it remains available if usage refresh is slow or unavailable.
