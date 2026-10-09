const PROJECT_COLORS = ["slate", "teal", "blue", "violet", "magenta", "amber", "green", "red"];
function isHarnessId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value);
}
export {
  PROJECT_COLORS,
  isHarnessId
};
