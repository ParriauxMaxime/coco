import React, { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from '../../components/Markdown.tsx';
import { FindingBody } from '../../components/Blocks.tsx';
import Collapsible from '../../components/Collapsible.tsx';
import Thread, { ThreadComposer, refreshThreads, threadKey } from '../../components/Thread.tsx';
import { Confidence, Severity } from '../../components/Signals.tsx';
import { CodeRefScope } from '../../components/CodeRefs.tsx';
import { toast } from '../../components/Toast.tsx';
import { pendingClass } from '../../components/action.ts';
import { api } from '../../api.ts';
import { useWork } from '../use-work.ts';
import { useWorkbench } from '../workbench-store.ts';
import { openCodeAt, useLocal } from './Code.tsx';
import { findingsKeyOfTab, keyLabel } from '../code/ids.ts';
import { CHIP } from '../code/ReviewSidebar.tsx';
import { FixDialog, StackRunLink, openStackRun, useStackFix } from '../code/StackFix.tsx';
import '../code/code.css';

const RANK = { blocking: 0, major: 1, minor: 2, nit: 3 };
const VIEWS = ['left', 'all', 'dismissed'];
const GROUP_BY = ['spot', 'file', 'pr', 'reviewer'];
const STATUS_CHIP = { ...CHIP, new: 'c-purple', accepted: 'c-blue', dismissed: 'c-grey' };
const REVIEWERS = { personas: 'c-purple', me: 'c-blue', agents: 'c-grey', team: 'c-green', ci: 'c-red' };
// any other group the server sends is a bot group (botGroups in the config)
const chipOf = (g) => REVIEWERS[g] || 'c-orange';
const NAMED = ['personas', 'agents', 'team'];
const showName = (g, name) => NAMED.includes(g) || (g !== 'me' && g !== 'ci' && String(name).toLowerCase() !== g.toLowerCase());
const SPOT_SLACK = 5;
const day = (iso) => (iso ? iso.slice(0, 10) : '');
const order = (a, b) => (RANK[a.severity] ?? 2) - (RANK[b.severity] ?? 2) || (b.confidence ?? -1) - (a.confidence ?? -1) || String(b.ts).localeCompare(String(a.ts));
// waiting on the user: not accepted, dismissed or settled yet; its body stays open
const untriaged = (r) => r.status === 'new' || (r.status === 'open' && !r.accepted);
const live = (r) => ['new', 'open', 'sent', 'outdated', 'accepted'].includes(r.status);
const statusOf = (r) => (r.status === 'open' && r.accepted && r.source !== 'local' ? 'accepted' : r.status);
// how a row looks while the server answers; the real rows replace it
const OPTIMISTIC = {
  accept: (r) => ({ ...r, status: 'open', accepted: true }),
  dismiss: (r, reason) => ({ ...r, status: 'dismissed', dismissed: { at: new Date().toISOString(), reason } }),
  reopen: (r) => ({ ...r, status: r.commentId ? 'open' : 'new', accepted: false, dismissed: undefined }),
};
const DONE = { accept: 'Accepted', dismiss: 'Dismissed', reopen: 'Reopened' };
const FADE_MS = 300;
const FLASH_MS = 1200;
const NONE = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "1-3, 5, 7" → [1, 2, 3, 5, 7]
const parsePick = (text) => text.split(/[\s,]+/).filter(Boolean).flatMap((part) => {
  const [a, b] = part.split('-').map(Number);
  if (!Number.isInteger(a)) return [];
  return Number.isInteger(b) ? Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i) : [a];
});

// same PR, same file, line ranges at most SPOT_SLACK lines apart: one spot raised by several reviewers
function spots(rows) {
  const out = [];
  let cur = null;
  const byPlace = [...rows].sort((a, b) => String(a.n).localeCompare(String(b.n)) || String(a.path).localeCompare(String(b.path)) || (a.line || 0) - (b.line || 0));
  for (const r of byPlace) {
    if (cur && r.path && r.line && cur.n === r.n && cur.path === r.path && r.line <= cur.end + SPOT_SLACK) {
      cur.rows.push(r);
      cur.end = Math.max(cur.end, r.endLine || r.line);
    } else {
      cur = { n: r.n, path: r.path, end: r.path && r.line ? r.endLine || r.line : -Infinity, rows: [r] };
      out.push(cur);
    }
  }
  return out.map((g) => ({ key: g.rows[0].key, rows: g.rows.sort(order) })).sort((a, b) => order(a.rows[0], b.rows[0]));
}

const SECTION = {
  file: (r) => r.path || '(no file)',
  pr: (r) => (r.n == null ? 'stack' : keyLabel(r.n)),
  reviewer: (r) => `${r.by.name} · ${day(r.ts)}`,
};
function sections(rows, by) {
  const out = new Map();
  for (const r of [...rows].sort(order)) {
    const title = SECTION[by](r);
    if (!out.has(title)) out.set(title, []);
    out.get(title).push(r);
  }
  return [...out].map(([title, list]) => ({ title, rows: list }));
}

const Reviewer = ({ by }) => (
  <span className="fd-src" title={`${by.group}: ${by.name}`}>
    <span className={`chip ${chipOf(by.group)}`}>{by.group === 'personas' ? 'persona' : by.group === 'agents' ? 'agent' : by.group}</span>
    {showName(by.group, by.name) && <span className="fd-who-name">{by.name}</span>}
  </span>
);

// every reviewer that raised something in this view, by who triggered it; a click hides or shows a reviewer, the group label all of its reviewers
function ReviewerStrip({ rows, hidden, setHidden }) {
  const groups = [...new Set([...Object.keys(REVIEWERS), ...rows.map((r) => r.by.group)])].map((g) => {
    const counts = new Map();
    for (const r of rows.filter((x) => x.by.group === g)) counts.set(r.source, { name: r.by.name, count: (counts.get(r.source)?.count || 0) + 1 });
    return [g, [...counts]];
  }).filter(([, list]) => list.length);
  const toggle = (sources, show) => setHidden(show ? hidden.filter((s) => !sources.includes(s)) : [...new Set([...hidden, ...sources])]);
  return (
    <div className="fd-bar">
      {groups.map(([g, list]) => {
        const sources = list.map(([s]) => s);
        const off = sources.every((s) => hidden.includes(s));
        return (
          <span key={g} className="fd-who">
            <button type="button" className={`chip rv-cat ${off ? 'off' : chipOf(g)}`} title={off ? `show every ${g} reviewer` : `hide every ${g} reviewer`} onClick={() => toggle(sources, off)}>{g}</button>
            {list.length > 1 || showName(g, list[0][1].name)
              ? list.map(([s, { name, count }]) => <button key={s} type="button" className={`chip rv-cat ${hidden.includes(s) ? 'off' : 'c-grey'}`} onClick={() => toggle([s], hidden.includes(s))}>{name} {count}</button>)
              : <span className="status">{list[0][1].count}</span>}
          </span>
        );
      })}
    </div>
  );
}

// bottom of an unfolded finding: its agent thread with the composer open, accept / dismiss / reopen beside Dispatch
function Footer({ r, slug, verdicts, focus, onAct, pending }) {
  const [sending, setSending] = useState(false);
  if (r.commentId) return <div className="fd-foot"><Thread slug={slug} threadKey={threadKey.comment(r.n, r.commentId)} verdicts={verdicts} autoFocus={focus} onSettled={() => refreshThreads(slug)} /></div>;
  // no comment yet: Dispatch accepts it as one, then opens its thread with the text
  const dispatch = async (text, model) => {
    setSending(true);
    try {
      const row = (await onAct('accept', [r.key]))?.rows.find((x) => x.key === r.key);
      if (!row?.commentId) return false;
      await api.postThread(slug, threadKey.comment(row.n, row.commentId), { text, ...(model ? { model } : {}) });
      refreshThreads(slug);
    } catch (e) {
      toast.error(e.message);
      return false;
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="fd-foot thread">
      {r.path && r.n != null && r.status === 'new'
        ? <ThreadComposer withModel busy={Boolean(pending) || sending} pending={sending ? 'send' : pending} sendLabel="Accept & dispatch" verdicts={verdicts} autoFocus={focus} placeholder="Ask a scoped agent about it or for a fix; Dismiss uses this text as its reason (markdown, ⌘↵)" onSend={dispatch} />
        : <div className="row" style={{ gap: 6 }}><span className="cc-spacer" />{verdicts.map((v) => <button key={v.label} type="button" className={`sm ${v.className || ''}${pendingClass(v.pending)}`} title={v.title} disabled={Boolean(pending)} onClick={() => v.on('')}>{v.label}</button>)}</div>}
    </div>
  );
}

function Row({ i, r, slug, picked, onPick, onAct, pending, leaving = NONE, flash = NONE, related = [], relatedOpen = false, onRelated, nested = false }) {
  const [body, setBody] = useState(null);
  const [focus, setFocus] = useState(false);
  const showBody = body ?? untriaged(r);
  const group = [r, ...related];
  const toAccept = group.filter(untriaged).map((x) => x.key);
  const toDismiss = group.filter(live).map((x) => x.key);
  const all = related.length ? ` all ${group.length}` : '';
  const jump = () => openCodeAt(slug, r.n, r.path, r.line, { group: useWorkbench.getState().otherGroup() });
  const status = statusOf(r);
  // the action in flight on this row, if any: its button spins, the others wait
  const inFlight = pending?.keys.has(r.key) ? pending.action : null;
  const verdicts = [
    toAccept.length > 0 && { label: `✓ Accept${all}`, className: 'primary', allowEmpty: true, pending: inFlight === 'accept', title: r.path ? 'Accept: an open local comment to fix' : 'Accept: marked to fix', on: () => onAct('accept', toAccept) },
    toDismiss.length > 0 && { label: `✕ Dismiss${all}`, allowEmpty: true, pending: inFlight === 'dismiss', title: 'Dismiss: the text box is the reason, asked when empty', on: (text) => onAct('dismiss', toDismiss, text || undefined) },
    r.status === 'dismissed' && { label: '↺ Reopen', allowEmpty: true, pending: inFlight === 'reopen', on: () => onAct('reopen', [r.key]) },
  ].filter(Boolean);
  const unfold = () => { setBody(true); setFocus(true); };
  return (
    <div className={`fd-row ${r.status}${nested ? ' nested' : ''}${leaving.has(r.key) ? ' leaving' : ''}${flash.has(r.key) ? ' flash' : ''}`}>
      <label className="fd-pick"><input type="checkbox" checked={picked} onChange={onPick} />{i != null && <b>{i}</b>}</label>
      <Reviewer by={r.by} />
      <span className="fd-sig"><Severity value={r.severity} /><Confidence value={r.confidence} /></span>
      {r.path ? <button type="button" className="fd-loc cc-link" title={`${r.path} · jump to the diff`} onClick={jump}>{r.path.split('/').pop()}{r.line ? `:${r.line}` : ''}</button> : <span className="fd-loc status">{r.n == null ? 'stack' : keyLabel(r.n)}</span>}
      <span className="fd-claimcell">
        <button type="button" className="fd-chev" aria-label={showBody ? 'Fold' : 'Unfold'} onClick={() => setBody(!showBody)}>{showBody ? '▾' : '▸'}</button>
        <button type="button" className="fd-claim" title={showBody ? 'Fold the body' : 'Show the body'} onClick={() => setBody(!showBody)}>{r.claim || '(no text)'}</button>
        {related.length > 0 && <button type="button" className="fd-also" title="Other findings on the same lines" onClick={onRelated}>{relatedOpen ? '▾' : '▸'} +{related.length} · {[...new Set(related.map((x) => x.by.name))].join(', ')}</button>}
      </span>
      <span className="fd-st"><span className={`chip ${STATUS_CHIP[status] || 'c-grey'}`}>{status}</span></span>
      <span className="fd-acts">
        {!showBody && toAccept.length > 0 && <button type="button" className={`cc-ib ok${pendingClass(inFlight === 'accept')}`} disabled={Boolean(inFlight)} title={`Accept${all}`} onClick={() => onAct('accept', toAccept)}>✓</button>}
        {!showBody && toDismiss.length > 0 && <button type="button" className={`cc-ib no${pendingClass(inFlight === 'dismiss')}`} disabled={Boolean(inFlight)} title={`Dismiss${all} with a one-line reason`} onClick={() => onAct('dismiss', toDismiss)}>✕</button>}
        {!showBody && r.status === 'dismissed' && <button type="button" className={`cc-ib${pendingClass(inFlight === 'reopen')}`} disabled={Boolean(inFlight)} title="Reopen" onClick={() => onAct('reopen', [r.key])}>↺</button>}
        {r.url && <a className="cc-ib" href={r.url} target="_blank" rel="noreferrer" title="Open on GitHub">↗</a>}
        {!showBody && (r.commentId || (r.path && r.status === 'new')) && <button type="button" className="thread-toggle" title="Unfold and write to a scoped agent" onClick={unfold}>💬 dispatch</button>}
      </span>
      {showBody && <div className="fd-body">{r.blocks ? <FindingBody r={r} /> : <Markdown text={r.body} />}{r.resolution?.note && <div className="status">{r.resolution.commit ? `${String(r.resolution.commit).slice(0, 7)} · ` : ''}{r.resolution.note}</div>}</div>}
      {r.dismissed && <div className="fd-body status">dismissed on {day(r.dismissed.at)}{r.dismissed.reason ? `: ${r.dismissed.reason}` : ''}</div>}
      {showBody && <div className="fd-body"><Footer r={r} slug={slug} verdicts={verdicts} focus={focus} onAct={onAct} pending={inFlight} /></div>}
    </div>
  );
}

// a spot: its worst finding on top, the other reviewers' findings on the same lines folded under it; accept or dismiss acts on the whole spot
function Spot({ i, g, picked, onPick, ...rest }) {
  const [more, setMore] = useState(false);
  const [head, ...related] = g.rows;
  const keys = g.rows.map((r) => r.key);
  return (
    <div className="fd-spot">
      <Row {...rest} i={i} r={head} picked={keys.every((k) => picked.has(k))} onPick={() => onPick(keys)} related={related} relatedOpen={more} onRelated={() => setMore(!more)} />
      {more && related.map((r) => <Row {...rest} key={r.key} r={r} nested picked={picked.has(r.key)} onPick={() => onPick([r.key])} />)}
    </div>
  );
}

// every remark on a PR (or the whole stack) in one list: what is left to fix, grouped by spot by default, worst first
export default function Findings({ tabId }) {
  const { slug } = useWork();
  const n = findingsKeyOfTab(tabId);
  const [data, setData] = useState(null);
  // the toast's Undo calls act() from an older render: read the rows through a ref
  const latest = useRef(data);
  latest.current = data;
  const [error, setError] = useState('');
  // { action, keys: Set, bulk }: the one action in flight; rows fading out; rows just changed
  const [pending, setPending] = useState(null);
  const [leaving, setLeaving] = useState(NONE);
  const [flash, setFlash] = useState(NONE);
  const busy = pending !== null;
  const [view, setView] = useLocal('cc.fd.view', 'left');
  const [groupBy, setGroupBy] = useLocal('cc.fd.group', 'spot');
  // CI failures are kept but not findings: hidden until asked for
  const [hidden, setHidden] = useLocal('cc.fd.hidden', ['ci']);
  const [picked, setPicked] = useState(() => new Set());
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const [fixing, setFixing] = useState(false);
  const stackFix = useStackFix(slug, true);
  const pr = n == null ? null : String(n);

  const load = (fresh) => api.findings(slug, pr, fresh).then((d) => { setData(d); setError(''); }, (e) => setError(e.message));
  // the saved board first, then the live one: a stale answer never replaces a live one that came back sooner
  useEffect(() => {
    setData(null);
    api.findings(slug, pr, false, true).then((d) => d.stale && setData((prev) => prev ?? d), () => {});
    load();
  }, [slug, pr]);

  const left = data?.left || [];
  const inView = useMemo(() => (data?.rows || []).filter((r) => (view === 'all' ? true : view === 'dismissed' ? r.status === 'dismissed' : left.includes(r.status))), [data, view]);
  const shown = useMemo(() => inView.filter((r) => !hidden.includes(r.source)), [inView, hidden]);
  const grouped = useMemo(() => (groupBy === 'spot' ? spots(shown) : sections(shown, groupBy)), [shown, groupBy]);
  // what "pick 1-3" counts: spots, or rows in the order the sections list them
  const numbered = useMemo(() => (groupBy === 'spot' ? grouped.map((g) => g.rows.map((r) => r.key)) : grouped.flatMap((s) => s.rows.map((r) => [r.key]))), [grouped, groupBy]);
  const dismissed = view === 'left' ? (data?.rows || []).filter((r) => r.status === 'dismissed' && !hidden.includes(r.source)).sort(order) : [];
  const byKey = useMemo(() => new Map((data?.rows || []).map((r) => [r.key, r])), [data]);

  // reason: the dismiss text typed in a finding's composer; asked when missing
  // the rows change at once (a dismissed or reopened one fades out of its list first); the server's answer replaces them, or the old rows come back on error
  const act = async (action, keys, given, { bulk = false } = {}) => {
    if (!keys.length || busy) return null;
    const reason = action !== 'dismiss' ? '' : given ?? prompt(`Dismiss ${keys.length} finding${keys.length > 1 ? 's' : ''}: one-line reason`);
    if (reason === null) return null;
    const set = new Set(keys);
    const prev = latest.current;
    setPending({ action, keys: set, bulk });
    const answer = api.findingAction(slug, { action, keys, reason, pr }).then((next) => ({ next }), (e) => ({ error: e }));
    if (action !== 'accept') {
      setLeaving(set);
      await sleep(FADE_MS);
      setLeaving(NONE);
    }
    setData((d) => ({ ...d, rows: d.rows.map((r) => (set.has(r.key) ? OPTIMISTIC[action](r, reason) : r)) }));
    if (action === 'accept') {
      setFlash(set);
      setTimeout(() => setFlash((f) => (f === set ? NONE : f)), FLASH_MS);
    }
    const { next, error: failed } = await answer;
    setPending(null);
    if (failed) {
      setData(prev);
      toast.error(failed.message);
      return null;
    }
    setData(next);
    stackFix.reload();
    setNote((next.pruned || []).map((p) => (p.outcome === 'pruned' ? `agent of group ${p.group} pruned` : p.outcome === 'left' ? `left group ${p.group}, its agent stays for ${p.others} other item(s)` : `agent kept: ${p.reason}`)).join(' · '));
    setPicked(new Set());
    setPick('');
    toast.success(`${DONE[action]} ${keys.length} finding${keys.length > 1 ? 's' : ''}`, action === 'reopen' ? {} : { undo: () => act('reopen', keys) });
    return next;
  };
  const togglePick = (keys) => setPicked((prev) => {
    const next = new Set(prev);
    const on = keys.every((k) => next.has(k));
    for (const k of keys) on ? next.delete(k) : next.add(k);
    return next;
  });
  const applyPick = (text) => {
    setPick(text);
    setPicked(new Set(parsePick(text).flatMap((i) => numbered[i - 1] || [])));
  };

  if (error) return <div className="card danger">{error}</div>;
  if (!data) return <div className="sub">Collecting findings…</div>;
  const counts = shown.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
  const chosen = [...picked].map((k) => byKey.get(k)).filter(Boolean);
  const rowProps = { slug, onAct: act, pending, leaving, flash };
  const bulkPending = (action) => pendingClass(pending?.bulk && pending.action === action);
  const toFix = stackFix.open.reduce((sum, r) => sum + (r.accepted || 0), 0);
  const lastRun = stackFix.runs[0];
  const openRun = (id) => openStackRun(id, useWorkbench.getState().otherGroup());
  let i = 0;
  return (
    <CodeRefScope n={n ?? undefined}>
      <div className="fd">
        <div className="fd-bar">
          <b>Findings · {n == null ? 'stack' : keyLabel(n)}</b>
          {['new', 'open', 'sent'].filter((k) => counts[k]).map((k) => <span key={k} className={`chip ${STATUS_CHIP[k]}`}>{counts[k]} {k}</span>)}
          {groupBy === 'spot' && grouped.length < shown.length && <span className="status">{grouped.length} spots</span>}
          {data.stale && <span className="status"><span className="spinner" aria-hidden /> refreshing · saved {new Date(data.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
          <span className="cc-spacer" />
          {lastRun && <StackRunLink run={lastRun} onOpen={openRun} />}
          <button type="button" className="sm primary" disabled={!toFix || lastRun?.status === 'running'} title="One agent fixes every accepted, still open finding of the stack, with your notes and threads" onClick={() => setFixing(true)}>Fix accepted ({toFix})</button>
          <span className="rv-seg">{GROUP_BY.map((v) => <button key={v} type="button" className={groupBy === v ? 'on' : ''} onClick={() => setGroupBy(v)}>{v}</button>)}</span>
          <span className="rv-seg">{VIEWS.map((v) => <button key={v} type="button" className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v}</button>)}</span>
          <button type="button" className="sm" disabled={busy} onClick={() => load(true)}>↻</button>
        </div>
        {fixing && <FixDialog slug={slug} open={stackFix.open} select="accepted" onClose={() => setFixing(false)} onSent={(run) => { setFixing(false); stackFix.reload(); load(true); openRun(run.id); }} />}
        <ReviewerStrip rows={inView} hidden={hidden} setHidden={setHidden} />
        <div className="fd-bar">
          <span className="cc-spacer" />
          <input className="fd-pickbox" value={pick} placeholder="pick 1-3, 5, 7" onChange={(e) => applyPick(e.target.value)} />
          <button type="button" className={`sm primary${bulkPending('accept')}`} disabled={busy || !chosen.some(untriaged)} onClick={() => act('accept', chosen.filter(untriaged).map((r) => r.key), undefined, { bulk: true })}>Accept {chosen.filter(untriaged).length || ''}</button>
          <button type="button" className={`sm${bulkPending('dismiss')}`} disabled={busy || !chosen.some(live)} onClick={() => act('dismiss', chosen.filter(live).map((r) => r.key), undefined, { bulk: true })}>Dismiss {chosen.filter(live).length || ''}</button>
        </div>
        {data.errors?.length > 0 && <div className="status danger">{data.errors.join(' · ')}</div>}
        {note && <div className="status">{note}</div>}
        {!shown.length && <div className="sub">{view === 'left' ? 'Nothing left: every finding is fixed, declined or dismissed.' : 'No finding.'}</div>}
        {groupBy === 'spot'
          ? <div className="fd-list">{grouped.map((g) => <Spot key={g.key} {...rowProps} i={++i} g={g} picked={picked} onPick={togglePick} />)}</div>
          : grouped.map((s) => (
            <div key={s.title} className="fd-section">
              <div className="fd-section-title">{s.title} <span className="status">{s.rows.length}</span></div>
              <div className="fd-list">{s.rows.map((r) => <Row {...rowProps} key={r.key} i={++i} r={r} picked={picked.has(r.key)} onPick={() => togglePick([r.key])} />)}</div>
            </div>
          ))}
        {dismissed.length > 0 && (
          <Collapsible level="pm" title={`Dismissed · ${dismissed.length}`}>
            <div className="fd-list">{dismissed.map((r) => <Row key={r.key} {...rowProps} r={r} picked={false} onPick={() => {}} />)}</div>
          </Collapsible>
        )}
      </div>
    </CodeRefScope>
  );
}
