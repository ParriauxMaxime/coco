import React, { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.ts';
import { toast } from '../components/Toast.tsx';
import { useUnsaved } from '../updates.ts';
import { WorkContext } from '../workbench/use-work.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import Icon from './Icon.tsx';
import Modal from './Modal.tsx';
import { fillTone } from './Ring.tsx';
import { ModelControls, useModelChoice } from './chat/ModelPicker.tsx';
import type { AgentHandoffs, AgentInfo, AgentMetrics, Handoff } from '../types.ts';
import './handoff.css';

const POLL_MS = 1500;
const family = (p: string) => p.split('/')[0];
const BUSY = ['summary', 'starting'];
const STEPS: { step: Handoff['step']; label: (h: Handoff) => string }[] = [
  { step: 'summary', label: (h) => (h.source === 'transcript' ? 'No briefing in time: coco briefs it from the conversation' : `Asking ${h.fromTitle} for a briefing`) },
  { step: 'starting', label: () => 'Starting the new agent in the same place' },
  { step: 'done', label: (h) => (h.archived ? 'Done: the new agent took over, this one is archived' : 'Done: the new agent took over') },
];

// an agent's hand-offs, followed while one is under way
function useHandoffs(agentId: string | null) {
  const [data, setData] = useState<AgentHandoffs | null>(null);
  const load = () => (agentId ? api.handoffs(agentId).then(setData, () => {}) : Promise.resolve());
  useEffect(() => {
    setData(null);
    void load();
  }, [agentId]);
  const busy = Boolean(data?.to && BUSY.includes(data.to.step)) || Boolean(data?.to?.step === 'done' && !data.to.archived && data.to.doneAt && Date.now() - Date.parse(data.to.doneAt) < 90_000);
  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [busy, agentId]);
  return { data, setData, load };
}

// another agent: its tab among the work's when in one, else its own page
function AgentLink({ id, children, title }: { id: string; children: React.ReactNode; title: string }) {
  const inWork = Boolean(useContext(WorkContext));
  if (inWork) return <button type="button" className="dp-chip dp-acc dp-ho-link" title={title} onClick={() => useWorkbench.getState().open(`ag-${id}`)}>{children}</button>;
  return <a className="dp-chip dp-acc dp-ho-link" href={`#/agents/${encodeURIComponent(id)}`} title={title}>{children}</a>;
}

// the agent header's hand-off: where it came from, where it went, and the Hand off button (stronger once its context ring is amber or red)
export function HandoffControls({ agentId, metrics, archived }: { agentId: string; metrics?: AgentMetrics | null; archived: boolean }) {
  const { data, setData, load } = useHandoffs(agentId);
  const [open, setOpen] = useState(false);
  const inWork = Boolean(useContext(WorkContext));
  const asked = useRef(false);
  const to = data?.to ?? null;
  const from = data?.from ?? null;
  // the hand-off started here ends on the new agent
  useEffect(() => {
    if (!asked.current || to?.step !== 'done' || !to.to) return;
    asked.current = false;
    setOpen(false);
    toast.success(`Handed off to a new agent${to.source === 'transcript' ? ' (briefed from the transcript)' : ''}`);
    if (inWork) useWorkbench.getState().open(`ag-${to.to}`);
    else location.hash = `#/agents/${encodeURIComponent(to.to)}`;
  }, [to?.step]);
  const pct = metrics?.contextTokens && metrics.contextMax ? Math.round((metrics.contextTokens / metrics.contextMax) * 100) : 0;
  const tone = fillTone(pct);
  const done = to?.step === 'done' && to.to;
  const busy = Boolean(to && BUSY.includes(to.step));
  return (
    <>
      {from && <AgentLink id={from.from} title={`This agent took over from ${from.fromTitle} (${from.from.slice(0, 8)})${from.source === 'transcript' ? ', briefed from its transcript' : ', with its briefing'}: open it`}><Icon name="history" size={12} /><span className="dp-ell">from {from.fromTitle === from.toTitle ? 'the previous agent' : from.fromTitle}</span></AgentLink>}
      {done && <AgentLink id={to.to ?? ''} title={`This agent handed its task to ${to.toTitle ?? 'a new agent'} (${to.to?.slice(0, 8)}): open it`}><span className="dp-ell">Handed off to {to.toTitle && to.toTitle !== to.fromTitle ? to.toTitle : 'a new agent'}</span><Icon name="chevron-right" size={12} /></AgentLink>}
      {busy && <button type="button" className="dp-chip dp-info dp-ho-link" title="See the hand-off's progress" onClick={() => setOpen(true)}><span className="dp-ag-dot dp-ag-running" />Handing off…</button>}
      {to?.step === 'failed' && <button type="button" className="dp-chip dp-bad dp-ho-link" title={to.error ?? 'The hand-off failed'} onClick={() => setOpen(true)}>Hand-off failed</button>}
      {!done && !busy && !archived && (
        <button type="button" className={`dp-btn dp-sm dp-ho-btn${tone ? ` dp-ho-${tone.slice(3)}` : ''}`} title={`Hand this task to a fresh agent: this one writes a briefing, a new one starts in the same place with it, then this one is archived${pct ? ` (context ${pct}% full)` : ''}`} onClick={() => setOpen(true)}>
          <Icon name="send" size={12} /><span className={tone ? '' : 'dp-ho-quiet'}>Hand off</span>
        </button>
      )}
      {open && createPortal(
        <div className="dp dp-float">
          <HandoffDialog agentId={agentId} handoff={busy || to?.step === 'failed' ? to : null} onClose={() => setOpen(false)} onStarted={(h) => { asked.current = true; setData((d) => ({ from: d?.from ?? null, to: h })); void load(); }} />
        </div>,
        document.body,
      )}
    </>
  );
}

type DialogProps = { agentId: string; handoff: Handoff | null; onClose: () => void; onStarted: (h: Handoff) => void };
function HandoffDialog({ agentId, handoff, onClose, onStarted }: DialogProps) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [note, setNote] = useState('');
  useUnsaved(Boolean(note.trim()));
  const [mode, setMode] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.agentInfo(agentId).then((i) => { setInfo(i); setMode(i.mode ?? null); }, (e) => setErr(errorMessage(e)));
  }, [agentId]);
  const model = useModelChoice(null, { live: true, current: info?.provider ? { provider: info.provider, thinking: info.thinking } : null });
  const running = handoff && BUSY.includes(handoff.step) ? handoff : null;
  const go = async () => {
    setSending(true);
    setErr('');
    try {
      const { handoff: h } = await api.handOff(agentId, { ...(note.trim() ? { note: note.trim() } : {}), ...model.body(), ...(mode && mode !== info?.mode ? { mode } : {}) });
      onStarted(h);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setSending(false);
    }
  };
  const at = running ? STEPS.findIndex((s) => s.step === running.step) : -1;
  return (
    <Modal
      title={running ? 'Handing off…' : 'Hand off to a fresh agent'}
      wide
      busy={sending}
      onClose={onClose}
      foot={running ? <button type="button" className="dp-btn" onClick={onClose}>Close</button> : (
        <>
          <button type="button" className="dp-btn" disabled={sending} onClick={onClose}>Cancel</button>
          <button type="button" className="dp-btn dp-primary" disabled={sending || !info} onClick={() => void go()}>{sending ? 'Starting…' : handoff?.step === 'failed' ? 'Try again' : 'Hand off'}</button>
        </>
      )}
    >
      {running ? (
        <ol className="dp-ho-steps">
          {STEPS.map((s, i) => (
            <li key={s.step} className={i < at ? 'dp-ho-past' : i === at ? 'dp-ho-now' : ''}>
              {i < at ? <Icon name="check" size={14} /> : i === at ? <span className="dp-ag-dot dp-ag-running" /> : <span className="dp-ho-dot" />}
              <span>{s.label(running)}</span>
            </li>
          ))}
          <li className="dp-xs dp-t3">You can close this: the hand-off goes on, and this agent's header shows it.</li>
        </ol>
      ) : (
        <>
          <p className="dp-ho-what">{info?.title ?? 'This agent'} writes a briefing for its successor (task, decisions, current state, files touched, next steps, open questions). A new agent then starts in the same place, with the same work, PR and labels, the briefing and your note as its first message, and this one is archived. If no briefing comes within 5 minutes, coco briefs the new agent from the end of this conversation.</p>
          {handoff?.step === 'failed' && <p className="dp-ho-err dp-xs">Last try failed: {handoff.error}</p>}
          <textarea className="dp-inp dp-cd-ta" rows={3} value={note} autoFocus placeholder="Note for the new agent (optional): what to do next, what to drop…" aria-label="Note for the new agent" onChange={(e) => setNote(e.target.value)} />
          <div className="dp-ho-model">
            <span className="dp-xs dp-t3">New agent</span>
            <ModelControls choice={model.choice} onPick={(c) => { if (family(c.provider) !== family(model.choice?.provider ?? '')) setMode(null); model.pick(c); }} hint="for the new agent (same as this one by default)" mode={{ value: mode, onPick: setMode }} disabled={!info} />
          </div>
        </>
      )}
      {err && <p className="dp-ho-err dp-xs">{err}</p>}
    </Modal>
  );
}
