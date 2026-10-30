// An agent's activity grouped the way Paseo's timeline groups it: consecutive tool calls between two other items fold into one row,
// thinking is its own row, anything else (text, blocks, user messages, notes) passes through untouched.
import type { ActivityEvent } from '../types.ts';

export type CallCounts = { editedFiles: number; commands: number; readFiles: number; searches: number; otherTools: number; paseoCalls: number };
export type ActivityItem =
  | { kind: 'tools'; calls: ActivityEvent[]; counts: CallCounts; label: string; running: boolean }
  | { kind: 'think'; text: string; running: boolean }
  | { kind: 'live'; text: string }
  | { kind: 'permission'; event: ActivityEvent; resolution?: unknown }
  | { kind: 'event'; event: ActivityEvent };

const NAME_KIND: Record<string, string> = { bash: 'shell', read: 'read', edit: 'edit', multiedit: 'edit', notebookedit: 'edit', write: 'write', grep: 'search', glob: 'search', websearch: 'search', webfetch: 'fetch' };
const SEARCH_NAME = /(?:^|[_.:/])(?:web_search|llm_context)$/;
const PHRASES: [keyof CallCounts, string, string, string][] = [
  ['editedFiles', 'edited', 'file', 'files'],
  ['commands', 'ran', 'command', 'commands'],
  ['readFiles', 'read', 'file', 'files'],
  ['searches', 'searched', 'time', 'times'],
  ['otherTools', 'used', 'other tool', 'other tools'],
  ['paseoCalls', 'called Paseo', 'time', 'times'],
];

export const toolLabel = (name?: string) => {
  const parts = String(name || '').split('__');
  if (parts[0] !== 'mcp' || parts.length < 3) return name;
  return `${parts[1] === 'cocopilot' ? 'coco' : parts[1]}.${parts.slice(2).join('__')}`;
};

// stored calls name their detail kind; older logs only their tool name
export const kindOf = (call: ActivityEvent) => (call.kind && call.kind !== 'unknown' ? call.kind : NAME_KIND[String(call.name || '').toLowerCase()] || 'unknown');

const isPaseoTool = (name: string) => {
  const parts = name.split('__').filter(Boolean);
  if (parts.length >= 3 && parts[0] === 'mcp') return parts[1] === 'paseo' || parts[1].startsWith('paseo_');
  return name.startsWith('paseo_') || /^paseo(_\w+)?\./.test(name);
};

export function countCalls(calls: ActivityEvent[]): CallCounts {
  const edited = new Set<string | undefined>();
  const read = new Set<string | undefined>();
  const counts: CallCounts = { editedFiles: 0, commands: 0, readFiles: 0, searches: 0, otherTools: 0, paseoCalls: 0 };
  for (const c of calls) {
    const kind = kindOf(c);
    const name = String(c.name || '').trim().toLowerCase();
    if (isPaseoTool(name)) counts.paseoCalls++;
    else if (kind === 'edit' || kind === 'write') edited.add(c.summary || c.input || c.id);
    else if (kind === 'shell') counts.commands++;
    else if (kind === 'read') read.add(c.summary || c.input || c.id);
    else if (kind === 'search' || SEARCH_NAME.test(name)) counts.searches++;
    else counts.otherTools++;
  }
  return { ...counts, editedFiles: edited.size, readFiles: read.size };
}

const GROUPS: Record<string, string> = { shell: 'bash', read: 'read', edit: 'edit', write: 'write', search: 'search', fetch: 'fetch' };
// Paseo names an MCP tool "server / tool"; coco's own logs keep the mcp__server__tool form
const mcpServer = (name?: string) => {
  const raw = String(name ?? '');
  if (raw.includes(' / ')) return raw.split(' / ')[0];
  const named = toolLabel(name);
  return named?.includes('.') ? named.split('.')[0] : '';
};
// the tool a call belongs to, for the log's rows per tool: bash, read, edit, search, fetch, an MCP server (cocopilot), the browser
export const callGroupOf = (call: ActivityEvent) => {
  const server = mcpServer(call.name);
  if (server) return server;
  if (/^browser_/.test(String(call.name ?? ''))) return 'browser';
  return GROUPS[kindOf(call)] || String(call.name ?? '') || kindOf(call);
};
// calls grouped by the tool they used, in the order their tools first appear; mcp: an MCP server's calls, counted rather than tallied
export function groupCallsByTool(calls: ActivityEvent[]) {
  const out: { name: string; calls: ActivityEvent[]; counts: CallCounts; mcp: boolean }[] = [];
  for (const c of calls) {
    const name = callGroupOf(c);
    const hit = out.find((g) => g.name === name);
    if (hit) hit.calls.push(c);
    else out.push({ name, calls: [c], counts: countCalls([c]), mcp: Boolean(mcpServer(c.name)) });
  }
  for (const g of out) g.counts = countCalls(g.calls);
  return out;
}


// "4 commands, 1 file" — the counts alone, for a row that already names the tool
export function tallyLabel(counts: CallCounts) {
  return PHRASES.map(([key, , one, many]) => (counts[key] ? `${counts[key]} ${counts[key] === 1 ? one : many}` : '')).filter(Boolean).join(', ');
}
// "Ran 1 command and used 1 other tool", "Edited 2 files, ran 1 command, and read 3 files"
export function callsLabel(counts: CallCounts) {
  const parts = PHRASES.filter(([k]) => counts[k] > 0).map(([k, verb, one, many]) => `${verb} ${counts[k]} ${counts[k] === 1 ? one : many}`);
  const text = parts.length < 3 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

// events: a conversation's stored and live events in order; a tool event repeating an id updates that call in place, a legacy tool_result fills the call before it.
// Text and thinking deltas stream until their finished event replaces them. active: the agent is mid-turn, so running calls and streamed thinking show as running.
// A permission request carries its answer once one is logged.
// Items: { kind: 'tools', calls, counts, label, running } · { kind: 'think', text, running } · { kind: 'live', text } · { kind: 'permission', event, resolution } · { kind: 'event', event }
export function groupActivity(events: ActivityEvent[] | null | undefined, { active = false } = {}): ActivityItem[] {
  const calls = new Map<string, ActivityEvent>();
  const merged: ActivityEvent[] = [];
  for (const ev of events || []) {
    const known = ev.id ? calls.get(ev.id) : undefined;
    if (ev.type === 'tool' && known) Object.assign(known, ev);
    else if (ev.type === 'tool') {
      const call = { ...ev };
      if (ev.id) calls.set(ev.id, call);
      merged.push(call);
    } else if (ev.type === 'tool_result') {
      const last = merged.at(-1);
      if (last?.type === 'tool') last.output ||= ev.text;
    } else merged.push(ev);
  }
  const items: ActivityItem[] = [];
  let text = '';
  let think = '';
  for (const ev of merged) {
    if (ev.type === 'delta') text += ev.text;
    else if (ev.type === 'think_delta') think += ev.text;
    else if (ev.type === 'thread') continue;
    else if (ev.type === 'permission') items.push({ kind: 'permission', event: ev });
    else if (ev.type === 'permission_resolved') {
      const asked = items.findLast((it) => it.kind === 'permission' && it.event.request?.id === ev.requestId);
      if (asked?.kind === 'permission') asked.resolution = ev.resolution ?? null;
    } else if (ev.type === 'tool') {
      const last = items.at(-1);
      if (last?.kind === 'tools') last.calls.push(ev);
      else items.push({ kind: 'tools', calls: [ev], counts: countCalls([ev]), label: '', running: false });
    } else if (ev.type === 'think') {
      think = '';
      const last = items.at(-1);
      if (last?.kind === 'think') last.text += `\n\n${ev.text}`;
      else items.push({ kind: 'think', text: ev.text ?? '', running: false });
    } else {
      if (ev.type === 'text') text = '';
      if (ev.type === 'end' || ev.type === 'closed') text = think = '';
      items.push({ kind: 'event', event: ev });
    }
  }
  for (const it of items) {
    if (it.kind !== 'tools') continue;
    it.counts = countCalls(it.calls);
    it.label = callsLabel(it.counts);
    it.running = active && it.calls.some((c) => c.status === 'running');
  }
  if (think) items.push({ kind: 'think', text: think, running: active });
  if (text) items.push({ kind: 'live', text });
  return items;
}
