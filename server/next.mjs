// "What's next": the owner's to-do for a work, written by the orchestrating agent, read on the Plan tab.
import { validateRich } from './blocks.mjs';

const MAX_BY = 80;

// `null` clears it; otherwise summary + typed blocks (steps, callout, table…), stamped with when and who
export function validateNext(input, now = new Date()) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('next must be an object or null');
  const rich = validateRich({ summary: input.summary, blocks: input.blocks });
  if (!rich.summary && !rich.blocks) throw new Error('next needs a summary or blocks');
  const by = typeof input.by === 'string' && input.by.trim() ? input.by.trim().slice(0, MAX_BY) : undefined;
  return { summary: rich.summary || null, blocks: rich.blocks || null, at: now.toISOString(), ...(by ? { by } : {}) };
}
