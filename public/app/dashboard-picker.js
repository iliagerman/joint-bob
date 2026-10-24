/**
 * What the dashboard picker lists for one entity: every saved dashboard, the ones shared from
 * other nodes, and this node's unsaved drafts, so none of them can become unreachable. A single
 * dashboard that is already on show needs no picker.
 */
export function pickerEntries(dashboards, currentId) {
  if (dashboards.length === 1 && dashboards[0].id === currentId) return [];
  return dashboards.map((dashboard) => {
    if (!dashboard.saved) return { id: dashboard.id, label: "New dashboard · draft" };
    const notes = [dashboard.active ? "in use" : "", dashboard.origin === "received" ? "shared with you" : ""].filter(Boolean);
    return { id: dashboard.id, label: [dashboard.title || "Untitled", ...notes].join(" · ") };
  });
}
