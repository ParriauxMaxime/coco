import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../api.ts';
import { prKey, prTitle } from './data.ts';
import type { PendingPermission, WorkAgent, WorkAgentStatus, WorkAgents } from '../types.ts';
import type { WorkPr } from '../workbench/types.ts';

export type AgentState = 'waiting' | WorkAgentStatus;
export type ListedAgent = WorkAgent & { state: AgentState };
export type AgentGroup = { pr: string | null; label: string; title: string; live: ListedAgent[]; archived: ListedAgent[] };

export const STATE_LABEL: Record<AgentState, string> = { waiting: 'waiting on you', running: 'working', done: 'done', failed: 'failed', archived: 'archived' };
const ORDER: AgentState[] = ['waiting', 'running', 'done', 'failed', 'archived'];

const useAgents = create<{ by: Record<string, WorkAgents> }>(() => ({ by: {} }));
const put = (slug: string, next: WorkAgents) => useAgents.setState((s) => ({ by: { ...s.by, [slug]: next.error ? { agents: s.by[slug]?.agents || [], serverId: s.by[slug]?.serverId ?? null, error: next.error } : next } }));

// the work's agents; live: pushed by the server on each change, else read once
export function useWorkAgents(slug: string, live: boolean): WorkAgents | undefined {
  useEffect(() => {
    if (!live) {
      api.workAgents(slug).then((r) => put(slug, r), () => {});
      return undefined;
    }
    const es = new EventSource(`/api/works/${encodeURIComponent(slug)}/agents/events`);
    es.onmessage = (m) => put(slug, JSON.parse(m.data));
    return () => es.close();
  }, [slug, live]);
  return useAgents((s) => s.by[slug]);
}

const find = (list: WorkAgent[] | undefined, id: string) => list?.find((a) => a.id === id || (a.agentId && id === `ag-${a.agentId}`));
export const agentOf = (slug: string, id: string) => find(useAgents.getState().by[slug]?.agents, id);
export const useWorkAgent = (slug: string, id: string) => useAgents((s) => find(s.by[slug]?.agents, id));
export const useAgentList = (slug: string) => useAgents((s) => s.by[slug]?.agents);
export const useServerId = (slug: string) => useAgents((s) => s.by[slug]?.serverId ?? null);

export const stateOf = (a: WorkAgent, pending: PendingPermission[]): AgentState => (a.agentId && a.status !== 'archived' && pending.some((p) => p.agentId === a.agentId) ? 'waiting' : a.status);
export const paseoLink = (serverId: string | null, agentId: string | null) => (serverId && agentId ? `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}` : null);
export const prLabel = (key: string) => (/^\d+$/.test(key) ? `#${key}` : key.replace(/^b:/, '').replaceAll(':', '/'));

const byState = (a: ListedAgent, b: ListedAgent) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (b.updatedAt || '').localeCompare(a.updatedAt || '');

// Work first, then the PRs in stack order, then rows the stack no longer holds; groups with no agent are left out
export function groupAgents(agents: WorkAgent[], pending: PendingPermission[], prs: WorkPr[]): AgentGroup[] {
  const listed = agents.map((a) => ({ ...a, state: stateOf(a, pending) })).sort(byState);
  const keys = [null, ...prs.map(prKey), ...listed.map((a) => a.pr).filter((k): k is string => k !== null && !prs.some((p) => prKey(p) === k))];
  return [...new Set(keys)].flatMap((key) => {
    const mine = listed.filter((a) => a.pr === key);
    if (!mine.length) return [];
    const pr = key === null ? null : prs.find((p) => prKey(p) === key);
    return [{
      pr: key,
      label: key === null ? 'Work' : prLabel(key),
      title: pr ? prTitle(pr) : '',
      live: mine.filter((a) => a.state !== 'archived'),
      archived: mine.filter((a) => a.state === 'archived'),
    }];
  });
}
