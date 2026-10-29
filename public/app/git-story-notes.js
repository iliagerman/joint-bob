import { h } from "./git-story-dom.js";

// The same story as a plain document, for reading and reviewing next to the animated walkthrough.
const section = (title, ...body) => h("section", { class: "gsn-section" }, h("h2", {}, title), body);
const code = (text) => h("code", {}, text);
const files = (paths) => paths.length ? h("span", { class: "gsn-files" }, paths.map(code)) : null;

export function storyNotes(story, facts) {
  const { overview, diagram, timeline, examples, implementation } = story;
  return h("article", { class: "gsn" },
    section("Overview", h("p", {}, h("b", {}, "What changed. "), overview.what), h("p", {}, h("b", {}, "Why. "), overview.why),
      h("ul", {}, overview.notice.map((text) => h("li", {}, text))), overview.unchanged ? h("p", { class: "gsn-muted" }, overview.unchanged) : null),
    section("Design: how it flows", h("table", {}, h("thead", {}, h("tr", {}, ["Step", "Lane", "Kind", "What it does", "Files"].map((name) => h("th", {}, name)))),
      h("tbody", {}, diagram.nodes.map((node) => h("tr", {}, h("td", {}, h("b", {}, node.label)), h("td", {}, diagram.lanes.find((lane) => lane.id === node.lane).label), h("td", {}, node.kind), h("td", {}, node.text), h("td", {}, files(node.files))))))),
    section("Design decisions", implementation.decisions.length ? implementation.decisions.map((decision) => h("div", { class: "gsn-card" }, h("b", {}, decision.title), h("p", {}, decision.why), h("p", { class: "gsn-muted" }, `Instead: ${decision.instead}`))) : h("p", { class: "gsn-muted" }, "No design decisions were recorded.")),
    section("How the conversation got here", h("ol", {}, timeline.filter((phase) => !phase.quiet).map((phase) => h("li", {}, h("b", {}, phase.title), ` (turn${phase.turns.length > 1 ? "s" : ""} ${phase.turns.join(", ")}) `, phase.did.join(" "), phase.pivot ? h("p", { class: "gsn-muted" }, `Change of course: ${phase.pivot}`) : null)))),
    section("Behaviour: worked examples", examples.map((example) => h("div", { class: "gsn-card" }, h("b", {}, `${example.kind}: ${example.title}`), h("p", { class: "gsn-muted" }, example.start),
      h("ol", {}, example.steps.map((step) => h("li", {}, step.you ? `You: ${step.you} ` : "", `App: ${step.app}`, step.says ? ` On screen: “${step.says}”` : ""))), h("p", {}, h("b", {}, "Result. "), example.result)))),
    section("Technical notes: files", h("table", {}, h("thead", {}, h("tr", {}, ["File", "Change", "Lines", "Notes"].map((name) => h("th", {}, name)))),
      h("tbody", {}, facts.files.map((file) => h("tr", {}, h("td", {}, code(file.path)), h("td", {}, file.kind), h("td", {}, `+${file.add} −${file.del}`), h("td", {}, implementation.what[file.path] ?? "")))))),
    section("Review checklist", implementation.checks.length ? h("ul", {}, implementation.checks.map((check) => h("li", {}, h("b", {}, `${check.priority}: `), check.text, " ", check.file ? code(check.file) : null))) : h("p", { class: "gsn-muted" }, "Nothing was flagged.")),
    section("Tests", implementation.tests.length ? h("ul", {}, implementation.tests.map((test) => h("li", {}, code(test.file), ` ${test.name}`))) : h("p", { class: "gsn-muted" }, "No tests are named.")));
}
