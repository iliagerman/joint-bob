// Runs synchronously before first paint, so the shell is never painted in the wrong theme.
// The OS setting paints first; appearance.js applies this device's saved theme behind the boot screen.
const theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
if (new URLSearchParams(location.search).has("byTheWayToken")) document.documentElement.classList.add("by-the-way-pane");
document.documentElement.dataset.theme = theme;
document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#0d0e10" : "#f2f2f0";
