import React, { useState } from 'react';
import Markdown from '../../components/Markdown.tsx';
import Collapsible from '../../components/Collapsible.tsx';
import Thread, { ThreadToggle, threadKey, useThreadsOf } from '../../components/Thread.tsx';
import { useWork } from '../use-work.ts';
import { useWorkbench } from '../workbench-store.ts';
import { useLocal } from '../tabs/Code.tsx';
import { DecisionCard } from '../tabs/Decisions.tsx';
import { isLive } from '../../../server/decisions.ts';
import { Confidence, Severity } from '../../components/Signals.tsx';
import { CommentActions, WatchActions, remarkVerdicts, setStatus } from './CommentZone.tsx';
import { reviewApi } from './use-comments.ts';
import { toast } from '../../components/Toast.tsx';
import { errorMessage } from '../../api.ts';
import { useAction, pendingClass } from '../../components/action.ts';
import ReviewPlan from './ReviewPlan.tsx';
import { CHIP } from './ReviewSidebar.tsx';
import type { ReactNode } from 'react';
import type { ReviewHandle } from './use-comments.ts';
import type { Decision } from '../../types.ts';
import type { PrKey, Proposal, ReviewComment, ReviewRun } from '../types.ts';
import './code.css';

type Jump = (c: ReviewComment) => void;
type Item = { id: string; ts: string; open: boolean; hot: boolean; rank?: number } & (
  | { kind: 'watch'; wp: Proposal }
  | { kind: 'comment'; c: ReviewComment }
  | { kind: 'decision'; d: Decision }
);

const MODE: Record<string, string> = { send: 'c-purple', cwd: 'c-blue', 'checkout-pr': 'c-grey' };
const FILTERS = ['all', 'open', 'to review'];
const SEVERITY_RANK: Record<string, number> = { blocking: 0, major: 1, minor: 2, nit: 3, undefined: 2 };
const fail = (e: unknown) => toast.error(errorMessage(e));
const latest = (...ts: (string | undefined)[]) => ts.filter(Boolean).sort().at(-1) || '';
const since = (iso?: string) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const lines = (c: ReviewComment) => `L${c.startLine}${c.endLine !== c.startLine ? `–${c.endLine}` : ''}`;

function Loc({ c, onJump, children }: { c: ReviewComment; onJump: Jump; children?: ReactNode }) {
  return (
    <button type="button" className="rv-wp-loc" title={`${c.path} · jump`} onClick={() => onJump(c)}>
      <b>{c.path.split('/').pop()}</b>
      <span className={`rv-wp-lines ${c.status || ''}`}>{lines(c)}</span>
      {children}
    </button>
  );
}

function Excerpt({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  return <div className={`rv-excerpt${full ? ' full' : ''}`} onClick={() => setFull(!full)}><Markdown text={text} /></div>;
}

// coco's watch point: accept, dismiss, or talk it over with a scoped agent (which accepts it as a comment)
function WatchRow({ wp, rv, onJump, onDispatch }: { wp: Proposal; rv: ReviewHandle; onJump: Jump; onDispatch: (key: string) => void }) {
  return (
    <div className="rv-wp">
      <div className="rv-act-h"><span className="chip c-purple">coco suggests</span><Severity value={wp.severity} /><Confidence value={wp.confidence} /><span className="cc-spacer" /></div>
      <Loc c={wp} onJump={onJump} />
      <Excerpt text={wp.body} />
      <WatchActions wp={wp} rv={rv} onJump={onJump} onDispatched={onDispatch} />
    </div>
  );
}

function CommentRow({ c, rv, slug, open, onToggle, onJump, ts }: { c: ReviewComment; rv: ReviewHandle; slug: string; open: boolean; onToggle: () => void; onJump: Jump; ts: string }) {
  const key = threadKey.comment(rv.n, c.id);
  return (
    <div className={`rv-cm ${c.status} ${c.status === 'outdated' ? 'off' : ''}`}>
      <div className="rv-act-h">
        <span className={`chip ${CHIP[c.status] || 'c-grey'}`}>{c.status}</span>
        <Severity value={c.severity} />
        <Confidence value={c.confidence} />
        {c.side === 'base' && <span className="chip c-grey">base</span>}
        <span className="cc-spacer" />
        <span className="status">{since(ts)}</span>
      </div>
      <Loc c={c} onJump={onJump} />
      <Excerpt text={c.body} />
      {c.resolution?.note && <div className="status">{c.resolution.commit ? `${String(c.resolution.commit).slice(0, 7)} · ` : ''}{c.resolution.note}</div>}
      <CommentActions
        comment={c}
        onJump={onJump}
        onStatus={(x, status, note) => setStatus(rv, x, status, note).catch(fail)}
        onDelete={(x) => confirm('Delete this comment?') && rv.remove(x.id).catch(fail)}
        thread={<ThreadToggle slug={slug} threadKey={key} open={open} onClick={onToggle} />}
      />
      {open && <Thread slug={slug} threadKey={key} onSettled={rv.load} verdicts={remarkVerdicts(c, (x, status, note) => setStatus(rv, x, status, note).catch(fail))} />}
    </div>
  );
}

type DecisionRowProps = { d: Decision; slug: string; open: boolean; onToggle: () => void; ts: string; onDecide: (body: Record<string, unknown>) => Promise<void>; onReply: () => unknown };

function DecisionRow({ d, slug, open, onToggle, ts, onDecide, onReply }: DecisionRowProps) {
  const key = threadKey.decision(d.id);
  const taken = d.status === 'taken';
  return (
    <div className={`rv-dc ${open ? 'on' : ''}`}>
      <button type="button" className="rv-dc-h" onClick={onToggle}>
        <span className={`chip ${taken ? 'c-green' : 'c-orange'}`}>{taken ? 'taken' : 'decision'}</span>
        <b>{d.title}</b>
        <span className="cc-spacer" />
        <span className="status">{since(ts)}</span>
      </button>
      {!open && <ThreadToggle slug={slug} threadKey={key} open={false} onClick={onToggle} />}
      {open && <DecisionCard d={d} slug={slug} onDecide={onDecide} onReply={onReply} talk />}
    </div>
  );
}

function RunRow({ run, slug, n, onPushed }: { run: ReviewRun; slug: string; n: PrKey; onPushed: () => unknown }) {
  const { busy, run: go } = useAction();
  const openLogs = () => {
    const s = useWorkbench.getState();
    s.open(`agent-${run.runId}`, { group: s.otherGroup() });
  };
  return (
    <div className="rv-row">
      <div className="rv-row-h">
        <code className="rv-loc">{run.runId.slice(0, 8)}</code>
        <span className={`chip ${MODE[run.mode] || 'c-grey'}`}>{run.mode}</span>
        <span className={`chip ${CHIP[run.status] || 'c-grey'}`}>{run.status}</span>
        {run.pushWarned && <span className="chip c-red">remote head moved</span>}
      </div>
      <div className="rv-row-h">
        <button type="button" className="cc-link" onClick={openLogs}>open logs</button>
        {!run.pushedByUser && <button type="button" className={`cc-link${pendingClass(busy)}`} disabled={busy} onClick={() => go('pushed', () => reviewApi.pushed(slug, n, run.runId).then(onPushed))}>I pushed</button>}
      </div>
    </div>
  );
}

// right pane of the Review tab: coco's plan, then watch points, comments and the work's decisions, latest activity first
export default function ReviewActivity({ slug, n, rv, onJump }: { slug: string; n: PrKey; rv: ReviewHandle; onJump: Jump }) {
  const { w, decide, load } = useWork();
  const { summaries } = useThreadsOf(slug);
  const [filter, setFilter] = useLocal('cc.act.filter', 'all');
  const [prOnly, setPrOnly] = useLocal('cc.act.pr', false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const toggle = (key: string) => setOpenKey(openKey === key ? null : key);
  const hot = (key: string) => Boolean(summaries[key]?.waiting) || (summaries[key]?.open ?? 0) > 0;
  const planTs = rv.plan?.plan?.createdAt ?? '';

  const items: Item[] = [
    // watch points share the plan's time: the worst and surest first
    ...rv.proposals.map((wp): Item => ({ id: wp.id, kind: 'watch', ts: planTs, rank: SEVERITY_RANK[wp.severity ?? 'undefined'] * 1000 - (wp.confidence ?? 50), open: true, hot: false, wp })),
    ...rv.comments.map((c): Item => {
      const key = threadKey.comment(n, c.id);
      return { id: key, kind: 'comment', ts: latest(c.createdAt, c.updatedAt, summaries[key]?.lastTs), open: c.status === 'open' || c.status === 'sent', hot: hot(key), c };
    }),
    ...(w.decisions || []).filter((d) => isLive(d) && (!prOnly || String(d.pr) === String(n))).map((d): Item => {
      const key = threadKey.decision(d.id);
      return { id: key, kind: 'decision', ts: latest(d.decidedAt ?? undefined, summaries[key]?.lastTs), open: d.status !== 'taken', hot: hot(key), d };
    }),
  ]
    .filter((x) => filter === 'all' || (filter === 'open' ? x.open : x.hot))
    .sort((a, b) => b.ts.localeCompare(a.ts) || (a.rank ?? 0) - (b.rank ?? 0));

  return (
    <aside className="rv-act">
      <ReviewPlan rv={rv} />
      <div className="rv-act-bar">
        <span className="rv-seg">{FILTERS.map((f) => <button key={f} type="button" className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f}</button>)}</span>
        <label className="status" title="Only decision cards whose pr field is this PR"><input type="checkbox" checked={prOnly} onChange={(e) => setPrOnly(e.target.checked)} /> decisions of this PR</label>
      </div>
      <div className="rv-act-feed">
        {!items.length && <div className="sub">{filter === 'all' ? 'Nothing yet. Drag in the line numbers of a diff, or select lines and press c, to comment.' : `Nothing ${filter}.`}</div>}
        {items.map((x) =>
          x.kind === 'watch' ? <WatchRow key={x.id} wp={x.wp} rv={rv} onJump={onJump} onDispatch={setOpenKey} />
            : x.kind === 'comment' ? <CommentRow key={x.id} c={x.c} rv={rv} slug={slug} ts={x.ts} open={openKey === x.id} onToggle={() => toggle(x.id)} onJump={onJump} />
              : <DecisionRow key={x.id} d={x.d} slug={slug} ts={x.ts} open={openKey === x.id} onToggle={() => toggle(x.id)} onDecide={decide} onReply={load} />)}
        {rv.runs.length > 0 && (
          <Collapsible level="pm" title={`Agent runs · ${rv.runs.length}`}>
            {rv.runs.map((run) => <RunRow key={run.runId} run={run} slug={slug} n={n} onPushed={rv.load} />)}
          </Collapsible>
        )}
      </div>
    </aside>
  );
}
