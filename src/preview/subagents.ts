import { createContext, useEffect, useState } from 'react';
import { create } from 'zustand';
import { subscribe, topic } from '../live.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import type { ActivityEvent } from '../types.ts';

// one subagent an agent started itself, as Paseo lists it; id is the tool call that started it
export type SubagentStatus = 'running' | 'completed' | 'failed' | 'canceled';
export type Subagent = { id: string; parentAgentId: string; title: string | null; description: string | null; status: SubagentStatus; createdAt: string; updatedAt: string; toolCallId: string | null; subtitle: string | null };

const useStore = create<{ by: Record<string, Subagent[]> }>(() => ({ by: {} }));
const put = (parent: string) => (d: { subagents?: Subagent[] }) => useStore.setState((s) => ({ by: { ...s.by, [parent]: d.subagents ?? [] } }));

// the parent's subagents, live while some component shows them
export function useSubagents(parent: string | null | undefined) {
  useEffect(() => (parent ? subscribe(topic('subagents', parent), { message: put(parent) }) : undefined), [parent]);
  return useStore((s) => (parent ? s.by[parent] : undefined));
}

export const subTabId = (parent: string, sub: string) => `sub-${parent}~${sub}`;
export function parseSubTab(id: string) {
  const m = /^sub-([^~]+)~(.+)$/.exec(id);
  return m ? { parent: m[1], sub: m[2] } : null;
}
export const openSubagent = (parent: string, sub: string) => useWorkbench.getState().open(subTabId(parent, sub));
export const isRunning = (s: Subagent) => s.status === 'running';
export const subagentLabel = (s: Subagent) => s.description || s.title || 'Subagent';
export const subagentTitle = (parent: string, sub: string) => {
  const s = useStore.getState().by[parent]?.find((x) => x.id === sub);
  return s ? subagentLabel(s) : 'Subagent';
};

// the Paseo agent whose transcript is shown, so an Agent tool call in it can find the subagent it started
export const SubagentParent = createContext<string | null>(null);

export function elapsed(from: string, to = Date.now()) {
  const s = Math.max(0, Math.round((to - Date.parse(from)) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function useNow(ms: number, on = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

// the subagent an Agent/Task call started: by the call id Paseo keeps, else by its description and start time
export function matchSubagent(list: Subagent[] | undefined, call: { id?: string; description?: string | null; at?: string | null }) {
  if (!list?.length) return null;
  const byId = list.find((s) => (call.id && (s.id === call.id || s.toolCallId === call.id)));
  if (byId) return byId;
  const same = list.filter((s) => call.description && s.description === call.description);
  if (!call.at) return same[0] ?? null;
  const at = Date.parse(call.at);
  return same.sort((a, b) => Math.abs(Date.parse(a.createdAt) - at) - Math.abs(Date.parse(b.createdAt) - at))[0] ?? null;
}

const SUBAGENT_TOOLS = ['agent', 'task'];
export const isSubagentCall = (c: ActivityEvent) => c.type === 'tool' && (c.kind === 'sub_agent' || SUBAGENT_TOOLS.includes(String(c.name || '').toLowerCase()));

// a call's input, also when the log cut its JSON short
function field(input: string, key: string) {
  const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"?|true|false)`).exec(input);
  if (!m) return null;
  const raw = m[1];
  if (raw === 'true' || raw === 'false') return raw;
  const body = raw.replace(/^"/, '').replace(/"$/, '').replace(/\\$/, '');
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body;
  }
}
export type SubagentCall = { description: string | null; type: string | null; background: boolean; prompt: string | null };
export function readSubagentCall(c: ActivityEvent): SubagentCall {
  const input = c.input || (c.summary?.startsWith('{') ? c.summary : '') || '';
  return {
    description: field(input, 'description') || (c.kind === 'sub_agent' ? c.summary || null : null),
    type: field(input, 'subagent_type'),
    background: field(input, 'run_in_background') === 'true',
    prompt: field(input, 'prompt'),
  };
}
export const isLaunchNote = (output?: string) => /Async agent launched/.test(output || '');
