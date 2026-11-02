// Runs synchronously before first paint, so the shell is never painted in the wrong theme.
// The OS setting paints first; appearance.js applies this device's saved theme behind the boot screen.
const theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
const parameters = new URLSearchParams(location.search);
if (parameters.has("byTheWayToken")) document.documentElement.classList.add("by-the-way-pane");
if (parameters.get("assistantAutomation") === "1" && ["cron", "webhook"].includes(parameters.get("assistantAction"))) document.documentElement.classList.add("assistant-automation");
document.documentElement.dataset.theme = theme;
document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#0d0e10" : "#f2f2f0";
