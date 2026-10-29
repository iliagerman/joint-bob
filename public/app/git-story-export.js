// Saves a story as one HTML file: the animated walkthrough plus the written review notes,
// with the same scripts and styles the app uses, so it opens anywhere without the app.
const MODULES = ["git-story-dom.js", "git-story-diagram.js", "git-story-video.js", "git-story-notes.js"];
const STYLE_RULES = /^:root|^\[hidden\]|\.gs-|\.git-story|\.git-review-spinner|\.gsv|\.gsn/;

const read = async (url) => {
  const response = await fetch(new URL(url, import.meta.url));
  if (!response.ok) throw new Error(`Could not read ${url} (${response.status}).`);
  return response.text();
};

// One script: imports resolve to the modules above it, so they are dropped and `export` is removed.
const inline = (source) => source.replace(/^import .*;\n/gm, "").replace(/^export /gm, "");

function appStyles() {
  const rules = [];
  const wanted = (rule) => rule.selectorText ? STYLE_RULES.test(rule.selectorText) : rule.cssRules ? [...rule.cssRules].some(wanted) : false;
  for (const sheet of document.styleSheets) {
    if (sheet.href && !sheet.href.endsWith("/styles.css")) continue;
    for (const rule of sheet.cssRules) if (wanted(rule)) rules.push(rule.cssText);
  }
  return rules.join("\n");
}

const PAGE_CSS = `
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
button { font: inherit; color: inherit; padding: 5px 12px; border: 0; border-radius: 8px; cursor: pointer; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 24px 80px; }
.gsx-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 24px; }
.gsx-head h1 { flex: 1 1 100%; margin: 0; font-size: 28px; line-height: 1.2; }
.gsx-head button { padding: 9px 18px; background: var(--accent); color: #fff; font-weight: 700; }
.gsx-head button.is-quiet { background: var(--field); color: var(--text); }
.gsx-head p { margin: 0; color: var(--muted); }
.gsn-section { margin: 0 0 28px; }
.gsn-section h2 { margin: 0 0 10px; font: 700 12px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }
.gsn table { width: 100%; border-collapse: collapse; font-size: 13px; }
.gsn th, .gsn td { padding: 7px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
.gsn th { font: 700 11px/1.4 var(--mono); text-transform: uppercase; color: var(--muted); }
.gsn code, .gsv code { font: 12px/1.5 var(--mono); padding: 1px 6px; border-radius: 6px; background: var(--field); }
.gsn-card { margin: 0 0 10px; padding: 12px 16px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--panel); }
.gsn-card p { margin: 6px 0 0; }
.gsn-muted { color: var(--muted); }
.gsn-files { display: flex; flex-wrap: wrap; gap: 4px; }
`;

const START = `
const data = JSON.parse(document.getElementById("story-data").textContent);
const notify = (message) => { const bar = document.getElementById("notice"); bar.textContent = message; bar.hidden = false; };
const play = (voice) => playStoryVideo({ story: data.story, facts: data.facts, host: document.body, notify, voice });
document.getElementById("notes").append(storyNotes(data.story, data.facts));
document.getElementById("play").onclick = () => play(true);
document.getElementById("play-silent").onclick = () => play(false);
`;

export async function exportStoryHtml(story, facts) {
  const [sources, videoCss] = await Promise.all([Promise.all(MODULES.map((name) => read(`./${name}`))), read("../git-story-video.css")]);
  const theme = document.documentElement.getAttribute("data-theme");
  const data = JSON.stringify({ story, facts }).replace(/</g, "\\u003c");
  const page = `<!doctype html>
<html lang="en"${theme ? ` data-theme="${theme}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${story.title.replace(/[<&]/g, "")}</title>
<style>${appStyles()}</style>
<style id="gsvStyles">${videoCss}</style>
<style>${PAGE_CSS}</style>
</head>
<body class="git-story-export">
<main>
<header class="gsx-head">
<h1>${story.title.replace(/[<&]/g, "")}</h1>
<button id="play" type="button">▶ Play walkthrough</button>
<button id="play-silent" type="button" class="is-quiet">Play without voice</button>
<p>Voice uses this computer's speech voice. Esc closes the player.</p>
<p id="notice" hidden></p>
</header>
<div id="notes"></div>
</main>
<script type="application/json" id="story-data">${data}</script>
<script type="module">
${sources.map(inline).join("\n")}
${START}
</script>
</body>
</html>
`;
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([page], { type: "text/html" })), download: `${story.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.html` });
  link.click();
  URL.revokeObjectURL(link.href);
}
