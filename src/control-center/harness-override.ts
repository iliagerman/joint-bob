/** An agent the person named in their message: "do it with Pi", "using Claude", "on Kiro". */
export interface NamedHarness { id: string; label: string }

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Work Bob starts uses Bob's own agent unless the person said otherwise. This looks for an explicit "with/using/on/in the
 * <agent>" and returns that agent's id; anything else, including an agent's name used in some other way, is not an override.
 */
export function harnessFromMessage(message: string, harnesses: NamedHarness[]): string | null {
  for (const harness of harnesses) {
    const names = [...new Set([harness.id, harness.label])].filter(Boolean).map(escape).join("|");
    if (new RegExp(`\\b(?:with|using|use|via|on)\\s+(?:the\\s+)?(?:${names})(?:\\s+(?:agent|harness))?\\b`, "i").test(message)) return harness.id;
  }
  return null;
}
