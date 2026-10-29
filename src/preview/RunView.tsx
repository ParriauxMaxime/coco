import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from '../components/Markdown.tsx';
import { errorMessage } from '../api.ts';
import { useShownInterval } from '../resource.ts';
import { useWork } from '../workbench/use-work.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import { findRun, putRuns, reviewApi, useReviewStore } from '../workbench/code/use-comments.ts';
import { AgentTranscript, Header } from './AgentTab.tsx';
import { useWaitingByAgent } from './waiting.ts';
import { stateOf, useWorkAgent } from './agents.ts';
import type { AgentState } from './agents.ts';
import Icon from './Icon.tsx';
import { Empty, Loading } from './pages/Page.tsx';
import { stamp } from './format.ts';
import './run.css';

export const POLL_MS = 5000;
const TONE: Record<string, string> = { running: 'dp-warn', done: 'dp-ok', failed: 'dp-bad' };

export const RunStatus = ({ status }: { status: string }) => <span className={`dp-chip ${TONE[status] || ''}`} title="The run's status; the label after it is its agent's">run {status}</span>;
export const useTabActive = (tabId: string) => useWorkbench((s) => s.groups.some((g) => g.active === tabId));

// the run's agent as the work lists it (usage included), else its state from the run
export function useRunAgent(slug: string, agentId: string | undefined, status: string) {
  const listed = useWorkAgent(slug, agentId ? `ag-${agentId}` : '');
  const waiting = useWaitingByAgent();
  if (listed) return { listed, state: stateOf(listed, waiting) };
  const state: AgentState = status === 'running' ? (agentId && waiting[agentId] ? 'waiting' : 'running') : status === 'failed' ? 'failed' : 'done';
  return { listed, state };
}

type Run = { startedAt: string; finishedAt?: string; commits: string; provider: string; agentId?: string; cwd?: string; briefPath?: string };

// what the run was started with, its rows, and the brief it got, folded
export function RunInfo({ run, facts, brief, children }: { run: Run; facts: React.ReactNode[]; brief: string | null; children?: React.ReactNode }) {
  const all = [`started ${stamp(run.startedAt)}`, run.finishedAt && `finished ${stamp(run.finishedAt)}`, ...facts, run.provider, run.agentId && <>agent <code>{run.agentId.slice(0, 8)}</code></>, run.cwd && <code className="dp-run-cwd" title={run.cwd}>{run.cwd}</code>].filter(Boolean);
  return (
    <div className="dp-run-info">
      <div className="dp-run-facts">{all.map((f, i) => <span key={i}>{f}</span>)}</div>
      {children}
      {brief && (
        <details className="dp-run-brief">
          <summary><Icon name="chevron-right" size={12} className="dp-run-caret" />Brief sent to the agent{run.briefPath && <code className="dp-ell">{run.briefPath.split('/').pop()}</code>}</summary>
          <div className="dp-run-md"><Markdown text={brief} /></div>
        </details>
      )}
    </div>
  );
}

// the agent's last log lines from Paseo, for a run with no timeline to replay
export function RunLog({ id, load, live }: { id: string; load: () => Promise<{ out?: string }>; live: boolean }) {
  const [out, setOut] = useState('');
  const pre = useRef<HTMLPreElement>(null);
  const at = useRef(id);
  at.current = id;
  const tick = () => load().then((l) => at.current === id && setOut(l.out || ''), (e) => at.current === id && setOut(errorMessage(e)));
  useEffect(() => { void tick(); }, [id, live]);
  useShownInterval(tick, POLL_MS, live);
  useLayoutEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [out]);
  return (
    <section className="dp-run-logs">
      <div className="dp-run-lh">Logs{live ? ' · live every 5 s' : ''}</div>
      <pre ref={pre} className="dp-run-log">{out || '…'}</pre>
    </section>
  );
}

// a run's tab: its header, then the agent's transcript under the run info, or the info and Paseo's logs when there is no agent to follow
export function RunTab({ header, info, agentId, state, who, log }: { header: React.ReactNode; info: React.ReactNode; agentId?: string; state: AgentState; who: string; log: React.ReactNode }) {
  return (
    <div className="dp-tabview dp-agtab">
      {header}
      {agentId ? <AgentTranscript agentId={agentId} state={state} who={who} lead={info} fallback={log} /> : <div className="dp-agent-log">{info}<Empty icon="bot">No agent started for this run yet.</Empty></div>}
    </div>
  );
}

// agent-<run>: a review fix run on one PR
export default function RunView({ tabId }: { tabId: string }) {
  const { slug, prs } = useWork();
  const runId = tabId.slice(6);
  const run = useReviewStore((s) => findRun(slug, runId, s.prs));
  const active = useTabActive(tabId);
  const [brief, setBrief] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const n = run?.number;
  const done = run?.status === 'done';
  const { listed, state } = useRunAgent(slug, run?.agentId, run?.status || 'running');

  useEffect(() => {
    if (run) return undefined;
    let live = true;
    Promise.all(prs.flatMap((p) => (p.key ? [p.key] : [])).map((key) => reviewApi.runs(slug, key).then((r) => putRuns(slug, key, r.runs || [])).catch(() => {})))
      .then(() => live && !findRun(slug, runId) && setMissing(true));
    return () => { live = false; };
  }, [slug, runId, prs.length]);

  useEffect(() => {
    if (n) reviewApi.brief(slug, n, runId).then(setBrief);
  }, [slug, n, runId]);

  useShownInterval(() => n && reviewApi.runs(slug, n).then((r) => putRuns(slug, n, r.runs || []), () => {}), POLL_MS, Boolean(n && active && !done));

  if (!run) return <div className="dp-tabview">{missing ? <Empty icon="bot">Run {runId} is not in this work.</Empty> : <Loading what="Loading the run…" />}</div>;
  const chips = <>
    <span className="dp-chip">{run.mode}</span>
    {listed && <RunStatus status={run.status} />}
    {run.pushWarned && <span className="dp-chip dp-bad">remote head moved</span>}
    {run.pushedByUser && <span className="dp-chip dp-ok">pushed</span>}
  </>;
  return (
    <RunTab
      header={<Header title={`Review run ${runId}`} kind="review fix" pr={String(run.number)} state={state} agentId={run.agentId ?? null} metrics={listed} chips={chips} />}
      info={<RunInfo run={run} brief={brief} facts={[`${run.commentIds.length} comments`, run.commits === 'squash' ? 'one squash commit' : 'one commit per comment']} />}
      agentId={run.agentId}
      state={state}
      who={listed?.kind || 'review fix'}
      log={<RunLog id={runId} load={() => reviewApi.logs(slug, run.number, runId)} live={active && !done} />}
    />
  );
}
