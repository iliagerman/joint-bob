/**
 * What features can add to a board card without editing the board: buttons in its action row, and a decorator that
 * can add anything else to the card's element (a selection box, a badge).
 */
const actions = [];
const decorators = [];
const tools = [];

/** `run(card)` is called when the button is pressed; `visible(card)` hides the button on cards it does not suit. */
export function registerCardAction({ id, label, title = "", order = 100, visible = () => true, run }) {
  actions.push({ id, label, title, order, visible, run });
  actions.sort((a, b) => a.order - b.order);
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
export const boardTools = () => tools;
export function decorateCard(element, card) { for (const decorate of decorators) decorate(element, card); }
