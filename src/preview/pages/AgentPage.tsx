import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { AgentTranscript, Header } from '../AgentTab.tsx';
import { usePendingPermissions } from '../chat/Permission.tsx';
import Icon from '../Icon.tsx';
import type { AgentState } from '../agents.ts';
import { ErrorNote, Loading } from './Page.tsx';
import type { AgentInfo } from '../../types.ts';
import './agents-page.css';

const POLL_MS = 5000;

// #/agents/<agentId>: any Paseo agent as a chat, a ritual's or one started outside coco included, with its cards and a composer
export default function AgentPage({ agentId }: { agentId: string }) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [err, setErr] = useState('');
  const { pending } = usePendingPermissions();
  const load = () => api.agentInfo(agentId).then((i) => { setInfo(i); setErr(''); }, (e) => setErr(errorMessage(e)));
  useEffect(() => {
    void load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [agentId]);
  if (!info) return <div className="dp-page dp-agpage" role="main">{err ? <ErrorNote>{err}</ErrorNote> : <Loading what="Reading the agent…" />}</div>;
  const asked = info.openCards > 0 || pending.some((p) => p.agentId === agentId);
  const state: AgentState = info.status !== 'archived' && asked ? 'waiting' : info.status;
  const inWork = info.work && <a className="dp-btn dp-sm" href={`#/work/${encodeURIComponent(info.work)}/ag-${agentId}`} title="Open it among its work's tabs"><Icon name="layers" size={14} />In its work</a>;
  return (
    <div className="dp-page dp-agpage" role="main">
      <section className="dp-agpage-chat">
        <Header title={info.title} kind={info.kind} pr={info.pr} state={state} agentId={agentId} metrics={info} serverId={info.serverId} chips={inWork} />
        <AgentTranscript agentId={agentId} state={state} who={info.kind} inline current={info.provider ? { provider: info.provider, thinking: info.thinking } : null} onSent={() => void load()} />
      </section>
    </div>
  );
}
