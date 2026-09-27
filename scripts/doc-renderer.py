#!/usr/bin/env python3
"""Render a structured feature-doc JSON file into a dark-themed HTML page.

This is the canonical documentation renderer for `docs/`. Every feature
doc lives as a JSON file next to its `.html` output (e.g.
`docs/features/auth.json` → `docs/features/auth.html`). Agents author the
JSON; this script handles all styling so the output stays consistent.

The visual language follows the plan-visualizer skill
(`~/.claude/skills/plan-visualizer`) -- same dark palette, same badge
tokens, same typography -- but the layout is tuned for reference docs
(hero + TOC + sections of tables/bullets/prose/related-links) rather
than BEFORE/AFTER plan infographics.

Usage:
    python3 scripts/doc-renderer.py docs/features/auth.json
    python3 scripts/doc-renderer.py docs/features/auth.json -o /tmp/auth.html
    python3 scripts/doc-renderer.py --all docs/features   # render every *.json

Schema (see `docs/features/*.json` for worked examples):

    {
      "title":    "Feature Name",
      "subtitle": "One paragraph. Supports `backticks` and [links](other.html).",
      "eyebrow":  "FEATURE / SECTION",       # optional small label over title
      "profile":  "STANDARD",                 # optional pill
      "generated": "2026-04-17",              # optional; defaults to today
      "badges":   [                           # optional header chips
        {"label": "Multi-tenant", "variant": "added"},
        {"label": "Admin-only",   "variant": "changed"}
      ],
      "sections": [
        {
          "title": "Architecture",
          "blocks": [
            { "kind": "table",
              "title": "Backend",
              "columns": ["Layer", "Path"],
              "rows": [["Router", "`backend/app/routers/auth.py`"], ...] },
            { "kind": "bullets",
              "title": "Key Enums",
              "items": ["`AuthProviderType` -- local/cognito/okta/google"] }
          ]
        }
      ]
    }

Supported block kinds: `prose`, `paragraphs`, `table`, `bullets`,
`numbered`, `dl`, `callout`, `code`, `related`.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
from datetime import date
from pathlib import Path


BADGE_VARIANTS = {
    "added": "badge-added",
    "changed": "badge-changed",
    "removed": "badge-removed",
    "info": "badge-info",
    "neutral": "badge-unchanged",
    "unchanged": "badge-unchanged",
}

CALLOUT_VARIANTS = {"info", "good", "warn", "bad"}


_CODE_PLACEHOLDER = "\x00CODE{}\x00"


def render_inline(text: str) -> str:
    """Escape text, then re-hydrate `code` spans, links, and emphasis.

    Code spans are stashed as placeholders before bold/italic run so regex
    metacharacters inside backticks (e.g. `snake_case`, `CORE_*`) never get
    interpreted as emphasis.
    """
    if text is None:
        return ""
    escaped = html.escape(str(text))

    # [label](href) - simple markdown link, run before other substitutions.
    escaped = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        lambda m: f'<a class="doc-link" href="{html.escape(m.group(2), quote=True)}">{m.group(1)}</a>',
        escaped,
    )

    # Stash code spans so their content is opaque to the bold/italic regex.
    code_slots: list[str] = []

    def _stash(match: re.Match) -> str:
        idx = len(code_slots)
        code_slots.append(f'<code class="inline">{match.group(1)}</code>')
        return _CODE_PLACEHOLDER.format(idx)

    escaped = re.sub(r"`([^`]+)`", _stash, escaped)

    # Bold: **text** → <strong>. Non-greedy so **a** and **b** don't merge.
    escaped = re.sub(r"\*\*(.+?)\*\*", r'<strong class="inline-strong">\1</strong>', escaped)

    # Italic: _text_ — only when surrounded by non-word chars (or string edges).
    escaped = re.sub(
        r"(?<!\w)_([^_\n]+)_(?!\w)", r'<em class="inline-em">\1</em>', escaped
    )

    # Restore code spans.
    for idx, code_html in enumerate(code_slots):
        escaped = escaped.replace(_CODE_PLACEHOLDER.format(idx), code_html)

    return escaped


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.lower()).strip("-")
    return slug[:60] or "section"


def render_badge(badge: dict) -> str:
    label = render_inline(badge.get("label", ""))
    variant = (badge.get("variant") or "neutral").lower()
    cls = BADGE_VARIANTS.get(variant, "badge-unchanged")
    return f'<span class="badge {cls}">{label}</span>'


def render_block_prose(block: dict) -> str:
    text = render_inline(block.get("text", ""))
    return f'<p class="doc-para">{text}</p>'


def render_block_paragraphs(block: dict) -> str:
    items = block.get("items") or []
    return "".join(
        f'<p class="doc-para">{render_inline(item)}</p>' for item in items
    )


def render_block_table(block: dict) -> str:
    title = block.get("title")
    columns = block.get("columns") or []
    rows = block.get("rows") or []

    title_html = (
        f'<h3 class="block-subtitle">{render_inline(title)}</h3>' if title else ""
    )
    if not columns and not rows:
        return f'{title_html}<div class="empty-row">—</div>'

    thead = (
        "<thead><tr>"
        + "".join(f"<th>{render_inline(col)}</th>" for col in columns)
        + "</tr></thead>"
    )

    body_rows = []
    for row in rows:
        if isinstance(row, dict):
            cells = [row.get(col, "") for col in columns]
        else:
            cells = list(row)
        cells_html = "".join(f"<td>{render_inline(cell)}</td>" for cell in cells)
        body_rows.append(f"<tr>{cells_html}</tr>")
    tbody = "<tbody>" + "".join(body_rows) + "</tbody>"

    return f'{title_html}<div class="table-wrap"><table class="doc-table">{thead}{tbody}</table></div>'


def render_block_bullets(block: dict) -> str:
    title = block.get("title")
    items = block.get("items") or []
    title_html = (
        f'<h3 class="block-subtitle">{render_inline(title)}</h3>' if title else ""
    )
    if not items:
        return f'{title_html}<div class="empty-row">—</div>'
    items_html = "".join(
        f'<li><span class="bullet-dot">•</span><span>{render_inline(item)}</span></li>'
        for item in items
    )
    return f'{title_html}<ul class="doc-bullets">{items_html}</ul>'


def render_block_numbered(block: dict) -> str:
    title = block.get("title")
    items = block.get("items") or []
    title_html = (
        f'<h3 class="block-subtitle">{render_inline(title)}</h3>' if title else ""
    )
    if not items:
        return f'{title_html}<div class="empty-row">—</div>'
    parts = []
    for idx, item in enumerate(items, start=1):
        if isinstance(item, dict):
            heading = item.get("heading") or item.get("title") or ""
            body = item.get("body") or item.get("text") or ""
            heading_html = (
                f'<div class="numbered-heading">{render_inline(heading)}</div>'
                if heading
                else ""
            )
            body_html = f'<div class="numbered-body">{render_inline(body)}</div>'
        else:
            heading_html = ""
            body_html = f'<div class="numbered-body">{render_inline(item)}</div>'
        parts.append(
            f'<li>'
            f'  <span class="numbered-marker">{idx:02d}</span>'
            f'  <div class="numbered-content">{heading_html}{body_html}</div>'
            f'</li>'
        )
    return f'{title_html}<ol class="doc-numbered">{"".join(parts)}</ol>'


def render_block_dl(block: dict) -> str:
    title = block.get("title")
    items = block.get("items") or []
    title_html = (
        f'<h3 class="block-subtitle">{render_inline(title)}</h3>' if title else ""
    )
    if not items:
        return f'{title_html}<div class="empty-row">—</div>'
    parts = []
    for item in items:
        term = item.get("term", "") if isinstance(item, dict) else ""
        body = item.get("body", "") if isinstance(item, dict) else str(item)
        parts.append(
            f'<div class="dl-row">'
            f'  <dt>{render_inline(term)}</dt>'
            f'  <dd>{render_inline(body)}</dd>'
            f'</div>'
        )
    return f'{title_html}<dl class="doc-dl">{"".join(parts)}</dl>'


def render_block_callout(block: dict) -> str:
    variant = (block.get("variant") or "info").lower()
    if variant not in CALLOUT_VARIANTS:
        variant = "info"
    title = block.get("title")
    title_html = (
        f'<div class="callout-title">{render_inline(title)}</div>' if title else ""
    )
    body = block.get("body") or block.get("text") or ""
    return (
        f'<div class="callout callout-{variant}">'
        f'  {title_html}'
        f'  <div class="callout-body">{render_inline(body)}</div>'
        f'</div>'
    )


def render_block_code(block: dict) -> str:
    language = block.get("language") or ""
    body = block.get("body") or block.get("code") or ""
    title = block.get("title")
    title_html = (
        f'<div class="code-title">{render_inline(title)}</div>' if title else ""
    )
    lang_label = (
        f'<span class="code-lang">{html.escape(language)}</span>' if language else ""
    )
    escaped_body = html.escape(body)
    return (
        f'<div class="code-wrap">'
        f'  {title_html}'
        f'  {lang_label}'
        f'  <pre><code>{escaped_body}</code></pre>'
        f'</div>'
    )


def render_block_related(block: dict) -> str:
    title = block.get("title")
    items = block.get("items") or []
    title_html = (
        f'<h3 class="block-subtitle">{render_inline(title)}</h3>' if title else ""
    )
    if not items:
        return f'{title_html}<div class="empty-row">—</div>'
    cards = []
    for item in items:
        if isinstance(item, str):
            href = item
            title_text = item
            description = ""
        else:
            href = item.get("href", "")
            title_text = item.get("title", item.get("label", href))
            description = item.get("description", "")
        cards.append(
            f'<a class="related-card" href="{html.escape(href, quote=True)}">'
            f'  <div class="related-title">{render_inline(title_text)}</div>'
            f'  <div class="related-desc">{render_inline(description)}</div>'
            f'  <div class="related-arrow">→</div>'
            f'</a>'
        )
    return f'{title_html}<div class="related-grid">{"".join(cards)}</div>'


def render_block_image(block: dict) -> str:
    src = block.get("src", "")
    alt = block.get("alt", "")
    caption = block.get("caption")
    title = block.get("title")
    title_html = (
        f'<h3 class="block-subtitle">{render_inline(title)}</h3>' if title else ""
    )
    caption_html = (
        f'<figcaption class="image-caption">{render_inline(caption)}</figcaption>'
        if caption
        else ""
    )
    return (
        f'{title_html}'
        f'<figure class="doc-figure">'
        f'  <img src="{html.escape(src, quote=True)}" alt="{html.escape(alt, quote=True)}" />'
        f'  {caption_html}'
        f'</figure>'
    )


def render_block_cards(block: dict) -> str:
    """Rich card grid — like `related` but without href, for key-point breakdowns."""
    title = block.get("title")
    items = block.get("items") or []
    title_html = (
        f'<h3 class="block-subtitle">{render_inline(title)}</h3>' if title else ""
    )
    if not items:
        return f'{title_html}<div class="empty-row">—</div>'
    cards = []
    for item in items:
        t = item.get("title", "") if isinstance(item, dict) else ""
        desc = item.get("description", "") if isinstance(item, dict) else str(item)
        icon = item.get("icon", "") if isinstance(item, dict) else ""
        icon_html = (
            f'<div class="card-icon">{render_inline(icon)}</div>' if icon else ""
        )
        cards.append(
            f'<div class="info-card">'
            f'  {icon_html}'
            f'  <div class="info-card-title">{render_inline(t)}</div>'
            f'  <div class="info-card-desc">{render_inline(desc)}</div>'
            f'</div>'
        )
    return f'{title_html}<div class="info-card-grid">{"".join(cards)}</div>'


BLOCK_RENDERERS = {
    "prose": render_block_prose,
    "paragraphs": render_block_paragraphs,
    "table": render_block_table,
    "bullets": render_block_bullets,
    "numbered": render_block_numbered,
    "dl": render_block_dl,
    "callout": render_block_callout,
    "code": render_block_code,
    "related": render_block_related,
    "image": render_block_image,
    "cards": render_block_cards,
}


def render_block(block: dict) -> str:
    kind = block.get("kind", "prose")
    renderer = BLOCK_RENDERERS.get(kind)
    if renderer is None:
        body = html.escape(json.dumps(block))
        return f'<div class="callout callout-bad">Unknown block kind: <code>{html.escape(kind)}</code><pre>{body}</pre></div>'
    return renderer(block)


def render_section(section: dict) -> str:
    title = section.get("title", "")
    slug = section.get("id") or slugify(title)
    subtitle = section.get("subtitle")
    subtitle_html = (
        f'<p class="section-lede">{render_inline(subtitle)}</p>' if subtitle else ""
    )
    blocks_html = "".join(render_block(block) for block in section.get("blocks", []))
    return (
        f'<section class="doc-section" id="{html.escape(slug, quote=True)}">'
        f'  <h2 class="section-heading">{render_inline(title)}</h2>'
        f'  {subtitle_html}'
        f'  {blocks_html}'
        f'</section>'
    )


def render_toc(sections: list) -> str:
    if not sections:
        return ""
    items = []
    for section in sections:
        title = section.get("title", "")
        slug = section.get("id") or slugify(title)
        items.append(
            f'<li><a href="#{html.escape(slug, quote=True)}">{render_inline(title)}</a></li>'
        )
    return f'<nav class="toc"><ol class="toc-list">{"".join(items)}</ol></nav>'


def render_html(doc: dict) -> str:
    title = render_inline(doc.get("title", "Documentation"))
    subtitle = render_inline(doc.get("subtitle", ""))
    eyebrow = html.escape(doc.get("eyebrow") or "Documentation")
    profile = html.escape(doc.get("profile") or "")
    generated = html.escape(doc.get("generated") or date.today().isoformat())

    badges_html = "".join(render_badge(b) for b in (doc.get("badges") or []))
    profile_html = (
        f'<span class="profile-pill">{profile}</span>' if profile else ""
    )

    sections = doc.get("sections", [])
    toc_html = render_toc(sections)
    sections_html = "\n".join(render_section(section) for section in sections)

    doc_title = html.escape(doc.get("title", "Documentation"))

    return TEMPLATE.format(
        doc_title=doc_title,
        title=title,
        subtitle=subtitle,
        eyebrow=eyebrow,
        profile_html=profile_html,
        generated=generated,
        badges_html=badges_html,
        toc=toc_html,
        sections=sections_html,
    )


TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{doc_title}</title>
<style>
  :root {{
    --bg: #0b0f14;
    --panel: #131922;
    --panel-alt: #182030;
    --border: #222b39;
    --border-strong: #2f3a4c;
    --text: #e6ebf2;
    --text-strong: #f5f7fa;
    --muted: #8893a5;
    --dim: #5b6778;
    --added: #3fb950;
    --added-bg: rgba(63,185,80,0.14);
    --changed: #f5b041;
    --changed-bg: rgba(245,176,65,0.14);
    --removed: #f47272;
    --removed-bg: rgba(244,114,114,0.14);
    --unchanged: #8893a5;
    --unchanged-bg: rgba(136,147,165,0.14);
    --info: #6ea8fe;
    --info-bg: rgba(110,168,254,0.14);
    --accent: #6ea8fe;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }}
  * {{ box-sizing: border-box; }}
  html, body {{
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.6;
    margin: 0;
    padding: 0;
  }}
  body {{
    background:
      radial-gradient(ellipse 60% 50% at 50% -10%, rgba(110,168,254,0.08), transparent 70%),
      var(--bg);
  }}
  a {{ color: var(--accent); text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}

  .page {{
    max-width: 1180px;
    margin: 0 auto;
    padding: 40px 36px 80px;
  }}

  /* Hero */
  header.hero {{
    padding-bottom: 28px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 34px;
  }}
  .eyebrow {{
    color: var(--muted);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 600;
    margin-bottom: 14px;
  }}
  .hero-row {{
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 28px;
    flex-wrap: wrap;
  }}
  .hero-left h1 {{
    margin: 0 0 14px;
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text-strong);
    line-height: 1.15;
    background: linear-gradient(90deg, #ffffff 0%, #c7d3eb 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }}
  .hero-left .subtitle {{
    color: var(--muted);
    font-size: 15px;
    line-height: 1.55;
    max-width: 820px;
  }}
  .hero-right {{
    text-align: right;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    min-width: 180px;
  }}
  .profile-pill {{
    border: 1px solid var(--border-strong);
    background: var(--panel);
    color: var(--muted);
    padding: 5px 12px;
    border-radius: 999px;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    font-weight: 600;
  }}
  .gen-line {{
    color: var(--dim);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }}
  .hero-badges {{
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 18px;
  }}
  .badge {{
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    padding: 3px 9px;
    border-radius: 4px;
    border: 1px solid transparent;
    text-transform: uppercase;
    font-weight: 600;
  }}
  .badge-added    {{ color: var(--added);    background: var(--added-bg);    border-color: rgba(63,185,80,0.35); }}
  .badge-changed  {{ color: var(--changed);  background: var(--changed-bg);  border-color: rgba(245,176,65,0.35); }}
  .badge-removed  {{ color: var(--removed);  background: var(--removed-bg);  border-color: rgba(244,114,114,0.35); }}
  .badge-info     {{ color: var(--info);     background: var(--info-bg);     border-color: rgba(110,168,254,0.35); }}
  .badge-unchanged{{ color: var(--unchanged);background: var(--unchanged-bg);border-color: rgba(136,147,165,0.35); }}

  /* TOC */
  .toc {{
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 22px;
    margin-bottom: 32px;
  }}
  .toc-list {{
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 22px;
    counter-reset: toc;
  }}
  .toc-list li {{
    counter-increment: toc;
    font-size: 12px;
    color: var(--muted);
    letter-spacing: 0.04em;
  }}
  .toc-list li::before {{
    content: counter(toc, decimal-leading-zero) "  ";
    color: var(--dim);
    font-family: var(--mono);
    font-size: 11px;
    margin-right: 6px;
  }}
  .toc-list a {{ color: var(--muted); }}
  .toc-list a:hover {{ color: var(--accent); text-decoration: none; }}

  /* Sections */
  .doc-section {{
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 26px 28px;
    margin-bottom: 22px;
    scroll-margin-top: 24px;
  }}
  .section-heading {{
    margin: 0 0 14px;
    font-size: 12px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }}
  .section-lede {{
    color: var(--muted);
    font-size: 14px;
    margin: 0 0 20px;
    max-width: 820px;
  }}
  .block-subtitle {{
    margin: 22px 0 10px;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--dim);
    font-weight: 600;
  }}
  .block-subtitle:first-child {{ margin-top: 4px; }}

  /* Prose */
  .doc-para {{
    color: #c3cbd8;
    margin: 0 0 14px;
    font-size: 14px;
    line-height: 1.65;
  }}
  .doc-para:last-child {{ margin-bottom: 0; }}

  /* Tables */
  .table-wrap {{
    overflow-x: auto;
    margin: 0 0 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel-alt);
  }}
  .doc-table {{
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }}
  .doc-table th {{
    text-align: left;
    padding: 11px 14px;
    font-size: 10.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    background: rgba(255,255,255,0.015);
  }}
  .doc-table td {{
    padding: 10px 14px;
    color: #c3cbd8;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }}
  .doc-table tr:last-child td {{ border-bottom: none; }}
  .doc-table tr:hover td {{ background: rgba(255,255,255,0.02); }}

  /* Bullets */
  .doc-bullets {{
    list-style: none;
    padding: 0;
    margin: 0 0 14px;
  }}
  .doc-bullets li {{
    display: flex;
    gap: 12px;
    padding: 5px 0;
    color: #c3cbd8;
    font-size: 14px;
  }}
  .bullet-dot {{
    flex-shrink: 0;
    width: 14px;
    text-align: center;
    color: var(--accent);
    font-weight: 700;
    line-height: 1.6;
  }}

  /* Numbered */
  .doc-numbered {{
    list-style: none;
    padding: 0;
    margin: 0 0 14px;
    counter-reset: num;
  }}
  .doc-numbered li {{
    display: flex;
    gap: 14px;
    padding: 10px 14px;
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 10px;
  }}
  .numbered-marker {{
    flex-shrink: 0;
    width: 32px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(110,168,254,0.1);
    border: 1px solid rgba(110,168,254,0.25);
    color: var(--accent);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 700;
    border-radius: 5px;
    letter-spacing: 0.06em;
  }}
  .numbered-content {{ flex: 1; min-width: 0; }}
  .numbered-heading {{
    font-weight: 600;
    color: var(--text-strong);
    font-size: 14px;
    margin-bottom: 4px;
  }}
  .numbered-body {{ color: #c3cbd8; font-size: 13.5px; line-height: 1.6; }}

  /* Definition list */
  .doc-dl {{ margin: 0 0 14px; }}
  .dl-row {{
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 18px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }}
  .dl-row:last-child {{ border-bottom: none; }}
  .dl-row dt {{
    color: var(--text-strong);
    font-weight: 600;
    font-family: var(--mono);
    font-size: 12.5px;
  }}
  .dl-row dd {{
    color: #c3cbd8;
    margin: 0;
    font-size: 13.5px;
    line-height: 1.55;
  }}
  @media (max-width: 720px) {{
    .dl-row {{ grid-template-columns: 1fr; gap: 4px; }}
  }}

  /* Callouts */
  .callout {{
    border-left: 3px solid var(--accent);
    padding: 12px 16px;
    background: rgba(110,168,254,0.06);
    border-radius: 6px;
    margin: 0 0 14px;
    font-size: 13.5px;
    color: var(--text);
  }}
  .callout-info {{ border-left-color: var(--accent); background: rgba(110,168,254,0.06); }}
  .callout-good {{ border-left-color: var(--added); background: rgba(63,185,80,0.06); }}
  .callout-warn {{ border-left-color: var(--changed); background: rgba(245,176,65,0.06); }}
  .callout-bad  {{ border-left-color: var(--removed); background: rgba(244,114,114,0.06); }}
  .callout-title {{
    font-weight: 700;
    margin-bottom: 4px;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }}
  .callout-body {{ color: #c3cbd8; }}

  /* Code */
  .code-wrap {{
    position: relative;
    margin: 0 0 14px;
  }}
  .code-title {{
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
  }}
  .code-lang {{
    position: absolute;
    top: 10px;
    right: 14px;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--dim);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }}
  pre {{
    font-family: var(--mono);
    background: #0a1018;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 18px;
    overflow-x: auto;
    font-size: 12.5px;
    line-height: 1.6;
    color: #d8e0ee;
    margin: 0;
  }}
  pre code {{
    font-family: inherit;
    background: transparent;
    padding: 0;
    border: none;
  }}

  /* Inline code */
  code.inline {{
    font-family: var(--mono);
    font-size: 12px;
    color: #cddaf2;
    background: rgba(110,168,254,0.08);
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid rgba(110,168,254,0.15);
  }}

  /* Inline emphasis */
  .inline-strong {{
    color: var(--text-strong);
    font-weight: 600;
  }}
  .inline-em {{
    color: var(--text);
    font-style: italic;
  }}

  /* Doc links inside inline text */
  a.doc-link {{
    color: var(--accent);
    border-bottom: 1px dotted rgba(110,168,254,0.4);
  }}
  a.doc-link:hover {{
    border-bottom-color: var(--accent);
    text-decoration: none;
  }}

  /* Related feature cards */
  .related-grid {{
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 10px;
    margin: 0;
  }}
  .related-card {{
    display: block;
    position: relative;
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 44px 14px 16px;
    color: var(--text);
    transition: border-color 120ms ease, transform 120ms ease;
  }}
  .related-card:hover {{
    border-color: rgba(110,168,254,0.45);
    text-decoration: none;
    transform: translateY(-1px);
  }}
  .related-title {{
    font-weight: 600;
    color: var(--text-strong);
    font-size: 13.5px;
    margin-bottom: 3px;
  }}
  .related-desc {{
    color: var(--muted);
    font-size: 12.5px;
    line-height: 1.45;
  }}
  .related-arrow {{
    position: absolute;
    right: 14px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--dim);
    font-size: 16px;
    transition: color 120ms ease, transform 120ms ease;
  }}
  .related-card:hover .related-arrow {{
    color: var(--accent);
    transform: translateY(-50%) translateX(2px);
  }}

  .empty-row {{
    color: var(--dim);
    font-size: 12px;
    padding: 4px 0;
  }}

  /* Figures / images */
  .doc-figure {{
    margin: 0 0 18px;
    padding: 14px;
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 10px;
    text-align: center;
  }}
  .doc-figure img {{
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    display: block;
    margin: 0 auto;
    background: #0a1018;
  }}
  .image-caption {{
    margin-top: 10px;
    color: var(--muted);
    font-size: 12.5px;
    font-style: italic;
  }}

  /* Info card grid — non-linking card tiles for key-point breakdowns. */
  .info-card-grid {{
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 12px;
    margin: 0 0 14px;
  }}
  .info-card {{
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
  }}
  .info-card .card-icon {{
    font-size: 20px;
    margin-bottom: 8px;
    color: var(--accent);
  }}
  .info-card-title {{
    font-weight: 600;
    color: var(--text-strong);
    font-size: 13.5px;
    margin-bottom: 4px;
  }}
  .info-card-desc {{
    color: var(--muted);
    font-size: 12.5px;
    line-height: 1.55;
  }}

  @media (max-width: 820px) {{
    .page {{ padding: 24px 18px 60px; }}
    .hero-row {{ flex-direction: column; }}
    .hero-right {{ align-items: flex-start; text-align: left; }}
    .hero-left h1 {{ font-size: 26px; }}
  }}
</style>
</head>
<body>
  <div class="page">
    <header class="hero">
      <div class="eyebrow">{eyebrow}</div>
      <div class="hero-row">
        <div class="hero-left">
          <h1>{title}</h1>
          <div class="subtitle">{subtitle}</div>
        </div>
        <div class="hero-right">
          {profile_html}
          <span class="gen-line">Generated {generated}</span>
        </div>
      </div>
      <div class="hero-badges">{badges_html}</div>
    </header>

    {toc}

    {sections}
  </div>
</body>
</html>
"""


def load_doc(source: str) -> dict:
    if source == "-":
        return json.load(sys.stdin)
    path = Path(source).expanduser()
    return json.loads(path.read_text())


def render_one(json_path: Path, output: Path | None = None) -> Path:
    doc = json.loads(json_path.read_text())
    rendered = render_html(doc)
    if output is None:
        output = json_path.with_suffix(".html")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "input",
        help='Path to a JSON file, a directory (with --all), or "-" for stdin.',
    )
    parser.add_argument(
        "-o",
        "--output",
        help="Path to write the HTML file. Defaults to <input>.html next to the input.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Treat the input as a directory and render every *.json inside to <basename>.html.",
    )
    args = parser.parse_args()

    if args.all:
        root = Path(args.input).expanduser()
        if not root.is_dir():
            print(f"error: --all requires a directory, got {root}", file=sys.stderr)
            return 2
        count = 0
        for json_path in sorted(root.glob("*.json")):
            rendered = render_one(json_path)
            print(f"{json_path} -> {rendered}")
            count += 1
        print(f"rendered {count} file(s)")
        return 0

    if args.input == "-":
        doc = json.load(sys.stdin)
        rendered = render_html(doc)
        if args.output:
            Path(args.output).expanduser().write_text(rendered, encoding="utf-8")
            print(args.output)
        else:
            sys.stdout.write(rendered)
        return 0

    input_path = Path(args.input).expanduser()
    if not input_path.is_file():
        print(f"error: input not found: {input_path}", file=sys.stderr)
        return 1

    output_path = Path(args.output).expanduser() if args.output else None
    rendered_path = render_one(input_path, output_path)
    print(rendered_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
