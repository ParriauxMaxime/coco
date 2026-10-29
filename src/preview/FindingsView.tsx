import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Markdown from '../components/Markdown.tsx';
import { FindingBody } from '../components/Blocks.tsx';
import { CodeRefScope } from '../components/CodeRefs.tsx';
import Thread, { ThreadComposer, refreshThreads, threadKey, useThreadsOf } from '../components/Thread.tsx';
import type { Verdict } from '../components/Thread.tsx';
import { toast } from '../components/Toast.tsx';
import { pendingClass } from '../components/action.ts';
import { api, errorMessage } from '../api.ts';
import { useShownInterval } from '../resource.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import { parseHash } from '../workbench/hash.ts';
import { openCodeAt, useLocal } from '../workbench/tabs/Code.tsx';
import Icon from './Icon.tsx';
import ImportReview from './ImportReview.tsx';
import Modal from './Modal.tsx';
import PrChip, { prLabel } from './PrChip.tsx';
import { StackRunChip, useStackFix } from './StackFixDialog.tsx';
import { Loading } from './pages/Page.tsx';
import { usePhone } from './Shell.tsx';
import { SEVERITIES, ago, sevClass, sevTone, stamp } from './format.ts';
import { prKey, prTitle } from './data.ts';
import type { PreviewData } from './data.ts';
import type { FindingAction, FindingRow, FindingsResponse, UploadRef } from '../types.ts';
import type { WorkPr } from '../workbench/types.ts';
import './findings.css';

type Bucket = 'open' | 'accepted' | 'resolved' | 'dismissed';
const BUCKETS: Bucket[] = ['open', 'accepted', 'resolved', 'dismissed'];
const LIVE = ['new', 'open', 'sent', 'outdated', 'accepted'];
const RANK: Record<string, number> = { blocking: 0, major: 1, minor: 2, nit: 3 };
const SEV_WORD: Record<string, string> = { blocking: 'Blocking', major: 'Major', minor: 'Minor', nit: 'Nit' };
const REVIEWERS = ['personas', 'me', 'agents', 'team', 'ci'];
const DONE: Record<FindingAction, string> = { accept: 'Accepted', dismiss: 'Dismissed', reopen: 'Reopened' };

const rank = (r: FindingRow) => RANK[r.severity || ''] ?? 4;
const nOf = (r: FindingRow) => (r.n == null ? '' : String(r.n));
const titleOf = (r: FindingRow) => r.claim || r.summary || r.body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') || 'Finding';
const loc = (r: FindingRow) => (r.path ? `${r.path.split('/').pop()}${r.line ? `:${r.line}` : ''}` : '');
const byName = (r: FindingRow) => r.by.name || r.source;
const plural = (n: number) => `${n} finding${n === 1 ? '' : 's'}`;

const bucketOf = (r: FindingRow, left: string[]): Bucket => {
  if (r.status === 'dismissed') return 'dismissed';
  if (r.status === 'accepted' || (r.accepted && LIVE.includes(r.status))) return 'accepted';
  return left.includes(r.status) ? 'open' : 'resolved';
};

// "1-3, 5, 7" → [1, 2, 3, 5, 7]
const parsePick = (text: string) => text.split(/[\s,]+/).filter(Boolean).flatMap((part) => {
  const [a, b] = part.split('-').map(Number);
  if (!Number.isInteger(a)) return [];
  return Number.isInteger(b) ? Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i) : [a];
});

type Group = { id: string; head: ReactNode; rows: FindingRow[] };
type Pending = { action: FindingAction; keys: Set<string> };
type Send = (text: string, model?: string, files?: UploadRef[]) => Promise<boolean>;
type Fix = { note?: string; model?: string; attachments?: string[]; together?: boolean };

const commentThread = (r: FindingRow) => (r.commentId && r.n != null ? threadKey.comment(String(r.n), r.commentId) : null);

// where an accepted finding's fix agent stands, from its thread summary
function FixState({ slug, r }: { slug: string; r: FindingRow }) {
  const key = commentThread(r);
  const s = useThreadsOf(slug).summaries[key ?? ''];
  if (!s) return null;
  const [label, tone] = s.asks ? ['asks you', 'dp-warn'] : s.open ? ['commit ready', 'dp-ok'] : s.waiting ? ['working', ''] : [null, ''];
  return label ? <span className={`dp-chip dp-fi-fix ${tone}`}>{label}</span> : null;
}

function Picker({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <label className={`dp-fi-cb${on ? ' dp-on' : ''}`} title={label} onClick={(e) => e.stopPropagation()}>
      <input className="dp-vh" type="checkbox" checked={on} aria-label={label} onChange={onToggle} />
      <span className="dp-check" />
    </label>
  );
}

function ReviewerStrip({ rows, hidden, setHidden }: { rows: FindingRow[]; hidden: string[]; setHidden: (hidden: string[]) => void }) {
  const groups = [...new Set([...REVIEWERS, ...rows.map((r) => r.by.group)])].map((g): [string, [string, { name: string; count: number }][]] => {
    const counts = new Map<string, { name: string; count: number }>();
    for (const r of rows.filter((x) => x.by.group === g)) counts.set(r.source, { name: r.by.name, count: (counts.get(r.source)?.count || 0) + 1 });
    return [g, [...counts]];
  }).filter(([, list]) => list.length);
  if (!groups.length) return null;
  const toggle = (sources: string[], show: boolean) => setHidden(show ? hidden.filter((s) => !sources.includes(s)) : [...new Set([...hidden, ...sources])]);
  return (
    <div className="dp-fi-who">
      <span className="dp-t3">Reviewers</span>
      {groups.map(([g, list]) => {
        const sources = list.map(([s]) => s);
        const off = sources.every((s) => hidden.includes(s));
        const total = list.reduce((n, [, x]) => n + x.count, 0);
        const named = list.length > 1 || list[0][1].name.toLowerCase() !== g.toLowerCase();
        return (
          <span key={g} className="dp-fi-rv">
            <button type="button" className={`dp-fi-rvg ${off ? 'dp-off' : 'dp-on'}`} aria-pressed={!off} title={off ? `Show every ${g} reviewer` : `Hide every ${g} reviewer`} onClick={() => toggle(sources, off)}>
              <Icon name={off ? 'circle-dot' : 'eye'} size={12} />{g}{!named && <span>{total}</span>}
            </button>
            {named && list.map(([s, { name, count }]) => {
              const gone = hidden.includes(s);
              return <button key={s} type="button" className={gone ? 'dp-off' : 'dp-on'} aria-pressed={!gone} title={gone ? `Show ${name}` : `Hide ${name}`} onClick={() => toggle([s], gone)}>{name}<span>{count}</span></button>;
            })}
          </span>
        );
      })}
    </div>
  );
}

function DismissDialog({ count, onClose, onDismiss }: { count: number; onClose: () => void; onDismiss: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={`Dismiss ${plural(count)}`} onClose={onClose} foot={
      <>
        <button type="button" className="dp-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="dp-btn dp-primary" onClick={() => onDismiss(reason.trim())}>Dismiss</button>
      </>
    }>
      <form onSubmit={(e) => { e.preventDefault(); onDismiss(reason.trim()); }}>
        <input className="dp-inp dp-fi-reason" autoFocus value={reason} placeholder="One-line reason" aria-label="Reason" onChange={(e) => setReason(e.target.value)} />
      </form>
      <p className="dp-keep-lead dp-t3">Declines an open comment, dismisses coco’s watch point, or else adds the reason to the review remarks.</p>
    </Modal>
  );
}

type DetailProps = { slug: string; r: FindingRow; bucket: Bucket; pr?: WorkPr; inFlight: FindingAction | null; busy: boolean; onAct: (action: FindingAction) => void; onDismiss: (reason?: string) => void; onDispatch: Send; onSettled: () => void };

function Detail({ slug, r, bucket, pr, inFlight, busy, onAct, onDismiss, onDispatch, onSettled }: DetailProps) {
  const [sending, setSending] = useState(false);
  const structured = Boolean(r.blocks?.length);
  const place = r.path ? `${r.path}${r.line ? `:${r.line}` : ''}` : '';
  const live = bucket === 'open' || bucket === 'accepted';
  const dismissal: Verdict[] = live ? [{ label: 'Dismiss with this reason', title: 'Dismiss the finding, the text as its reason', pending: inFlight === 'dismiss', on: (text) => onDismiss(text) }] : [];
  const verdicts: Verdict[] = bucket === 'open' ? [{ label: 'Accept with this note', title: 'Accept the finding: its fix agent starts with the text as note', pending: inFlight === 'accept', on: (text) => void onDispatch(text) }, ...dismissal] : dismissal;
  const jump = () => r.n != null && r.path && openCodeAt(slug, r.n, r.path, r.line, { group: useWorkbench.getState().otherGroup() });
  const dispatch: Send = async (text, model, files) => {
    setSending(true);
    try {
      return await onDispatch(text, model, files);
    } finally {
      setSending(false);
    }
  };
  return (
    <CodeRefScope n={r.n ?? undefined}>
      <div className="dp-row dp-g4" style={{ flexWrap: 'wrap' }}>
        {r.severity && <span className={`dp-chip ${sevTone(r.severity)}`}><span className="dp-d" />{SEV_WORD[r.severity] || r.severity}</span>}
        {r.confidence !== undefined && Number.isFinite(r.confidence) && <span className="dp-chip">{r.confidence}% sure</span>}
        <span className="dp-chip"><Icon name={r.by.group === 'coco' || r.source === 'coco' ? 'bot' : 'users'} size={12} />{byName(r)}</span>
        {bucket !== 'open' && <span className="dp-chip">{bucket}</span>}
        <span className="dp-sp" />
        <span className="dp-xs dp-t3"><kbd>J</kbd> <kbd>K</kbd> move · <kbd>X</kbd> pick</span>
      </div>
      <h2 className="dp-h1 dp-fi-title">{titleOf(r)}</h2>
      <div className="dp-row dp-g4 dp-xs dp-t3" style={{ flexWrap: 'wrap' }}>
        {pr ? <PrChip pr={pr} /> : r.n != null && <span className="dp-prb">#{r.n}</span>}
        {place && (r.n != null ? <button type="button" className="dp-fi-place dp-mono" title="Open in the diff" onClick={jump}>{place}</button> : <span className="dp-mono dp-fi-place">{place}</span>)}
        {r.ts && <><span className="dp-t4">·</span>found {stamp(r.ts)}</>}
        {r.source && <><span className="dp-t4">·</span>{r.source}</>}
      </div>

      <div className="dp-fi-body">
        {structured ? <FindingBody r={r} /> : (
          <>
            {r.body && <Markdown text={r.body} />}
            {r.recommendation && (
              <>
                <div className="dp-sec-t" style={{ marginTop: 14 }}>Suggested fix</div>
                <Markdown text={r.recommendation} />
              </>
            )}
            {r.sources && r.sources.length > 0 && (
              <div className="dp-xs dp-t3 dp-fi-sources">
                from {r.sources.map((s, i) => <span key={i}>{s.url ? <a href={s.url} target={s.url.startsWith('#') ? undefined : '_blank'} rel="noreferrer">{s.label}</a> : s.label}{s.path && <> <code>{s.path}</code></>}</span>)}
              </div>
            )}
          </>
        )}
        {r.resolution?.note && <div className="dp-xs dp-t3" style={{ marginTop: 10 }}>{r.resolution.commit ? `${String(r.resolution.commit).slice(0, 7)} · ` : ''}{r.resolution.note}</div>}
        {r.dismissed && <div className="dp-xs dp-t3" style={{ marginTop: 10 }}>Dismissed {stamp(r.dismissed.at)}{r.dismissed.reason ? `: ${r.dismissed.reason}` : ''}</div>}
      </div>

      <div className="dp-row dp-fi-actions">
        {bucket === 'open' && <button type="button" className={`dp-btn dp-primary${pendingClass(inFlight === 'accept')}`} disabled={busy} onClick={() => onAct('accept')}><Icon name="check" size={14} />Accept<kbd>A</kbd></button>}
        {live && <button type="button" className={`dp-btn dp-ghost${pendingClass(inFlight === 'dismiss')}`} disabled={busy} onClick={() => onDismiss()}>Dismiss…<kbd>D</kbd></button>}
        {(bucket === 'accepted' || bucket === 'dismissed') && <button type="button" className={`dp-btn${pendingClass(inFlight === 'reopen')}`} disabled={busy} onClick={() => onAct('reopen')}>Reopen</button>}
        {r.url && <a className="dp-btn" href={r.url} target="_blank" rel="noreferrer"><Icon name="external-link" size={14} />Open on GitHub</a>}
      </div>

      {r.commentId && r.n != null ? (
        <div className="dp-fi-thread">
          <div className="dp-sec-t">Agent thread</div>
          <Thread key={r.key} slug={slug} threadKey={threadKey.comment(String(r.n), r.commentId)} verdicts={verdicts} discuss={bucket === 'open'} onSettled={onSettled} />
        </div>
      ) : r.path && r.n != null && r.status === 'new' ? (
        <div className="dp-fi-thread">
          <div className="dp-sec-t">Fix agent</div>
          <ThreadComposer
            key={r.key}
            draft={`finding:${slug}:${r.key}`}
            withModel
            busy={busy || sending}
            pending={sending ? 'send' : inFlight}
            sendLabel="Accept & fix"
            verdicts={dismissal}
            placeholder="Accepts the finding, then a fix agent starts with this text as note; it asks you when unsure and suggests a commit you approve (markdown, ↵)"
            onSend={dispatch}
          />
        </div>
      ) : null}
    </CodeRefScope>
  );
}

type Props = { d: PreviewData; pr?: string; onOpenPr: (key: string) => void; onReload: () => void; onCurrentPr?: (key: string | null) => void };

export default function FindingsView({ d, pr, onOpenPr, onReload, onCurrentPr }: Props) {
  const [board, setBoard] = useState<FindingsResponse | null>(d.findings);
  useEffect(() => { if (d.findings) setBoard(d.findings); }, [d.findings]);
  const rows = board?.rows || [];
  const left = board?.left || ['new', 'open', 'sent', 'outdated'];
  const [status, setStatus] = useState<Bucket>('open');
  const [prFilter, setPrFilter] = useState<string | null>(pr ?? null);
  const [group, setGroup] = useState<'pr' | 'severity'>('pr');
  const [hidden, setHidden] = useLocal<string[]>('cc.fd.hidden', ['ci']);
  const [sel, setSel] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [pick, setPick] = useState('');
  const [importing, setImporting] = useState(false);
  const [asking, setAsking] = useState<string[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const busy = pending !== null;
  const stackFix = useStackFix(d.slug, true);
  const root = useRef<HTMLDivElement>(null);

  const prOf = (n: string) => d.prs.find((p) => prKey(p) === n);
  const at = (k: string) => { const i = d.prs.findIndex((p) => prKey(p) === k); return i < 0 ? 1e6 : i; };
  const shown = useMemo(() => rows.filter((r) => !hidden.includes(r.source)), [rows, hidden]);
  const scoped = useMemo(() => shown.filter((r) => prFilter === null || nOf(r) === prFilter), [shown, prFilter]);
  const bucketCounts = useMemo(() => scoped.reduce<Record<Bucket, number>>((acc, r) => ((acc[bucketOf(r, left)] += 1), acc), { open: 0, accepted: 0, resolved: 0, dismissed: 0 }), [scoped, left.join()]);
  const inStatus = useMemo(() => shown.filter((r) => bucketOf(r, left) === status), [shown, status, left.join()]);
  const prCounts = useMemo(() => inStatus.reduce<Record<string, number>>((acc, r) => ((acc[nOf(r)] = (acc[nOf(r)] || 0) + 1), acc), {}), [inStatus]);
  const visible = useMemo(() => inStatus.filter((r) => prFilter === null || nOf(r) === prFilter).sort((a, b) => rank(a) - rank(b) || (a.ts < b.ts ? 1 : -1)), [inStatus, prFilter]);
  const strip = useMemo(() => rows.filter((r) => bucketOf(r, left) === status && (prFilter === null || nOf(r) === prFilter)), [rows, status, prFilter, left.join()]);

  const groups = useMemo<Group[]>(() => {
    if (group === 'severity') {
      return [...SEVERITIES, ''].map((s) => ({
        id: s || 'none',
        head: <><span className={`dp-sev ${sevClass(s)}`}><i /></span><span className="dp-ell">{SEV_WORD[s] || 'Unrated'}</span></>,
        rows: visible.filter((r) => (SEVERITIES.includes(r.severity || '') ? r.severity === s : s === '')),
      })).filter((g) => g.rows.length);
    }
    return Array.from(new Set(visible.map(nOf))).sort((a, b) => at(a) - at(b)).map((k) => {
      const p = prOf(k);
      return {
        id: k || 'stack',
        head: <>{p ? <PrChip pr={p} onOpen={onOpenPr} /> : k ? <span className="dp-prb">#{k}</span> : null}<span className="dp-ell">{p ? prTitle(p) : k ? '' : 'Whole stack'}</span></>,
        rows: visible.filter((r) => nOf(r) === k),
      };
    });
  }, [visible, group, d.prs]);
  const order = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const current = order.find((r) => r.key === sel) || order[0];
  const chosen = order.filter((r) => picked.has(r.key));
  const toAccept = chosen.filter((r) => bucketOf(r, left) === 'open').map((r) => r.key);
  const toDismiss = chosen.filter((r) => ['open', 'accepted'].includes(bucketOf(r, left))).map((r) => r.key);
  const allOn = order.length > 0 && chosen.length === order.length;

  const settle = (next: FindingsResponse) => {
    setBoard(next);
    stackFix.reload();
    refreshThreads(d.slug);
    onReload();
  };
  const act = async (action: FindingAction, keys: string[], reason = '', fix: Fix = {}) => {
    if (!keys.length || pending) return false;
    if (current && keys.includes(current.key)) {
      const i = order.indexOf(current);
      const after = [...order.slice(i + 1), ...order.slice(0, i).reverse()].find((r) => !keys.includes(r.key));
      setSel(after ? after.key : null);
    }
    setPending({ action, keys: new Set(keys) });
    try {
      const next = await api.findingAction(d.slug, { action, keys, reason, pr: null, ...fix });
      settle(next);
      setPicked(new Set());
      setPick('');
      const pruned = (next.pruned || []).map((p) => (p.outcome === 'pruned' ? `agent of group ${p.group} pruned` : p.outcome === 'left' ? `left group ${p.group}, its agent stays for ${p.others} other item(s)` : `agent kept: ${p.reason}`));
      const fixing = [...(next.dispatched ? [`fix agent${fix.together ? '' : 's'} starting for ${next.dispatched}`] : []), ...(next.unanchored ? [`${next.unanchored} without a file: no agent`] : [])];
      toast.success([`${DONE[action]} ${plural(keys.length)}`, ...fixing, ...pruned].join(' · '), action === 'reopen' ? {} : { undo: () => actRef.current('reopen', keys) });
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setPending(null);
    }
  };
  const actRef = useRef(act);
  actRef.current = act;
  const dismiss = (keys: string[], reason?: string) => (reason ? act('dismiss', keys, reason) : setAsking(keys));
  const dispatch = (r: FindingRow): Send => (note, model, files = []) => act('accept', [r.key], '', { note, ...(model ? { model } : {}), ...(files.length ? { attachments: files.map((f) => f.id) } : {}) });
  const refresh = (fresh: boolean) => {
    if (fresh) setRefreshing(true);
    return api.findings(d.slug, null, fresh).then(setBoard, (e) => fresh && toast.error(errorMessage(e))).finally(() => setRefreshing(false));
  };
  const togglePick = (keys: string[]) => setPicked((prev) => {
    const next = new Set(prev);
    const on = keys.every((k) => next.has(k));
    for (const k of keys) on ? next.delete(k) : next.add(k);
    return next;
  });
  const applyPick = (text: string) => {
    setPick(text);
    setPicked(new Set(parsePick(text).flatMap((i) => order[i - 1]?.key ?? [])));
  };

  // a deep link (#/work/<slug>/findings-<pr>/f-<commentId>) selects that finding once, and again when the link changes
  // on a phone the list and the finding take the screen in turn: a finding in the link shows it alone, back goes to the list
  const linked = useRef<string | null>(null);
  const phone = usePhone();
  const [opened, setOpened] = useState(() => parseHash(location.hash)?.finding ?? null);
  const withoutFinding = () => location.hash.replace(/\/f-[^/]*$/, '');
  const openOne = (r: FindingRow) => {
    setSel(r.key);
    location.hash = `${withoutFinding()}/f-${encodeURIComponent(r.commentId || r.key)}`;
  };
  useEffect(() => {
    const go = () => {
      const id = parseHash(location.hash)?.finding ?? null;
      setOpened(id);
      const r = id && id !== linked.current ? rows.find((x) => x.commentId === id || x.key === id) : undefined;
      if (!r) return;
      linked.current = id;
      if (hidden.includes(r.source)) setHidden(hidden.filter((s) => s !== r.source));
      setPrFilter((p) => (p === null ? p : nOf(r)));
      setStatus(bucketOf(r, left));
      setSel(r.key);
    };
    const relink = () => { linked.current = null; go(); };
    go();
    addEventListener('hashchange', relink);
    return () => removeEventListener('hashchange', relink);
  }, [rows]);

  useEffect(() => {
    const list = root.current?.querySelector('.dp-fi-list');
    const row = current && list?.querySelector(`[data-fk="${CSS.escape(current.key)}"]`);
    if (!list || !row) return;
    const l = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const head = 32 + 28;
    if (r.top < l.top + head) list.scrollTop -= l.top + head - r.top;
    else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom;
  }, [current?.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      const pane = root.current?.closest('.wb-group');
      if (!root.current?.offsetParent || (pane && !pane.classList.contains('focus')) || importing || asking || e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable]')) return;
      const i = current ? order.indexOf(current) : -1;
      const b = current ? bucketOf(current, left) : null;
      const run = (fn: () => unknown) => { e.preventDefault(); fn(); };
      if (e.key === 'j' && order[i + 1]) run(() => setSel(order[i + 1].key));
      else if (e.key === 'k' && order[i - 1]) run(() => setSel(order[i - 1].key));
      else if (current && e.key === 'x') run(() => togglePick([current.key]));
      else if (current && !busy && e.key === 'a' && b === 'open') run(() => act('accept', [current.key]));
      else if (current && !busy && e.key === 'd' && (b === 'open' || b === 'accepted')) run(() => dismiss([current.key]));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order, current, busy, importing, asking]);
  // the fix agents' chips follow their threads while the accepted list shows
  useShownInterval(() => refreshThreads(d.slug), 10000, status === 'accepted');
  const currentPr = current ? nOf(current) || null : null;
  useEffect(() => { onCurrentPr?.(currentPr); }, [currentPr]);

  if (!board) return <Loading what="Collecting findings…" />;
  const prFilterIds = Array.from(new Set([...Object.keys(prCounts), ...(prFilter === null ? [] : [prFilter])])).sort((a, b) => at(a) - at(b));
  const lastRun = stackFix.runs[0];
  const flight = (r: FindingRow) => (pending?.keys.has(r.key) ? pending.action : null);

  return (
    <div className={`dp-fi${phone ? (opened && current ? ' dp-fi-one' : ' dp-fi-many') : ''}`} ref={root}>
      <div className="dp-vbar">
        <span className="dp-title">Findings</span>
        <div className="dp-filters">
          {BUCKETS.map((b) => <button key={b} type="button" className={status === b ? 'dp-on' : 'dp-off'} onClick={() => setStatus(b)}>{b[0].toUpperCase() + b.slice(1)} <span>{bucketCounts[b]}</span></button>)}
        </div>
        <span className="dp-sp" />
        {lastRun && <StackRunChip run={lastRun} />}
        <div className="dp-filters">
          <button type="button" className={group === 'pr' ? 'dp-on' : 'dp-off'} onClick={() => setGroup('pr')}>By PR</button>
          <button type="button" className={group === 'severity' ? 'dp-on' : 'dp-off'} onClick={() => setGroup('severity')}>By severity</button>
        </div>
        <button type="button" className="dp-btn dp-sm" title="Turn a review file into local comments" onClick={() => setImporting(true)}><Icon name="upload" size={12} />Import review…</button>
        <button type="button" className={`dp-btn dp-ghost dp-sm dp-fi-refresh${pendingClass(refreshing)}`} disabled={refreshing} title={board.at ? `Saved ${stamp(board.at)}: ask GitHub and the reviews again` : 'Ask GitHub and the reviews again'} aria-label="Refresh" onClick={() => refresh(true)}><Icon name="refresh" size={12} className={refreshing ? 'dp-spin' : undefined} /></button>
      </div>
      {importing && <ImportReview slug={d.slug} onClose={() => setImporting(false)} onDone={() => { void refresh(true); onReload(); }} />}
      {asking && <DismissDialog count={asking.length} onClose={() => setAsking(null)} onDismiss={(reason) => { const keys = asking; setAsking(null); void act('dismiss', keys, reason); }} />}

      {rows.length === 0 ? (
        <div className="dp-fi-empty"><Icon name="flag" size={16} /><b>No findings yet</b><span className="dp-t3">Reviews of this work’s PRs post their findings here.</span></div>
      ) : (
        <>
          {(prFilterIds.length > 1 || prFilter !== null) && (
            <div className="dp-fi-prs">
              <div className="dp-filters">
                <button type="button" className={prFilter === null ? 'dp-on' : 'dp-off'} onClick={() => setPrFilter(null)}>All PRs <span>{inStatus.length}</span></button>
                {prFilterIds.map((k) => {
                  const p = prOf(k);
                  return <button key={k || 'stack'} type="button" className={prFilter === k ? 'dp-on' : 'dp-off'} onClick={() => setPrFilter(prFilter === k ? null : k)}>{p ? prLabel(p) : k ? `#${k}` : 'Stack'} <span>{prCounts[k] || 0}</span></button>;
                })}
              </div>
            </div>
          )}
          <ReviewerStrip rows={strip} hidden={hidden} setHidden={setHidden} />
          {board.errors && board.errors.length > 0 && <div className="dp-fi-errs dp-xs"><Icon name="alert-triangle" size={12} />{board.errors.join(' · ')}</div>}
          <div className="dp-fx">
            <div className="dp-flist dp-fi-list">
              <div className="dp-fi-bulk">
                <Picker on={allOn} label={allOn ? 'Untick all' : 'Tick every finding shown'} onToggle={() => { setPick(''); setPicked(allOn ? new Set() : new Set(order.map((r) => r.key))); }} />
                <input className="dp-inp dp-fi-pickbox" value={pick} placeholder="pick 1-3, 5, 7" aria-label="Pick findings by number" onChange={(e) => applyPick(e.target.value)} />
                <span className="dp-sp" />
                {chosen.length > 0 && <span className="dp-xs dp-t3 dp-fi-picked">{chosen.length} picked</span>}
                <button type="button" className={`dp-btn dp-sm dp-primary${pendingClass(pending?.action === 'accept' && pending.keys.size > 1)}`} disabled={busy || !toAccept.length} title="Accept: a fix agent per file starts on them" onClick={() => act('accept', toAccept)}><Icon name="check" size={12} />Accept{toAccept.length ? ` ${toAccept.length}` : ''}</button>
                {toAccept.length > 1 && <button type="button" className={`dp-btn dp-sm${pendingClass(pending?.action === 'accept' && pending.keys.size > 1)}`} disabled={busy} title="Accept: one fix agent per PR takes them all" onClick={() => act('accept', toAccept, '', { together: true })}>Accept together</button>}
                <button type="button" className={`dp-btn dp-sm${pendingClass(pending?.action === 'dismiss' && pending.keys.size > 1)}`} disabled={busy || !toDismiss.length} onClick={() => dismiss(toDismiss)}>Dismiss{toDismiss.length ? ` ${toDismiss.length}` : ''}…</button>
              </div>
              {order.length === 0 && <div className="dp-fi-none dp-t3">Nothing {status} here{hidden.length ? ` (${hidden.join(', ')} hidden)` : ''}.</div>}
              {groups.map((g) => (
                <div key={g.id}>
                  <div className="dp-fgrp">{g.head}<span className="dp-sp" /><span className="dp-count">{g.rows.length}</span></div>
                  {g.rows.map((r) => {
                    const p = prOf(nOf(r));
                    const i = order.indexOf(r) + 1;
                    const on = picked.has(r.key);
                    return (
                      <div key={r.key} data-fk={r.key} className={`dp-frow dp-fi-row${r.key === current?.key ? ' dp-sel' : ''}${on ? ' dp-fi-on' : ''}${status === 'dismissed' || status === 'resolved' ? ' dp-dim' : ''}${flight(r) ? ' dp-fi-busy' : ''}`} onClick={() => (phone ? openOne(r) : setSel(r.key))}>
                        <Picker on={on} label={`Pick ${i}`} onToggle={() => togglePick([r.key])} />
                        <span className="dp-xs dp-t4 dp-num dp-fi-num">{i}</span>
                        <span className={`dp-sev ${sevClass(r.severity)}`} title={r.severity || 'unrated'}><i /></span>
                        <span className="dp-fi-main">
                          <span className="dp-fi-claim" title={titleOf(r)}>{titleOf(r)}</span>
                          <span className="dp-fi-meta dp-xs dp-t3">
                            {status === 'accepted' && <FixState slug={d.slug} r={r} />}
                            {group === 'severity' && (p ? <PrChip pr={p} onOpen={onOpenPr} /> : r.n != null ? <span className="dp-prb">#{r.n}</span> : null)}
                            {loc(r) && <span className="dp-mono dp-ell dp-fi-loc" title={r.path}>{loc(r)}</span>}
                            <span className="dp-ell dp-fi-by">{byName(r)}</span>
                            <span className="dp-t4 dp-num dp-fi-age">{ago(r.ts)}</span>
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {current ? (
              <div className="dp-fdetail">
                {phone && <button type="button" className="dp-btn dp-ghost dp-fi-up" onClick={() => { location.hash = withoutFinding(); }}><Icon name="chevron-left" size={14} />Findings<span className="dp-count">{order.length}</span></button>}
                <Detail
                  slug={d.slug}
                  r={current}
                  bucket={bucketOf(current, left)}
                  pr={prOf(nOf(current))}
                  inFlight={flight(current)}
                  busy={busy}
                  onAct={(action) => act(action, [current.key])}
                  onDismiss={(reason) => dismiss([current.key], reason)}
                  onDispatch={dispatch(current)}
                  onSettled={() => { void refresh(false); }}
                />
              </div>
            ) : (
              <div className="dp-fdetail dp-fi-pick dp-t3">Select a finding.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
