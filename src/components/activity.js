// An agent's activity grouped the way Paseo's timeline groups it: consecutive tool calls between two other items fold into one row,
// thinking is its own row, anything else (text, blocks, user messages, notes) passes through untouched.
const NAME_KIND = { bash: 'shell', read: 'read', edit: 'edit', multiedit: 'edit', notebookedit: 'edit', write: 'write', grep: 'search', glob: 'search', websearch: 'search', webfetch: 'fetch' };
const SEARCH_NAME = /(?:^|[_.:/])(?:web_search|llm_context)$/;
const PHRASES = [
  ['editedFiles', 'edited', 'file', 'files'],
  ['commands', 'ran', 'command', 'commands'],
  ['readFiles', 'read', 'file', 'files'],
  ['searches', 'searched', 'time', 'times'],
  ['otherTools', 'used', 'other tool', 'other tools'],
  ['paseoCalls', 'called Paseo', 'time', 'times'],
];

// stored calls name their detail kind; older logs only their tool name
export const kindOf = (call) => (call.kind && call.kind !== 'unknown' ? call.kind : NAME_KIND[String(call.name || '').toLowerCase()] || 'unknown');

const isPaseoTool = (name) => {
  const parts = name.split('__').filter(Boolean);
  if (parts.length >= 3 && parts[0] === 'mcp') return parts[1] === 'paseo' || parts[1].startsWith('paseo_');
  return name.startsWith('paseo_') || /^paseo(_\w+)?\./.test(name);
};

export function countCalls(calls) {
  const edited = new Set();
  const read = new Set();
  const counts = { editedFiles: 0, commands: 0, readFiles: 0, searches: 0, otherTools: 0, paseoCalls: 0 };
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

// "Ran 1 command and used 1 other tool", "Edited 2 files, ran 1 command, and read 3 files"
export function callsLabel(counts) {
  const parts = PHRASES.filter(([k]) => counts[k] > 0).map(([k, verb, one, many]) => `${verb} ${counts[k]} ${counts[k] === 1 ? one : many}`);
  const text = parts.length < 3 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

// events: a conversation's stored and live events in order; a tool event repeating an id updates that call in place, a legacy tool_result fills the call before it.
// Text and thinking deltas stream until their finished event replaces them. active: the agent is mid-turn, so running calls and streamed thinking show as running.
// Items: { kind: 'tools', calls, counts, label, running } · { kind: 'think', text, running } · { kind: 'live', text } · { kind: 'event', event }
export function groupActivity(events, { active = false } = {}) {
  const calls = new Map();
  const merged = [];
  for (const ev of events || []) {
    if (ev.type === 'tool' && ev.id && calls.has(ev.id)) Object.assign(calls.get(ev.id), ev);
    else if (ev.type === 'tool') {
      const call = { ...ev };
      if (ev.id) calls.set(ev.id, call);
      merged.push(call);
    } else if (ev.type === 'tool_result') {
      const last = merged.at(-1);
      if (last?.type === 'tool') last.output ||= ev.text;
    } else merged.push(ev);
  }
  const items = [];
  let text = '';
  let think = '';
  for (const ev of merged) {
    if (ev.type === 'delta') text += ev.text;
    else if (ev.type === 'think_delta') think += ev.text;
    else if (ev.type === 'thread') continue;
    else if (ev.type === 'tool') {
      const last = items.at(-1);
      if (last?.kind === 'tools') last.calls.push(ev);
      else items.push({ kind: 'tools', calls: [ev] });
    } else if (ev.type === 'think') {
      think = '';
      const last = items.at(-1);
      if (last?.kind === 'think') last.text += `\n\n${ev.text}`;
      else items.push({ kind: 'think', text: ev.text, running: false });
    } else {
      if (ev.type === 'text') text = '';
      if (ev.type === 'end' || ev.type === 'closed') text = think = '';
      items.push({ kind: 'event', event: ev });
    }
  }
  for (const it of items.filter((x) => x.kind === 'tools')) {
    it.counts = countCalls(it.calls);
    it.label = callsLabel(it.counts);
    it.running = active && it.calls.some((c) => c.status === 'running');
  }
  if (think) items.push({ kind: 'think', text: think, running: active });
  if (text) items.push({ kind: 'live', text });
  return items;
}
