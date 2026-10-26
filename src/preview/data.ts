import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { usePendingPermissions } from '../components/PermissionCard.tsx';
import { stateKey } from '../components/PrBadge.tsx';
import { useWorkData } from '../workbench/use-work.ts';
import type { LoadedWork } from '../workbench/use-work.ts';
import type { FindingsResponse, LinkedAgent, Overview, PendingPermission } from '../types.ts';
import type { WorkPr } from '../workbench/types.ts';

export type PreviewData = {
  slug: string;
  work: LoadedWork;
  prs: WorkPr[];
  overview: Overview | null;
  findings: FindingsResponse | null;
  agents: LinkedAgent[];
  pending: PendingPermission[];
};

export const prKey = (pr: WorkPr) => String(pr.key ?? pr.number ?? pr.planned?.branch ?? pr.head ?? '');
export const prState = (pr: WorkPr) => {
  const s = stateKey(pr);
  return s === 'ready' ? 'review' : s;
};
export const prTitle = (pr: WorkPr) => pr.title || pr.planned?.title || pr.head || 'Untitled';
export const agentsOf = (d: PreviewData, pr: WorkPr) => d.agents.filter((a) => String(a.key) === prKey(pr));
export const findingsOf = (d: PreviewData, pr: WorkPr) => (d.findings?.rows || []).filter((f) => String(f.n) === prKey(pr) && f.status === 'open');
export const pendingOf = (d: PreviewData, pr: WorkPr) => {
  const ids = new Set(agentsOf(d, pr).map((a) => a.agentId));
  return d.pending.filter((p) => ids.has(p.agentId));
};

export function usePreviewData(slug: string): PreviewData {
  const work = useWorkData(slug);
  const { pending } = usePendingPermissions();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [findings, setFindings] = useState<FindingsResponse | null>(null);
  const [agents, setAgents] = useState<LinkedAgent[]>([]);
  useEffect(() => {
    const load = () => {
      api.overview().then(setOverview, () => {});
      api.findings(slug, null).then(setFindings, () => {});
      api.linkedAgents(slug).then(setAgents, () => {});
    };
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [slug]);
  return { slug, work, prs: work.prs, overview, findings, agents, pending };
}
