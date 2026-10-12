import { createHash } from 'node:crypto';

export interface SkillRead { id: string; name: string; version: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only explicit SKILL.md read tool calls with a successful, linked result count as reads.
 * Neither a prompt mentioning a skill nor the current filesystem is historical evidence. */
export function skillReadCalls(record: unknown): Array<{ toolId: string; skill: SkillRead }> {
  const message = object(object(record).message);
  const contents = Array.isArray(message.content) ? message.content : [];
  const result: Array<{ toolId: string; skill: SkillRead }> = [];
  for (const raw of contents) {
    const call = object(raw);
    if (call.type !== 'toolCall' && call.type !== 'tool_use') continue;
    const tool = String(call.name ?? call.toolName ?? '');
    if (!/(?:^|\.)read$/.test(tool)) continue;
    const input = object(call.arguments ?? call.input);
    const file = input.path ?? input.file_path;
    if (typeof file !== 'string' || !/(?:^|\/)SKILL\.md$/.test(file)) continue;
    const name = file.split('/').at(-2);
    const toolId = call.id ?? call.toolCallId;
    if (!name || name.length > 100 || typeof toolId !== 'string') continue;
    result.push({ toolId, skill: { id: hash(file), name, version: 'unknown' } });
  }
  return result;
}
export function successfulSkillResult(record: unknown, toolId: string): string | null {
  const message = object(object(record).message);
  const items = [message, ...(Array.isArray(message.content) ? message.content.map(object) : [])];
  for (const item of items) {
    if (item.type !== 'toolResult' && item.type !== 'tool_result' && message.role !== 'toolResult') continue;
    if ((item.toolCallId ?? item.tool_use_id ?? item.id) !== toolId || item.isError === true || item.is_error === true) continue;
    const content = item.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => object(part).text).filter((part): part is string => typeof part === 'string').join('\n') : '';
    return text ? hash(text) : 'unknown';
  }
  return null;
}
