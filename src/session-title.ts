// Known abbreviations that stay in capitals wherever they appear in a title.
const capitalWords = new Set(["AI", "API", "CI", "CLI", "CSS", "DB", "DNS", "HTML", "HTTP", "ID", "JS", "JSON", "LLM", "MCP", "PDF", "PR", "RTL", "SDK", "SQL", "SSH", "TS", "UI", "URL", "UX"]);

/** Capitalises each word of a generated conversation title and keeps known abbreviations in capitals (for example "mobile ux" becomes "Mobile UX"). */
export function titleCase(title: string): string {
  return title.replace(/[A-Za-z][A-Za-z0-9]*/g, (word) => {
    const upper = word.toUpperCase();
    return capitalWords.has(upper) ? upper : word[0].toUpperCase() + word.slice(1);
  });
}
