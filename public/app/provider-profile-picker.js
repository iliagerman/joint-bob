/** Automation-only, node-local profile selection. Never silently drop a saved assignment. */
export function createAutomationProfilePicker(anchor, testId, load) {
  const label = document.createElement("label");
  label.textContent = "Run with profile";
  const select = document.createElement("select");
  select.name = "providerProfileId";
  select.dataset.testid = testId;
  label.append(select);
  anchor.after(label);
  let revision = 0, failure = null;
  function options(profiles, selected) {
    select.replaceChildren(new Option("Use my current profile", ""), ...profiles.map(profile => new Option(`${profile.label}${profile.shared ? " (shared)" : ""}`, profile.id)));
    if (selected && !profiles.some(profile => profile.id === selected)) select.add(new Option("Unavailable profile — choose another", selected));
    select.value = selected || "";
  }
  options([], null);
  return {
    async refresh(selected = null) {
      const current = ++revision;
      failure = null; select.disabled = true; options([], selected);
      try {
        const body = await load();
        if (current !== revision) return;
        options(body.profiles, selected);
      } catch (error) {
        if (current !== revision) return;
        failure = error;
      } finally {
        if (current === revision) { select.disabled = false; }
      }
    },
    value() {
      if (failure) throw new Error("Provider profiles could not be loaded. Reopen the form to retry.");
      return select.value || null;
    },
  };
}
