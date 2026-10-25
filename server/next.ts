// "What's next": the owner's to-do for a work, written by the orchestrating agent, read on the Plan tab.
import { validateRich } from './blocks.ts';

const MAX_BY = 80;

// `null` clears it; otherwise summary + typed blocks (steps, callout, table…), stamped with when and who
export function validateNext(input: unknown, now = new Date()) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('next must be an object or null');
  const fields = input as { summary?: unknown; blocks?: unknown; by?: unknown };
  const rich = validateRich({ summary: fields.summary, blocks: fields.blocks });
  if (!rich.summary && !rich.blocks) throw new Error('next needs a summary or blocks');
  const by = typeof fields.by === 'string' && fields.by.trim() ? fields.by.trim().slice(0, MAX_BY) : undefined;
  return { summary: rich.summary || null, blocks: rich.blocks || null, at: now.toISOString(), ...(by ? { by } : {}) };
}
