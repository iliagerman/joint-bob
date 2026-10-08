function decide(baseline, workspace, project, options) {
  const paths = /* @__PURE__ */ new Set([...baseline.keys(), ...workspace.keys(), ...project.keys()]);
  const decisions = [];
  for (const path of paths) {
    const base = baseline.get(path);
    const work = workspace.get(path);
    const proj = project.get(path);
    if (work?.symlink || proj?.symlink || base?.symlink) {
      decisions.push({ kind: "unmergeable", path, reason: "symlink" });
      continue;
    }
    if (!base) {
      if (work && proj) {
        if (work.sha256 === proj.sha256 && work.mode === proj.mode) decisions.push({ kind: "skip", path });
        else if (work.sha256 === proj.sha256) decisions.push({ kind: "choice", path, reason: "mode-conflict" });
        else decisions.push({ kind: "choice", path, reason: "both-created" });
      } else if (work) decisions.push(options.legacy ? { kind: "choice", path, reason: "no-baseline" } : { kind: "apply", path });
      else decisions.push({ kind: "skip", path });
      continue;
    }
    if (!work) {
      if (!proj) decisions.push({ kind: "skip", path });
      else if (proj.sha256 === base.sha256 && proj.mode === base.mode) decisions.push({ kind: "delete", path });
      else decisions.push({ kind: "choice", path, reason: "edit-vs-delete" });
      continue;
    }
    if (!proj) {
      if (work.sha256 === base.sha256 && work.mode === base.mode) decisions.push({ kind: "skip", path });
      else decisions.push({ kind: "choice", path, reason: "delete-vs-edit" });
      continue;
    }
    const workChanged = work.sha256 !== base.sha256 || work.mode !== base.mode;
    const projChanged = proj.sha256 !== base.sha256 || proj.mode !== base.mode;
    if (!workChanged && !projChanged) decisions.push({ kind: "skip", path });
    else if (workChanged && !projChanged) decisions.push({ kind: "apply", path });
    else if (!workChanged && projChanged) decisions.push({ kind: "keep-project", path });
    else if (work.sha256 === proj.sha256 && work.mode === proj.mode) decisions.push({ kind: "skip", path });
    else if (work.mode !== proj.mode) decisions.push({ kind: "choice", path, reason: "mode-conflict" });
    else if (work.sha256 === base.sha256 && proj.sha256 === base.sha256) decisions.push({ kind: "choice", path, reason: "both-binary" });
    else if (options.textMergeable.has(path)) decisions.push({ kind: "text", path });
    else decisions.push({ kind: "choice", path, reason: "both-binary" });
  }
  decisions.sort((left, right) => left.path.localeCompare(right.path));
  return decisions;
}
export {
  decide
};
