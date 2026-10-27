import React, { useEffect, useState } from 'react';
import { subscribe, topic } from '../live.ts';
import { useWork } from '../workbench/use-work.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import { Log } from './chat/Composer.tsx';
import Conversation from './chat/Conversation.tsx';
import { SUBAGENT_LABEL, SubagentDot, took } from './chat/SubagentCall.tsx';
import Icon from './Icon.tsx';
import Modal from './Modal.tsx';
import { useWorkAgent } from './agents.ts';
import { isRunning, openSubagent, parseSubTab, subagentLabel, useNow, useSubagents } from './subagents.ts';
import type { Subagent } from './subagents.ts';
import type { ActivityEvent } from '../types.ts';

function Pill({ s, now, onOpen }: { s: Subagent; now: number; onOpen: (s: Subagent) => void }) {
  return (
    <button type="button" className={`dp-sa-pill${isRunning(s) ? '' : ' dp-sa-past'}`} title={`${subagentLabel(s)} · ${SUBAGENT_LABEL[s.status]}${s.subtitle ? ` · ${s.subtitle}` : ''}`} onClick={() => onOpen(s)}>
      <SubagentDot status={s.status} />
      <span className="dp-ell">{subagentLabel(s)}</span>
      <span className="dp-sa-time">{took(s, now)}</span>
    </button>
  );
}

function useSubagentEvents(parent: string, sub: string) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  useEffect(
    () =>
      subscribe(topic('subagent', parent, sub), {
        open: () => setEvents([]),
        message: (ev: ActivityEvent) => setEvents((prev) => [...prev, ev]),
      }),
    [parent, sub],
  );
  return events;
}

function SubagentTranscript({ parent, sub }: { parent: string; sub: Subagent }) {
  const events = useSubagentEvents(parent, sub.id);
  return (
    <Log size={events.length}>
      {events.length ? <Conversation run={{ id: sub.id, prompt: '' }} events={events} working={isRunning(sub)} who={sub.title || 'subagent'} /> : <div className="dp-cv-note">Loading its transcript…</div>}
    </Log>
  );
}

// the subagents an agent started: a pill per running one, the others folded into "N done"; a pill opens the subagent's tab,
// or its transcript in a dialog where there are no tabs (inline)
export function SubagentBar({ agentId, inline = false }: { agentId: string | null | undefined; inline?: boolean }) {
  const list = useSubagents(agentId);
  const [showDone, setShowDone] = useState(false);
  const [shown, setShown] = useState<Subagent | null>(null);
  const running = list?.filter(isRunning) ?? [];
  const done = list?.filter((s) => !isRunning(s)) ?? [];
  const now = useNow(1000, running.length > 0);
  if (!agentId || !list?.length) return null;
  const open = (s: Subagent) => (inline ? setShown(s) : openSubagent(agentId, s.id));
  const modal = shown && (list.find((s) => s.id === shown.id) ?? shown);
  return (
    <div className="dp-sa-bar" aria-label="Subagents">
      <div className="dp-sa-in">
        <span className="dp-sa-lbl" title="Subagents this agent started"><Icon name="git-fork" size={12} /></span>
        {running.map((s) => <Pill key={s.id} s={s} now={now} onOpen={open} />)}
        {done.length > 0 && (
          <button type="button" className="dp-sa-pill dp-sa-fold" aria-expanded={showDone} onClick={() => setShowDone((o) => !o)}>
            {done.length} done<Icon name="chevron-right" size={12} className={`dp-sa-caret${showDone ? ' dp-open' : ''}`} />
          </button>
        )}
        {showDone && done.map((s) => <Pill key={s.id} s={s} now={now} onOpen={open} />)}
      </div>
      {modal && (
        <Modal wide title={<span className="dp-row"><SubagentDot status={modal.status} />{subagentLabel(modal)}</span>} onClose={() => setShown(null)} foot={<button type="button" className="dp-btn" onClick={() => setShown(null)}>Close</button>}>
          <div className="dp-sa-modal"><SubagentTranscript parent={agentId} sub={modal} /></div>
        </Modal>
      )}
    </div>
  );
}

// sub-<parent agent>~<subagent>: a subagent's transcript, read-only, under its status and a way back to the agent that started it
export function SubagentTab({ tabId }: { tabId: string }) {
  const ids = parseSubTab(tabId);
  const { slug } = useWork();
  const list = useSubagents(ids?.parent);
  const parentAgent = useWorkAgent(slug, `ag-${ids?.parent ?? ''}`);
  const s = list?.find((x) => x.id === ids?.sub);
  const now = useNow(1000, s ? isRunning(s) : false);
  if (!ids) return null;
  const sub: Subagent = s ?? { id: ids.sub, parentAgentId: ids.parent, title: null, description: null, status: 'running', createdAt: '', updatedAt: '', toolCallId: null, subtitle: null };
  return (
    <div className="dp-tabview dp-agtab">
      <div className="dp-vbar dp-ag-bar">
        {s ? <SubagentDot status={s.status} /> : <Icon name="git-fork" size={14} />}
        <span className="dp-title dp-ell">{s ? subagentLabel(s) : `Subagent ${ids.sub.slice(-8)}`}</span>
        <span className="dp-chip">subagent</span>
        {s && <span className="dp-xs dp-t3 dp-sa-nowrap">{SUBAGENT_LABEL[s.status]} · {took(s, now)}</span>}
        <span className="dp-sp" />
        {s?.subtitle && <span className="dp-xs dp-t3 dp-ell dp-sa-sub">{s.subtitle}</span>}
        <button type="button" className="dp-btn dp-sm dp-sa-back" title="Open the agent that started it" onClick={() => useWorkbench.getState().open(parentAgent?.id ?? `ag-${ids.parent}`)}>
          <Icon name="bot" size={14} /><span className="dp-ell">{parentAgent?.title ?? 'Parent agent'}</span>
        </button>
      </div>
      {list && !s ? <div className="dp-agent-log"><div className="dp-cv-note">Paseo no longer lists this subagent.</div></div> : <SubagentTranscript parent={ids.parent} sub={sub} />}
      <div className="dp-sa-ro">Read-only: it works for its parent agent; to steer it, message that agent.</div>
    </div>
  );
}

// the running subagents of a sidebar agent, indented under it
export function SidebarSubagents({ agentId }: { agentId: string }) {
  const running = useSubagents(agentId)?.filter(isRunning) ?? [];
  const now = useNow(1000, running.length > 0);
  return (
    <>
      {running.map((s) => (
        <div key={s.id} className="dp-view dp-ag dp-sa-row" title={`${subagentLabel(s)} · subagent · working`} onClick={() => openSubagent(agentId, s.id)}>
          <SubagentDot status={s.status} />
          <span className="dp-ell dp-grow">{subagentLabel(s)}</span>
          <span className="dp-ag-ago">{took(s, now)}</span>
        </div>
      ))}
    </>
  );
}

export const SubagentCount = ({ n }: { n: number }) => <span className="dp-sa-count" title={`${n} subagent${n === 1 ? '' : 's'} working`}>⑂ {n}</span>;
