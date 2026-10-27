import { useEffect, useState } from 'react';
import { useWork } from '../workbench/use-work.ts';
import { loadReview, reviewApi } from '../workbench/code/use-comments.ts';
import { keyLabel } from '../workbench/code/ids.ts';
import { useStackFix } from '../workbench/code/StackFix.tsx';
import type { StackFixRunRow } from '../workbench/types.ts';
import { Header } from './AgentTab.tsx';
import { Loading } from './pages/Page.tsx';
import { RunInfo, RunLog, RunStatus, RunTab, useRunAgent, useTabActive } from './RunView.tsx';

const short = (sha?: string) => (sha ? sha.slice(0, 9) : '…');

function Row({ row, i }: { row: StackFixRunRow; i: number }) {
  return (
    <div className="dp-run-row">
      <span className="dp-run-n dp-num">{i + 1}</span>
      <span className="dp-chip">{keyLabel(row.key)}</span>
      <code className="dp-ell" title={row.branch}>{row.branch}</code>
      <span className="dp-t3 dp-run-rc">{row.commentIds.length} comments</span>
      <span className="dp-sp" />
      {row.restacked && <span className="dp-chip dp-info">restacked</span>}
      {row.error && <span className="dp-chip dp-bad dp-run-err" title={row.error}>{row.error.slice(0, 80)}</span>}
      <code className="dp-t3 dp-run-tips">{short(row.tipBefore)} → {short(row.tipAfter)}</code>
    </div>
  );
}

// stack-<run>: one agent fixing comments across the stack, bottom row first
export default function StackRunView({ tabId }: { tabId: string }) {
  const { slug } = useWork();
  const id = tabId.slice(6);
  const active = useTabActive(tabId);
  const { runs } = useStackFix(slug, active);
  const run = runs.find((r) => r.id === id);
  const [brief, setBrief] = useState<string | null>(null);
  const done = run && run.status !== 'running';
  const { listed, state } = useRunAgent(slug, run?.agentId, run?.status || 'running');
  useEffect(() => { reviewApi.stackFixBrief(slug, id).then(setBrief); }, [slug, id]);
  useEffect(() => { if (run && done) run.rows.forEach((r) => loadReview(slug, r.key)); }, [done]);

  if (!run) return <div className="dp-tabview"><Loading what="Loading the stack fix…" /></div>;
  const chips = <>
    <span className="dp-chip">{run.mode}</span>
    {listed && <RunStatus status={run.status} />}
    {run.pushWarned && <span className="dp-chip dp-bad">remote head moved</span>}
  </>;
  return (
    <RunTab
      header={<Header title={`Stack fix ${id}`} kind="stack fix" pr={null} state={state} agentId={run.agentId ?? null} metrics={listed} chips={chips} />}
      info={(
        <RunInfo run={run} brief={brief} facts={[`${run.rows.length} rows`, run.commits === 'squash' ? 'one commit per row' : 'one commit per comment']}>
          <div className="dp-run-rows">{run.rows.map((row, i) => <Row key={row.key} row={row} i={i} />)}</div>
        </RunInfo>
      )}
      agentId={run.agentId}
      state={state}
      who={listed?.kind || 'stack fix'}
      log={<RunLog id={id} load={() => reviewApi.stackFixLogs(slug, id)} live={active && !done} />}
    />
  );
}
