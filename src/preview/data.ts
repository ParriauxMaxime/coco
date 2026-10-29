import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { subscribe, topic } from '../live.ts';
import { usePendingPermissions } from './chat/Permission.tsx';
import { itemsOf, useWaiting } from './waiting.ts';
import { stateKey } from '../components/PrBadge.tsx';
import { useWorkData } from '../workbench/use-work.ts';
import { useOverview } from './overview.ts';
import { useDevServers } from '../workbench/tabs/DevServers.tsx';
import type { LoadedWork } from '../workbench/use-work.ts';
import type { FindingsResponse, LinkedAgent, Overview, PendingPermission, WaitingItem } from '../types.ts';
import type { WorkPr } from '../workbench/types.ts';

export type PreviewData = {
  slug: string;
  work: LoadedWork;
  prs: WorkPr[];
  overview: Overview | null;
  findings: FindingsResponse | null;
  agents: LinkedAgent[];
  pending: PendingPermission[];
  // the work's items of the waiting queue
  waiting: WaitingItem[];
  dev: ReturnType<typeof useDevServers>;
};

export const prKey = (pr: WorkPr) => String(pr.key ?? pr.number ?? pr.planned?.branch ?? pr.head ?? '');
export const prState = (pr: WorkPr) => {
  const s = stateKey(pr);
  return s === 'ready' ? 'review' : s;
};
export const isDone = (s: string) => s === 'merged' || s === 'closed' || s === 'landed';
export const prTitle = (pr: WorkPr) => pr.title || pr.planned?.title || pr.head || 'Untitled';
export const agentsOf = (d: PreviewData, pr: WorkPr) => d.agents.filter((a) => String(a.key) === prKey(pr));
export const findingsOf = (d: PreviewData, pr: WorkPr) => (d.findings?.rows || []).filter((f) => String(f.n) === prKey(pr) && f.status === 'open');
export const devOf = (d: PreviewData, pr: WorkPr) => (d.dev.data?.on ? d.dev.rows[prKey(pr)] : undefined);
export const pendingOf =(d: PreviewData, pr: WorkPr) => {
  const ids = new Set(agentsOf(d, pr).map((a) => a.agentId));
  return d.pending.filter((p) => ids.has(p.agentId));
};
export const waitingOf = (d: PreviewData, pr: WorkPr) => d.waiting.filter((i) => i.pr === prKey(pr));

export function usePreviewData(slug: string): PreviewData {
  const work = useWorkData(slug);
  const { pending } = usePendingPermissions();
  const queue = useWaiting();
  const waiting = useMemo(() => itemsOf(queue, slug), [queue, slug]);
  const { ov: overview } = useOverview();
  const [findings, setFindings] = useState<FindingsResponse | null>(null);
  const [agents, setAgents] = useState<LinkedAgent[]>([]);
  const dev = useDevServers(slug);
  useEffect(() => {
    const load = () => {
      api.findings(slug, null).then(setFindings, () => {});
      api.linkedAgents(slug).then(setAgents, () => {});
    };
    load();
    const t = setInterval(load, 30000);
    // the board is served from the last one: the server says when its refresh landed a different one
    const off = subscribe(topic('findings', slug), { message: () => void api.findings(slug, null).then(setFindings, () => {}) });
    return () => { clearInterval(t); off(); };
  }, [slug]);
  return { slug, work, prs: work.prs, overview, findings, agents, pending, waiting, dev };
}
