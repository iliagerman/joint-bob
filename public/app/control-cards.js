/**
 * What features can add to a board card without editing the board: buttons in its action row, and a decorator that
 * can add anything else to the card's element (a selection box, a badge).
 */
const actions = [];
const projectActions = [];
const decorators = [];
const tools = [];

/** `run(card)` is called when the button is pressed; `visible(card)` hides the button on cards it does not suit; `style` "primary" makes it the card's main button. */
export function registerCardAction({ id, label, title = "", order = 100, style = "", visible = () => true, run }) {
  actions.push({ id, label, title, order, style, visible, run });
  actions.sort((a, b) => a.order - b.order);
}

/** A button in a project's group header on the board; `project` is `{ projectId, projectName }`. */
export function registerProjectAction({ id, label, title = "", order = 100, visible = () => true, run }) {
  projectActions.push({ id, label, title, order, visible, run });
  projectActions.sort((a, b) => a.order - b.order);
}

/** `decorate(element, card)` runs each time a card is drawn. */
export function registerCardDecorator(decorate) { decorators.push(decorate); }

/** A button in the board's own toolbar, next to Grouped/Free and Reset. */
export function registerBoardTool({ id, label, title = "", order = 100, run }) {
  tools.push({ id, label, title, order, run });
  tools.sort((a, b) => a.order - b.order);
  window.dispatchEvent(new CustomEvent("control-board-tools-changed"));
}

export const cardActionList = (card) => actions.filter((action) => action.visible(card));
export const projectActionList = (project) => projectActions.filter((action) => action.visible(project));
export const boardTools = () => tools;
export function decorateCard(element, card) { for (const decorate of decorators) decorate(element, card); }

const SUMMARY_LABEL = /\*\*\s*(goal|done so far|current state|open questions)\s*\*\*/gi;
const BRIEF_CHARACTERS = 160;

/** Markdown out of a summary, as one line of plain text. */
export function plainSummary(summary) {
  return summary.replace(/\*\*|__|`/g, "").replace(/^\s*[-*•]\s+/gm, "").replace(/\s+/g, " ").trim();
}

/**
 * A conversation's running summary as a short status line: the first sentence of its "Current state", without Markdown.
 * A summary written without that label gives its own first sentence.
 */
export function briefStatus(summary) {
  if (!summary) return null;
  const labels = [...summary.matchAll(SUMMARY_LABEL)];
  const current = labels.findIndex((match) => match[1].toLowerCase() === "current state");
  const section = current < 0 ? summary : summary.slice(labels[current].index + labels[current][0].length, labels[current + 1]?.index);
  const text = plainSummary(section).replace(/^[—:–-]\s*/, "");
  const sentence = text.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? text;
  return sentence.length > BRIEF_CHARACTERS ? `${sentence.slice(0, BRIEF_CHARACTERS).replace(/\s+\S*$/, "")}…` : sentence;
}
