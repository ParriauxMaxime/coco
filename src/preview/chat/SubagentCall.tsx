import React, { useContext, useState } from 'react';
import Markdown from '../../components/Markdown.tsx';
import Icon from '../Icon.tsx';
import { SubagentParent, elapsed, isLaunchNote, isRunning, matchSubagent, openSubagent, readSubagentCall, useNow, useSubagents } from '../subagents.ts';
import type { Subagent, SubagentStatus } from '../subagents.ts';
import type { ActivityEvent } from '../../types.ts';
import '../subagents.css';

export const SUBAGENT_LABEL: Record<SubagentStatus, string> = { running: 'working', completed: 'done', failed: 'failed', canceled: 'stopped' };
const DOT: Record<SubagentStatus, string> = { running: 'running', completed: 'done', failed: 'failed', canceled: 'archived' };
export const SubagentDot = ({ status }: { status: SubagentStatus }) => <span className={`dp-ag-dot dp-ag-${DOT[status]}${status === 'running' ? ' dp-cv-spin' : ''}`} title={SUBAGENT_LABEL[status]} />;
export const took = (s: Subagent, now: number) => elapsed(s.createdAt, isRunning(s) ? now : Date.parse(s.updatedAt));

// an Agent or Task call in a transcript: what it started, where it runs and how it is doing, its brief folded
export default function SubagentCallRow({ c, active }: { c: ActivityEvent; active: boolean }) {
  const parent = useContext(SubagentParent);
  const list = useSubagents(parent);
  const call = readSubagentCall(c);
  const s = matchSubagent(list, { id: c.id, description: call.description });
  const [open, setOpen] = useState<'brief' | 'result' | null>(null);
  const status: SubagentStatus | null = s?.status ?? (c.status === 'failed' ? 'failed' : c.status === 'running' && active ? 'running' : null);
  const now = useNow(1000, status === 'running');
  const result = c.output && !isLaunchNote(c.output) ? c.output : '';
  const toggle = (k: 'brief' | 'result') => setOpen((o) => (o === k ? null : k));
  return (
    <div className="dp-sa-call">
      <div className="dp-sa-callh">
        <Icon name="git-fork" size={12} className="dp-sa-ic" />
        <span className="dp-sa-desc dp-ell" title={call.description || undefined}>{call.description || 'Subagent'}</span>
        {call.type && <span className="dp-chip">{call.type}</span>}
        <span className="dp-chip">{call.background ? 'background' : 'foreground'}</span>
        {status && <span className="dp-sa-st"><SubagentDot status={status} />{SUBAGENT_LABEL[status]}{s && ` · ${took(s, now)}`}</span>}
        <span className="dp-sp" />
        {call.prompt && <button type="button" className={`dp-btn dp-sm dp-sa-tg${open === 'brief' ? ' dp-on' : ''}`} aria-expanded={open === 'brief'} onClick={() => toggle('brief')}>brief</button>}
        {result && <button type="button" className={`dp-btn dp-sm dp-sa-tg${open === 'result' ? ' dp-on' : ''}`} aria-expanded={open === 'result'} onClick={() => toggle('result')}>result</button>}
        {s && parent && <button type="button" className="dp-btn dp-sm dp-sa-open" onClick={() => openSubagent(parent, s.id)}>Open<Icon name="chevron-right" size={12} /></button>}
      </div>
      {open === 'brief' && call.prompt && <div className="dp-sa-brief"><Markdown text={call.prompt} /></div>}
      {open === 'result' && <pre className="dp-cv-pre dp-cv-out">{result}</pre>}
    </div>
  );
}
