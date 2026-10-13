import { createHash } from 'node:crypto';

export interface SkillRead { id: string; name: string; version: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only a tool call that loads a skill, with a successful, linked result, counts as a read: a
 * SKILL.md read, or Claude's Skill tool, which loads a skill by name. Neither a prompt
 * mentioning a skill nor the current filesystem is historical evidence. `versioned` is false
 * when the result is a launch notice rather than the file, so it says nothing about content. */
export function skillReadCalls(record: unknown): Array<{ toolId: string; skill: SkillRead; versioned: boolean }> {
  const message = object(object(record).message);
  const contents = Array.isArray(message.content) ? message.content : [];
  const result: Array<{ toolId: string; skill: SkillRead; versioned: boolean }> = [];
  for (const raw of contents) {
    const call = object(raw);
    if (call.type !== 'toolCall' && call.type !== 'tool_use') continue;
    const tool = String(call.name ?? call.toolName ?? '');
    const input = object(call.arguments ?? call.input);
    const toolId = call.id ?? call.toolCallId;
    if (typeof toolId !== 'string') continue;
    if (tool === 'Skill') {
      const name = input.skill;
      if (typeof name === 'string' && /^[\w.:-]{1,100}$/.test(name)) result.push({ toolId, skill: { id: hash(`skill-tool:${name}`), name, version: 'unknown' }, versioned: false });
      continue;
    }
    if (!/(?:^|\.)read$/i.test(tool)) continue;
    const file = input.path ?? input.file_path;
    if (typeof file !== 'string' || !/(?:^|\/)SKILL\.md$/.test(file)) continue;
    const name = file.split('/').at(-2);
    if (!name || name.length > 100) continue;
    result.push({ toolId, skill: { id: hash(file), name, version: 'unknown' }, versioned: true });
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
