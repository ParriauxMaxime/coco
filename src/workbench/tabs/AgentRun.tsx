import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from '../../components/Markdown.tsx';
import Collapsible from '../../components/Collapsible.tsx';
import { useWork } from '../use-work.ts';
import { useWorkbench } from '../workbench-store.ts';
import { reviewApi, useReviewStore, findRun, putRuns } from '../code/use-comments.ts';
import { keyLabel } from '../code/ids.ts';

const POLL_MS = 5000;

export default function AgentRun({ tabId }) {
  const { slug, prs } = useWork();
  const runId = tabId.slice(6);
  const run = useReviewStore((s) => findRun(slug, runId, s.prs));
  const active = useWorkbench((s) => s.groups.some((g) => g.active === tabId));
  const [out, setOut] = useState('');
  const [brief, setBrief] = useState(null);
  const [missing, setMissing] = useState(false);
  const pre = useRef(null);
  const n = run?.number;

  useEffect(() => {
    if (run) return;
    let live = true;
    Promise.all(prs.filter((p) => p.key).map((p) => reviewApi.runs(slug, p.key).then((r) => putRuns(slug, p.key, r.runs || [])).catch(() => {})))
      .then(() => live && !findRun(slug, runId) && setMissing(true));
    return () => { live = false; };
  }, [slug, runId, prs.length]);

  useEffect(() => {
    if (!n) return undefined;
    reviewApi.brief(slug, n, runId).then(setBrief);
  }, [slug, n, runId]);

  const done = run?.status === 'done';
  useEffect(() => {
    if (!n || !active) return undefined;
    let live = true;
    const tick = async () => {
      const [runs, logs] = await Promise.all([done ? null : reviewApi.runs(slug, n).catch(() => null), reviewApi.logs(slug, n, runId).catch((e) => ({ out: e.message }))]);
      if (!live) return;
      if (runs) putRuns(slug, n, runs.runs || []);
      setOut(logs.out || '');
    };
    tick();
    if (done) return () => { live = false; };
    const t = setInterval(tick, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [slug, n, runId, active, done]);

  useLayoutEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [out]);

  if (!run) return <div className="sub">{missing ? `Run ${runId} not found in this work.` : 'Loading run…'}</div>;
  return (
    <div className="ar">
      <div className="row">
        <b>Review run <code>{runId}</code> · {keyLabel(run.number)}</b>
        <span className="chip c-grey">{run.mode}</span>
        <span className={`chip ${done ? 'c-green' : 'c-orange'}`}>{run.status}</span>
        {run.pushWarned && <span className="chip c-red">remote head moved</span>}
        {run.pushedByUser && <span className="chip c-green">pushed</span>}
      </div>
      <div className="status" style={{ margin: '4px 0 8px' }}>
        started {new Date(run.startedAt).toLocaleString()}{run.finishedAt ? ` · finished ${new Date(run.finishedAt).toLocaleTimeString()}` : ''} · {run.commentIds.length} comments · {run.commits === 'squash' ? 'one squash commit' : 'one commit per comment'} · {run.provider} · agent <code>{(run.agentId || '?').slice(0, 8)}</code>{run.cwd ? <> · <code>{run.cwd}</code></> : null}
      </div>
      {brief && <Collapsible title="Brief sent to the agent" badge={run.briefPath?.split('/').pop()}><Markdown text={brief} /></Collapsible>}
      <h3>Logs {done ? '' : '· live every 5 s'}</h3>
      <pre ref={pre} className="ar-log">{out || '…'}</pre>
    </div>
  );
}
