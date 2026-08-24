// Runs synchronously before first paint, so the shell is never painted in the wrong theme.
// Preferences live on the server, so the OS setting is the only thing knowable this early;
// app.js re-applies the signed-in choice behind the boot screen once it loads.
const theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
document.documentElement.dataset.theme = theme;
document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#0d0e10" : "#f2f2f0";
