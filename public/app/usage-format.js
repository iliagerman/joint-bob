function money(amount, currency = "USD") {
  if (currency === "USD" && amount > 0 && amount < 0.00005) return "<$0.0001";
  try {
    const digits = amount > 0 && amount < 0.01 ? 4 : 2;
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: digits }).format(amount);
  } catch (error) {
    if (error instanceof RangeError) return `${amount} ${currency}`;
    throw error;
  }
}

export function formatUsageCost(totals) {
  if (!totals) return "Usage unavailable";
  if (totals.apiCostUsd === null) return `API price unavailable${totals.partial ? " · partial" : ""}`;
  return `${money(totals.apiCostUsd)}${totals.partial ? " · partial" : ""}`;
}

export function usageBadge(totals, testid) {
  const badge = document.createElement("em");
  badge.className = "usage-cost";
  if (testid) badge.dataset.testid = testid;
  badge.textContent = formatUsageCost(totals);
  badge.title = totals
    ? `API-equivalent token cost; not invoice. ${totals.pricedRequests}/${totals.requests} requests priced`
    : "Usage unavailable";
  return badge;
}

export function formatPlanPrice(price) {
  return `${money(price.amount, price.currency)}/${price.billingPeriod}`;
}
