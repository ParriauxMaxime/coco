import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { AgentTranscript, Header } from '../AgentTab.tsx';
import { focusCard } from '../chat/Card.tsx';
import { useSeen, useWaitingByAgent } from '../waiting.ts';
import Icon from '../Icon.tsx';
import type { AgentState } from '../agents.ts';
import { ErrorNote, Loading } from './Page.tsx';
import type { AgentInfo } from '../../types.ts';
import './agents-page.css';

const POLL_MS = 5000;
const FIND_MS = 250;
const FIND_FOR_MS = 8000;
// an open card or a permission waiting on the owner, the oldest first as the transcript lists them
const ASKED = '.dp-agpage .dp-cd.dp-attn, .dp-agpage .dp-perm';

// #/agents/<agentId>: any Paseo agent as a chat, a ritual's or one started outside coco included, with its cards and a composer;
// #/agents/<agentId>/waiting scrolls to the first thing it waits on you for once its transcript shows it
export default function AgentPage({ agentId, toWaiting = false }: { agentId: string; toWaiting?: boolean }) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [err, setErr] = useState('');
  const waiting = useWaitingByAgent();
  const seen = useSeen(`agent:${agentId}`);
  const load = () => api.agentInfo(agentId).then((i) => { setInfo(i); setErr(''); }, (e) => setErr(errorMessage(e)));
  useEffect(() => {
    void load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [agentId]);
  const shown = Boolean(info);
  useEffect(() => {
    if (!toWaiting || !shown) return undefined;
    const t0 = Date.now();
    const t = setInterval(() => {
      const el = document.querySelector(ASKED);
      if (el) focusCard(el);
      if (el || Date.now() - t0 > FIND_FOR_MS) clearInterval(t);
    }, FIND_MS);
    return () => clearInterval(t);
  }, [toWaiting, shown, agentId]);
  if (!info) return <div className="dp-page dp-agpage" role="main">{err ? <ErrorNote>{err}</ErrorNote> : <Loading what="Reading the agent…" />}</div>;
  const state: AgentState = info.status !== 'archived' && waiting[agentId] ? 'waiting' : info.status;
  const inWork = info.work && <a className="dp-btn dp-sm" href={`#/work/${encodeURIComponent(info.work)}/ag-${agentId}`} title="Open it among its work's tabs"><Icon name="layers" size={14} />In its work</a>;
  return (
    <div ref={seen} className="dp-page dp-agpage" role="main">
      <section className="dp-agpage-chat">
        <Header title={info.title} kind={info.kind} pr={info.pr} state={state} agentId={agentId} metrics={info} serverId={info.serverId} chips={inWork} handoff />
        <AgentTranscript agentId={agentId} state={state} who={info.kind} inline current={info.provider ? { provider: info.provider, thinking: info.thinking } : null} onSent={() => void load()} />
      </section>
    </div>
  );
}
