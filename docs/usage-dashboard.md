# Usage dashboard

Open **Usage** from the application header. The dashboard reports token usage and API-equivalent cost for the projects and conversations visible to the signed-in user. API-equivalent cost is an estimate of the corresponding metered API request; it does not allocate or amortize subscription plan fees.

Existing conversation labels and recorded difficulty classifications can filter and group usage. Native costs reported by Pi are retained exactly. Where no native cost exists, Joint Bob uses the catalog snapshot captured with the request. Catalog prices describe the catalog available at capture time and are not an invoice.

Coverage includes imported native transcripts and replicated ledger events. Historical backfill may be partial, copied fork records are excluded, and Kiro sessions whose token details are unavailable remain explicitly unknown rather than being estimated. Draft sessions are not treated as missing usage.

Subscription prices and quota windows are manual records only. Joint Bob does not claim to query, refresh, or automate provider quotas. The timestamp shown for a quota is when that manual snapshot was changed; editing only a plan price does not refresh it.
