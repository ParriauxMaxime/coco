import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Markdown from '../../components/Markdown.jsx';
import Collapsible from '../../components/Collapsible.jsx';
import Thread, { ThreadToggle, threadKey } from '../../components/Thread.jsx';
import { toast } from '../../components/Toast.jsx';
import './code.css';

const RISK = { high: 'c-red', medium: 'c-orange', low: 'c-green' };
const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`;
};

// popover under "coco is planning": thinking summaries, what coco says, the tools it calls; follows the bottom while you have not scrolled up
function PlanningLog({ log, anchor, onClose }) {
  const ref = useRef(null);
  const pinned = useRef(true);
  const box = anchor.getBoundingClientRect();
  useLayoutEffect(() => {
    if (pinned.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log.length]);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    const onDown = (e) => !ref.current?.contains(e.target) && !anchor.contains(e.target) && onClose();
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [anchor, onClose]);
  const onScroll = (e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; };
  // the plan box scrolls and clips: the popover sits on the body, under the button
  return createPortal(
    <div ref={ref} className="rv-think card" style={{ top: box.bottom + 4, left: box.left, width: Math.min(560, innerWidth - box.left - 16) }} onScroll={onScroll}>
      {!log.length && <div className="status">Nothing yet: coco is reading the diff.</div>}
      {log.map((e, i) => (
        <div key={i} className={`rv-think-${e.kind}`}>
          {e.kind === 'tool' ? <code>{e.text}</code> : <Markdown text={e.text} />}
        </div>
      ))}
    </div>,
    document.body,
  );
}

// coco's review plan for the current head: start, progress, summary, surface; its watch points go to the activity feed
export default function ReviewPlan({ rv }) {
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [talking, setTalking] = useState(false);
  const liveRef = useRef(null);
  const closeThinking = useCallback(() => setThinking(false), []);
  const st = rv.plan;
  if (!st) return null;
  const { run, plan } = st;
  const running = run?.status === 'running';
  const failed = run?.status === 'error' && (!plan || run.startedAt > plan.createdAt);
  const start = (guidance) => {
    setBusy(true);
    rv.startPlan(guidance).catch((e) => toast.error(e.message)).finally(() => setBusy(false));
  };
  const key = threadKey.plan(rv.n);
  return (
    <div className="rv-plan">
      <div className="rv-row-h">
        <b>Review plan</b>
        {plan && st.stale && <span className="chip c-orange" title={`planned on ${plan.headSha.slice(0, 7)}`}>head moved</span>}
        <span className="cc-spacer" />
        {plan && rv.slug && <ThreadToggle slug={rv.slug} threadKey={key} open={talking} label="ask or re-plan" onClick={() => setTalking(!talking)} />}
        {!running && <button type="button" className={`sm ${plan && !st.stale ? '' : 'primary'}`} disabled={busy} onClick={() => start()}>{plan ? 'Re-plan' : 'Plan this review'}</button>}
      </div>
      {talking && plan && <Thread slug={rv.slug} threadKey={key} verdicts={running ? [] : [{ label: '↻ Re-plan with this', title: 'Re-run the plan with this text as guidance for coco', on: start }]} />}
      {!plan && !running && !failed && <div className="sub">coco reads the diff and the PR, then proposes a reading path and watch points (1 to 3 min).</div>}
      {running && (
        <div className="rv-plan-run">
          <button ref={liveRef} type="button" className={`rv-plan-live ${thinking ? 'on' : ''}`} title="See what coco is thinking" onClick={() => setThinking(!thinking)}><span className="spinner" aria-hidden /> coco is planning · {ago(run.startedAt)} <span className="caret">{thinking ? '▾' : '▸'}</span></button>
          {run.progress.at(-1) && <code className="rv-plan-step" title={run.progress.join('\n')}>{run.progress.at(-1)}</code>}
          {thinking && liveRef.current && <PlanningLog log={run.log || []} anchor={liveRef.current} onClose={closeThinking} />}
        </div>
      )}
      {failed && <div className="danger rv-plan-err">{run.error || 'plan failed'}</div>}
      {plan && (
        <>
          <div className={`rv-plan-sum${full ? '' : ' clamp'}`} title={full ? '' : 'show all'} onClick={() => setFull(!full)}><Markdown text={plan.summary} /></div>
          {plan.personas.length > 0 && <div className="status">Owners: {plan.personas.join(', ')}</div>}
          {plan.surface.length > 0 && (
            <Collapsible level="pm" title={`Surface · ${plan.surface.length}`}>
              {plan.surface.map((s) => (
                <div key={s.area} className="rv-row">
                  <div className="rv-row-h"><span className={`chip ${RISK[s.risk]}`}>{s.risk}</span><b>{s.area}</b></div>
                  <div className="status">{s.entryPoints}</div>
                  {s.note && <div>{s.note}</div>}
                </div>
              ))}
            </Collapsible>
          )}
        </>
      )}
    </div>
  );
}
