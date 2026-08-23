// Tiny, dependency-free, XSS-safe Markdown renderer for chat messages.
//
// It builds DOM nodes directly (text is always assigned via textContent), so
// assistant/tool output can never inject markup or scripts. It implements a
// practical GFM-ish subset that covers what a coding agent tends to emit:
//
//   - fenced code blocks (``` / ~~~) with language label + copy button
//   - ATX headings (# .. ######)
//   - horizontal rules
//   - blockquotes (nestable)
//   - unordered / ordered lists (nestable via indentation)
//   - GFM tables
//   - paragraphs with hard line breaks
//   - inline: code spans, **bold**, *italic*, ~~strike~~, [text](url)
//
// Underscore-based emphasis is intentionally NOT supported so that identifiers
// like `my_var_name` render literally instead of being mangled.

function textNode(value) {
  return document.createTextNode(value ?? "");
}

function unescapeInline(value) {
  return value.replace(/\\([\\`*_~[\]()#>!])/g, "$1");
}

const PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function safeUrl(value) {
  const raw = (value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, location.origin);
    return PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const INLINE_RE =
  /(?<code>`+)(?<codeText>[\s\S]*?)\k<code>|(?<bold>\*\*)(?<boldText>[\s\S]+?)\*\*(?!\*)|(?<ital>\*)(?<italText>[^*]+?)\*(?!\*)|(?<strike>~~)(?<strikeText>[\s\S]+?)~~(?!~)|(?<link>\[(?<linkText>(?:[^\]\\]|\\.)+)\]\((?<url>[^)\s]+)\))/g;

function inlineNodes(text) {
  const nodes = [];
  const source = String(text ?? "");
  // Collect every match first, then build nodes. Building can recurse into
  // inlineNodes (which reuses this global regex and resets its lastIndex), so
  // we must finish scanning before any recursion to avoid re-scanning forever.
  const matches = [];
  INLINE_RE.lastIndex = 0;
  let match;
  while ((match = INLINE_RE.exec(source))) {
    matches.push(match);
  }
  let last = 0;
  for (match of matches) {
    if (match.index > last) nodes.push(textNode(unescapeInline(source.slice(last, match.index))));
    const groups = match.groups;
    if (groups.code !== undefined) {
      const code = document.createElement("code");
      code.textContent = groups.codeText.replace(/\n+$/, "");
      nodes.push(code);
    } else if (groups.bold !== undefined) {
      const strong = document.createElement("strong");
      strong.append(...inlineNodes(groups.boldText));
      nodes.push(strong);
    } else if (groups.ital !== undefined) {
      const em = document.createElement("em");
      em.append(...inlineNodes(groups.italText));
      nodes.push(em);
    } else if (groups.strike !== undefined) {
      const del = document.createElement("del");
      del.append(...inlineNodes(groups.strikeText));
      nodes.push(del);
    } else if (groups.link !== undefined) {
      const href = safeUrl(groups.url);
      if (!href) {
        nodes.push(textNode(match[0]));
      } else {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.append(...inlineNodes(groups.linkText));
        nodes.push(anchor);
      }
    }
    last = match.index + match[0].length;
  }
  if (last < source.length) nodes.push(textNode(unescapeInline(source.slice(last))));
  return nodes;
}

function appendInline(target, text) {
  target.append(...inlineNodes(text));
}

function indentWidth(value) {
  let width = 0;
  for (const ch of value) {
    if (ch === "\t") width += 4 - (width % 4);
    else if (ch === " ") width += 1;
    else break;
  }
  return width;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)\s*$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BLOCKQUOTE_RE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?(?:\s*\|\s*:?-{2,}:?)+\s*\|?\s*$/;

function startsBlock(line) {
  if (line === undefined) return false;
  if (line.trim() === "") return true;
  return Boolean(
    FENCE_RE.test(line) ||
      HEADING_RE.test(line) ||
      HR_RE.test(line) ||
      BLOCKQUOTE_RE.test(line) ||
      LIST_ITEM_RE.test(line),
  );
}

function renderParagraph(text) {
  const paragraph = document.createElement("p");
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    appendInline(paragraph, line);
    if (index < lines.length - 1) paragraph.append(document.createElement("br"));
  });
  return paragraph;
}

function buildCodeBlock(language, code) {
  const wrapper = document.createElement("div");
  wrapper.className = "code-block";

  const bar = document.createElement("div");
  bar.className = "code-block-bar";
  const label = document.createElement("span");
  label.className = "code-lang";
  label.textContent = language || "code";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "code-copy";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => {
    navigator.clipboard?.writeText(code).then(
      () => {
        copy.textContent = "Copied";
        setTimeout(() => {
          copy.textContent = "Copy";
        }, 1500);
      },
      () => {
        copy.textContent = "Copy";
      },
    );
  });
  bar.append(label, copy);

  const pre = document.createElement("pre");
  const codeEl = document.createElement("code");
  if (language) codeEl.className = `language-${language}`;
  codeEl.textContent = code.replace(/\n+$/, "");
  pre.append(codeEl);

  wrapper.append(bar, pre);
  return wrapper;
}

function splitTableRow(line) {
  const trimmed = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function buildTable(headerLine, rows) {
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const cell of splitTableRow(headerLine)) {
    const th = document.createElement("th");
    appendInline(th, cell);
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const cell of splitTableRow(row)) {
      const td = document.createElement("td");
      appendInline(td, cell);
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  const scroll = document.createElement("div");
  scroll.className = "table-scroll";
  scroll.append(table);
  return scroll;
}

function stripIndent(lines, amount) {
  return lines.map((line) => {
    let remaining = amount;
    let out = "";
    for (const ch of line) {
      if (remaining > 0 && (ch === " " || ch === "\t")) {
        remaining -= ch === "\t" ? 4 - (0 % 4) : 1;
        if (remaining < 0) out += " ".repeat(-remaining);
        continue;
      }
      out += ch;
    }
    return out;
  });
}

function buildList(lines, baseIndent) {
  const firstMarker = lines.find((line) => LIST_ITEM_RE.test(line)) || "";
  const ordered = /^\s*\d+[.)]/.test(firstMarker);
  const list = document.createElement(ordered ? "ol" : "ul");
  let i = 0;
  while (i < lines.length) {
    const match = LIST_ITEM_RE.exec(lines[i]);
    if (!match) {
      i += 1;
      continue;
    }
    const itemIndent = indentWidth(match[1]);
    if (itemIndent < baseIndent) break;
    const li = document.createElement("li");
    appendInline(li, match[3]);
    i += 1;
    const childLines = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        const next = lines[i + 1];
        if (next !== undefined && (LIST_ITEM_RE.test(next) || /^[ \t]+/.test(next))) {
          childLines.push("");
          i += 1;
          continue;
        }
        break;
      }
      const childMatch = LIST_ITEM_RE.exec(line);
      const indent = childMatch ? indentWidth(childMatch[1]) : indentWidth(line);
      if (indent > itemIndent) {
        childLines.push(line);
        i += 1;
      } else {
        break;
      }
    }
    while (childLines.length && childLines[childLines.length - 1] === "") childLines.pop();
    if (childLines.length) {
      const stripped = stripIndent(childLines, itemIndent);
      const fragment = document.createDocumentFragment();
      renderMarkdownInto(fragment, stripped.join("\n"));
      li.append(fragment);
    }
    list.append(li);
  }
  return list;
}

function nextBlock(ctx) {
  const { lines } = ctx;
  const line = lines[ctx.i];

  if (line === undefined) return null;
  if (line.trim() === "") {
    ctx.i += 1;
    return null;
  }

  const fence = FENCE_RE.exec(line);
  if (fence) {
    const marker = fence[1][0];
    const minLen = fence[1].length;
    const language = (fence[2] || "").trim();
    ctx.i += 1;
    const codeLines = [];
    while (ctx.i < lines.length) {
      const close = new RegExp(`^ {0,3}(${marker}{${minLen},})\\s*$`).exec(lines[ctx.i]);
      if (close) {
        ctx.i += 1;
        return buildCodeBlock(language, codeLines.join("\n"));
      }
      codeLines.push(lines[ctx.i].replace(/^ {0,3}/, ""));
      ctx.i += 1;
    }
    return buildCodeBlock(language, codeLines.join("\n"));
  }

  const heading = HEADING_RE.exec(line);
  if (heading) {
    ctx.i += 1;
    const level = Math.min(heading[1].length, 6);
    const h = document.createElement(`h${level}`);
    appendInline(h, heading[2].trim());
    return h;
  }

  if (HR_RE.test(line)) {
    ctx.i += 1;
    const hr = document.createElement("hr");
    return hr;
  }

  if (BLOCKQUOTE_RE.test(line)) {
    const inner = [];
    while (ctx.i < lines.length) {
      const q = BLOCKQUOTE_RE.exec(lines[ctx.i]);
      if (!q) break;
      inner.push(q[1] ?? "");
      ctx.i += 1;
    }
    const blockquote = document.createElement("blockquote");
    renderMarkdownInto(blockquote, inner.join("\n"));
    return blockquote;
  }

  if (LIST_ITEM_RE.test(line)) {
    const blockLines = [];
    while (ctx.i < lines.length) {
      const current = lines[ctx.i];
      if (current.trim() === "") {
        const next = lines[ctx.i + 1];
        if (next !== undefined && (LIST_ITEM_RE.test(next) || /^[ \t]+/.test(next))) {
          blockLines.push("");
          ctx.i += 1;
          continue;
        }
        break;
      }
      if (LIST_ITEM_RE.test(current) || /^[ \t]+\S/.test(current)) {
        blockLines.push(current);
        ctx.i += 1;
        continue;
      }
      break;
    }
    while (blockLines.length && blockLines[blockLines.length - 1] === "") blockLines.pop();
    return buildList(blockLines, 0);
  }

  if (line.includes("|") && ctx.i + 1 < lines.length && TABLE_SEP_RE.test(lines[ctx.i + 1])) {
    const headerLine = line;
    ctx.i += 2;
    const rows = [];
    while (ctx.i < lines.length && lines[ctx.i].includes("|") && lines[ctx.i].trim() !== "") {
      rows.push(lines[ctx.i]);
      ctx.i += 1;
    }
    return buildTable(headerLine, rows);
  }

  const paraLines = [];
  while (ctx.i < lines.length && !startsBlock(lines[ctx.i])) {
    paraLines.push(lines[ctx.i]);
    ctx.i += 1;
  }
  if (paraLines.length === 0) {
    ctx.i += 1;
    return null;
  }
  return renderParagraph(paraLines.join("\n"));
}

function renderMarkdownInto(root, source) {
  const text = String(source ?? "");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const ctx = { lines, i: 0 };
  while (ctx.i < lines.length) {
    const node = nextBlock(ctx);
    if (node) root.append(node);
  }
}

export function renderMarkdown(container, source) {
  container.replaceChildren();
  renderMarkdownInto(container, source);
}
