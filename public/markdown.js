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
const FILE_PATH_RE = /(?:(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:\\)(?:[^\s"'`()\[\]{}<>:]+[\\/])*|(?:[^\s"'`()\[\]{}<>:]+[\\/])+)[^\s"'`()\[\]{}<>:]+\.[A-Za-z0-9]{1,12}/g;
const FILE_NAME_RE = /^[^\s"'`()\[\]{}<>:\\/]+\.[A-Za-z0-9]{1,12}$/;

function isFilePath(value) {
  FILE_PATH_RE.lastIndex = 0;
  const match = FILE_PATH_RE.exec(value);
  FILE_PATH_RE.lastIndex = 0;
  return FILE_NAME_RE.test(value) || (match?.index === 0 && match[0].length === value.length);
}

function fileLink(path, resolveFileUrl, child) {
  const href = resolveFileUrl?.(path);
  if (!href) return child;
  const anchor = document.createElement("a");
  anchor.className = "file-link";
  anchor.dataset.testid = "chat-file-link";
  anchor.dataset.filePath = path;
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.title = `Open ${path}`;
  anchor.append(child);
  return anchor;
}

function pathNodes(text, resolveFileUrl) {
  const nodes = [];
  const source = String(text ?? "");
  FILE_PATH_RE.lastIndex = 0;
  let last = 0;
  let match;
  while ((match = FILE_PATH_RE.exec(source))) {
    const preceding = source.slice(0, match.index);
    if (match[0].startsWith("//") && /[A-Za-z][\w+.-]*:$/.test(preceding)) continue;
    if (match.index > last) nodes.push(textNode(unescapeInline(source.slice(last, match.index))));
    nodes.push(fileLink(match[0], resolveFileUrl, textNode(match[0])));
    last = match.index + match[0].length;
  }
  if (last < source.length) nodes.push(textNode(unescapeInline(source.slice(last))));
  return nodes;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;
// URLs at the end of a sentence swallow the punctuation; trim it back off.
const URL_TRAILING_RE = /[),.;:!?\]}'"]+$/;

// Plain prose can hold a bare URL. Link those first, then hand what is left to
// the file-path linker so a URL is never mistaken for a path.
function urlNodes(text, resolveFileUrl) {
  const nodes = [];
  const source = String(text ?? "");
  URL_RE.lastIndex = 0;
  let last = 0;
  let match;
  while ((match = URL_RE.exec(source))) {
    const raw = match[0].replace(URL_TRAILING_RE, "");
    const href = safeUrl(raw);
    if (!href) continue;
    if (match.index > last) nodes.push(...pathNodes(source.slice(last, match.index), resolveFileUrl));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.dataset.testid = "chat-auto-link";
    anchor.textContent = raw;
    nodes.push(anchor);
    last = match.index + raw.length;
  }
  if (last < source.length) nodes.push(...pathNodes(source.slice(last), resolveFileUrl));
  return nodes;
}

function inlineNodes(text, resolveFileUrl) {
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
    if (match.index > last) nodes.push(...urlNodes(source.slice(last, match.index), resolveFileUrl));
    const groups = match.groups;
    if (groups.code !== undefined) {
      const code = document.createElement("code");
      const codeText = groups.codeText.replace(/\n+$/, "");
      code.textContent = codeText;
      nodes.push(isFilePath(codeText) ? fileLink(codeText, resolveFileUrl, code) : code);
    } else if (groups.bold !== undefined) {
      const strong = document.createElement("strong");
      strong.append(...inlineNodes(groups.boldText, resolveFileUrl));
      nodes.push(strong);
    } else if (groups.ital !== undefined) {
      const em = document.createElement("em");
      em.append(...inlineNodes(groups.italText, resolveFileUrl));
      nodes.push(em);
    } else if (groups.strike !== undefined) {
      const del = document.createElement("del");
      del.append(...inlineNodes(groups.strikeText, resolveFileUrl));
      nodes.push(del);
    } else if (groups.link !== undefined) {
      const linksToFile = Boolean(resolveFileUrl) && isFilePath(groups.url);
      const href = linksToFile ? resolveFileUrl(groups.url) : safeUrl(groups.url);
      if (!href) {
        nodes.push(textNode(match[0]));
      } else {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        if (linksToFile) {
          anchor.className = "file-link";
          anchor.dataset.testid = "chat-file-link";
          anchor.dataset.filePath = groups.url;
          anchor.title = `Open ${groups.url}`;
        }
        anchor.append(...inlineNodes(groups.linkText, resolveFileUrl));
        nodes.push(anchor);
      }
    }
    last = match.index + match[0].length;
  }
  if (last < source.length) nodes.push(...urlNodes(source.slice(last), resolveFileUrl));
  return nodes;
}

function appendInline(target, text, resolveFileUrl) {
  target.append(...inlineNodes(text, resolveFileUrl));
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

function renderParagraph(text, resolveFileUrl) {
  const paragraph = document.createElement("p");
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    appendInline(paragraph, line, resolveFileUrl);
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

function buildTable(headerLine, rows, resolveFileUrl) {
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const cell of splitTableRow(headerLine)) {
    const th = document.createElement("th");
    appendInline(th, cell, resolveFileUrl);
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const cell of splitTableRow(row)) {
      const td = document.createElement("td");
      appendInline(td, cell, resolveFileUrl);
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

function buildList(lines, baseIndent, resolveFileUrl) {
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
    appendInline(li, match[3], resolveFileUrl);
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
      renderMarkdownInto(fragment, stripped.join("\n"), resolveFileUrl);
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
    appendInline(h, heading[2].trim(), ctx.resolveFileUrl);
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
    renderMarkdownInto(blockquote, inner.join("\n"), ctx.resolveFileUrl);
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
    return buildList(blockLines, 0, ctx.resolveFileUrl);
  }

  if (line.includes("|") && ctx.i + 1 < lines.length && TABLE_SEP_RE.test(lines[ctx.i + 1])) {
    const headerLine = line;
    ctx.i += 2;
    const rows = [];
    while (ctx.i < lines.length && lines[ctx.i].includes("|") && lines[ctx.i].trim() !== "") {
      rows.push(lines[ctx.i]);
      ctx.i += 1;
    }
    return buildTable(headerLine, rows, ctx.resolveFileUrl);
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
  return renderParagraph(paraLines.join("\n"), ctx.resolveFileUrl);
}

function renderMarkdownInto(root, source, resolveFileUrl) {
  const text = String(source ?? "");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const ctx = { lines, i: 0, resolveFileUrl };
  while (ctx.i < lines.length) {
    const node = nextBlock(ctx);
    if (node) root.append(node);
  }
}

export function renderMarkdown(container, source, options = {}) {
  container.replaceChildren();
  renderMarkdownInto(container, source, options.resolveFileUrl);
}
