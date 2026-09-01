// The standalone page behind the file dialog's View link. The server embeds the file's
// text in a hidden <pre> (a page-level CSP forbids an inline script), and this renders it
// with the renderer the chat already uses, on the app's own themed surfaces. Markdown
// reads as prose; every other text file is one code block, so a fence inside the source
// is text like any other and can never break out.
import { buildCodeBlock, renderMarkdown } from "./markdown.js";

const source = document.getElementById("fileViewSource");
const body = document.getElementById("fileViewBody");
const language = source.dataset.language;

if (language === "markdown") renderMarkdown(body, source.textContent);
else body.append(buildCodeBlock(language, source.textContent));
