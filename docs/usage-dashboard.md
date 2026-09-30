# Usage dashboard

Open **Costs** from the application header or with the configurable default shortcut **Ctrl+Alt+Shift+C**. The dashboard reports token usage and API-equivalent cost for the projects and conversations visible to the signed-in user. API-equivalent cost is an estimate of the corresponding metered API request; it does not allocate or amortize subscription plan fees.

Existing conversation labels and recorded difficulty classifications can filter and group usage. Native costs reported by Pi are retained exactly. Where no native cost exists, Joint Bob uses the catalog snapshot captured with the request. Catalog prices describe the catalog available at capture time and are not an invoice.

Saved ledger totals appear immediately. Transcript discovery then runs in the background; the dashboard polls only while it is open and a refresh is active. Refresh requests are accepted without waiting for a scan. Coverage includes imported native transcripts and replicated ledger events. Historical backfill may be partial, copied fork records are excluded, and Kiro sessions whose token details are unavailable remain explicitly unknown rather than being estimated. Draft sessions are not treated as missing usage.

Subscription prices are grouped by the actual harness you select, not inferred from provider identity. Multiple account plans can belong to one harness. Older provider-only records remain under **Unassigned — choose a harness** until you edit them; they are never assigned automatically.

Conversation costs are paged 20 at a time and ordered by known cost, then stable conversation ID. Charts show only positive known API-equivalent cost: the eight largest projects, five largest models, and populated days from the last 30 days. Remaining known cost is preserved as Other. Missing and unpriced usage is labeled and is never drawn as zero.

Claude may report its login method and subscription type through its own local `auth status --json` command. Joint Bob keeps only those two bounded fields; account identities and raw command output are discarded. This reported plan is not a billed price. Pi, Kiro, and harnesses without a safe plan/price status interface are shown as unsupported. Detection never reads credential files, signs in, persists a plan, infers a fee, or reports quota.

Subscription prices and quota windows are manual records only. Joint Bob does not claim to query, refresh, or automate provider quotas. The timestamp shown for a quota is when that manual snapshot was changed; editing only a plan price does not refresh it. Subscription setup loads and saves independently of usage estimates, so it remains available if usage refresh is slow or unavailable.
