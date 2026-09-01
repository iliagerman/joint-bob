// The standalone page behind the file dialog's View link. The server embeds the
// markdown source in a hidden <pre> (a page-level CSP forbids an inline script), and
// this renders it with the renderer the chat already uses, so a viewed document reads
// as prose in a readable column instead of raw syntax hard-wrapped by its author.
import { renderMarkdown } from "./markdown.js";

renderMarkdown(document.getElementById("fileViewBody"), document.getElementById("fileViewSource").textContent);
