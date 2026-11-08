// Known abbreviations that stay in capitals wherever they appear in a title.
const capitalWords = new Set(["AI", "API", "CI", "CLI", "CSS", "DB", "DNS", "HTML", "HTTP", "ID", "JS", "JSON", "LLM", "MCP", "PDF", "PR", "RTL", "SDK", "SQL", "SSH", "TS", "UI", "URL", "UX"]);

/**
 * Title case for display: known abbreviations go to capitals ("ux" becomes "UX") and other all-lowercase words get a capital first letter.
 * Words that already mix cases, such as "iOS" or "GitHub", stay as written.
 */
export function titleCase(title: string): string {
  return title.replace(/\p{L}[\p{L}\p{N}'’]*/gu, (word) => {
    const upper = word.toUpperCase();
    if (capitalWords.has(upper)) return upper;
    return word === word.toLowerCase() ? word[0].toUpperCase() + word.slice(1) : word;
  });
}
