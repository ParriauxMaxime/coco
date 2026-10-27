import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Markdown from '../components/Markdown.tsx';
import { FindingBody } from '../components/Blocks.tsx';
import { pendingClass, useAction } from '../components/action.ts';
import { api } from '../api.ts';
import Icon from './Icon.tsx';
import ImportReview from './ImportReview.tsx';
import PrChip, { prLabel } from './PrChip.tsx';
import { SEVERITIES, ago, sevClass, sevTone, stamp } from './format.ts';
import { prKey, prTitle } from './data.ts';
import type { PreviewData } from './data.ts';
import type { FindingAction, FindingRow } from '../types.ts';
import type { WorkPr } from '../workbench/types.ts';
import './findings.css';

type Bucket = 'open' | 'accepted' | 'resolved' | 'dismissed';
const BUCKETS: Bucket[] = ['open', 'accepted', 'resolved', 'dismissed'];
const LIVE = ['new', 'open', 'sent', 'outdated', 'accepted'];
const RANK: Record<string, number> = { blocking: 0, major: 1, minor: 2, nit: 3 };
const SEV_WORD: Record<string, string> = { blocking: 'Blocking', major: 'Major', minor: 'Minor', nit: 'Nit' };

const rank = (r: FindingRow) => RANK[r.severity || ''] ?? 4;
const nOf = (r: FindingRow) => (r.n == null ? '' : String(r.n));
const titleOf = (r: FindingRow) => r.claim || r.summary || r.body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') || 'Finding';
const loc = (r: FindingRow) => (r.path ? `${r.path.split('/').pop()}${r.line ? `:${r.line}` : ''}` : '');
const byName = (r: FindingRow) => r.by.name || r.source;

const bucketOf = (r: FindingRow, left: string[]): Bucket => {
  if (r.status === 'dismissed') return 'dismissed';
  if (r.status === 'accepted' || (r.accepted && LIVE.includes(r.status))) return 'accepted';
  return left.includes(r.status) ? 'open' : 'resolved';
};

type Group = { id: string; head: ReactNode; rows: FindingRow[] };

function Detail({ r, bucket, pr, onAct, busy, pending }: { r: FindingRow; bucket: Bucket; pr?: WorkPr; onAct: (action: FindingAction) => void; busy: boolean; pending: string | null }) {
  const structured = Boolean(r.blocks?.length);
  const place = r.path ? `${r.path}${r.line ? `:${r.line}` : ''}` : '';
  return (
    <div className="dp-fdetail">
      <div className="dp-row dp-g4" style={{ flexWrap: 'wrap' }}>
        {r.severity && <span className={`dp-chip ${sevTone(r.severity)}`}><span className="dp-d" />{SEV_WORD[r.severity] || r.severity}</span>}
        {r.confidence !== undefined && Number.isFinite(r.confidence) && <span className="dp-chip">{r.confidence}% sure</span>}
        <span className="dp-chip"><Icon name={r.by.group === 'coco' || r.source === 'coco' ? 'bot' : 'users'} size={12} />{byName(r)}</span>
        {bucket !== 'open' && <span className="dp-chip">{bucket}</span>}
        <span className="dp-sp" />
        <span className="dp-xs dp-t3"><kbd>J</kbd> <kbd>K</kbd> move</span>
      </div>
      <h2 className="dp-h1 dp-fi-title">{titleOf(r)}</h2>
      <div className="dp-row dp-g4 dp-xs dp-t3" style={{ flexWrap: 'wrap' }}>
        {pr ? <PrChip pr={pr} /> : r.n != null && <span className="dp-prb">#{r.n}</span>}
        {place && <span className="dp-mono dp-fi-place">{place}</span>}
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
        {bucket === 'open' && <button type="button" className={`dp-btn dp-primary${pendingClass(pending === 'accept')}`} disabled={busy} onClick={() => onAct('accept')}><Icon name="check" size={14} />Accept<kbd>A</kbd></button>}
        {(bucket === 'open' || bucket === 'accepted') && <button type="button" className={`dp-btn dp-ghost${pendingClass(pending === 'dismiss')}`} disabled={busy} onClick={() => onAct('dismiss')}>Dismiss<kbd>D</kbd></button>}
        {(bucket === 'accepted' || bucket === 'dismissed') && <button type="button" className={`dp-btn${pendingClass(pending === 'reopen')}`} disabled={busy} onClick={() => onAct('reopen')}>Reopen</button>}
        {r.url && <a className="dp-btn" href={r.url} target="_blank" rel="noreferrer"><Icon name="external-link" size={14} />Open on GitHub</a>}
      </div>
    </div>
  );
}

export default function FindingsView({ d, onOpenPr, onReload, onCurrentPr }: { d: PreviewData; onOpenPr: (key: string) => void; onReload: () => void; onCurrentPr?: (key: string | null) => void }) {
  const rows = d.findings?.rows || [];
  const left = d.findings?.left || ['new', 'open', 'sent', 'outdated'];
  const [status, setStatus] = useState<Bucket>('open');
  const [prFilter, setPrFilter] = useState<string | null>(null);
  const [group, setGroup] = useState<'pr' | 'severity'>('pr');
  const [sel, setSel] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const { pending, busy, run } = useAction();

  const prOf = (n: string) => d.prs.find((p) => prKey(p) === n);
  const bucketCounts = useMemo(() => rows.reduce<Record<Bucket, number>>((acc, r) => ((acc[bucketOf(r, left)] += 1), acc), { open: 0, accepted: 0, resolved: 0, dismissed: 0 }), [rows, left.join()]);
  const inStatus = useMemo(() => rows.filter((r) => bucketOf(r, left) === status), [rows, status, left.join()]);
  const prCounts = useMemo(() => inStatus.reduce<Record<string, number>>((acc, r) => ((acc[nOf(r)] = (acc[nOf(r)] || 0) + 1), acc), {}), [inStatus]);
  const visible = useMemo(() => inStatus.filter((r) => prFilter === null || nOf(r) === prFilter).sort((a, b) => rank(a) - rank(b) || (a.ts < b.ts ? 1 : -1)), [inStatus, prFilter]);
  const current = visible.find((r) => r.key === sel) || visible[0];

  const groups = useMemo<Group[]>(() => {
    if (group === 'severity') {
      return [...SEVERITIES, ''].map((s) => ({
        id: s || 'none',
        head: <><span className={`dp-sev ${sevClass(s)}`}><i /></span><span className="dp-ell">{SEV_WORD[s] || 'Unrated'}</span></>,
        rows: visible.filter((r) => (SEVERITIES.includes(r.severity || '') ? r.severity === s : s === '')),
      })).filter((g) => g.rows.length);
    }
    const keys = Array.from(new Set(visible.map(nOf)));
    const at = (k: string) => { const i = d.prs.findIndex((p) => prKey(p) === k); return i < 0 ? 1e6 : i; };
    return keys.sort((a, b) => at(a) - at(b)).map((k) => {
      const pr = prOf(k);
      return {
        id: k || 'stack',
        head: <>{pr ? <PrChip pr={pr} onOpen={onOpenPr} /> : k ? <span className="dp-prb">#{k}</span> : null}<span className="dp-ell">{pr ? prTitle(pr) : k ? '' : 'Whole stack'}</span></>,
        rows: visible.filter((r) => nOf(r) === k),
      };
    });
  }, [visible, group, d.prs]);

  const act = async (action: FindingAction, r: FindingRow) => {
    const done = await run(action, () => api.findingAction(d.slug, { action, keys: [r.key], pr: null }));
    if (done) onReload();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (importing || e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable]')) return;
      const i = current ? visible.indexOf(current) : -1;
      if (e.key === 'j' && visible[i + 1]) setSel(visible[i + 1].key);
      else if (e.key === 'k' && visible[i - 1]) setSel(visible[i - 1].key);
      else if (current && !busy && e.key === 'a' && bucketOf(current, left) === 'open') act('accept', current);
      else if (current && !busy && e.key === 'd' && ['open', 'accepted'].includes(bucketOf(current, left))) act('dismiss', current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, current, busy, importing]);
  const currentPr = current ? nOf(current) || null : null;
  useEffect(() => { onCurrentPr?.(currentPr); }, [currentPr]);

  const prFilterIds = Object.keys(prCounts).sort((a, b) => d.prs.findIndex((p) => prKey(p) === a) - d.prs.findIndex((p) => prKey(p) === b));

  return (
    <div className="dp-fi">
      <div className="dp-vbar">
        <span className="dp-title">Findings</span>
        <div className="dp-filters">
          {BUCKETS.map((b) => <button key={b} type="button" className={status === b ? 'dp-on' : ''} onClick={() => { setStatus(b); setPrFilter(null); }}>{b[0].toUpperCase() + b.slice(1)} <span>{bucketCounts[b]}</span></button>)}
        </div>
        <span className="dp-sp" />
        <div className="dp-filters">
          <button type="button" className={group === 'pr' ? 'dp-on' : ''} onClick={() => setGroup('pr')}>By PR</button>
          <button type="button" className={group === 'severity' ? 'dp-on' : ''} onClick={() => setGroup('severity')}>By severity</button>
        </div>
        <button type="button" className="dp-btn dp-sm" title="Turn a review file into local comments" onClick={() => setImporting(true)}><Icon name="upload" size={12} />Import review…</button>
      </div>
      {importing && <ImportReview slug={d.slug} onClose={() => setImporting(false)} onDone={onReload} />}

      {rows.length === 0 ? (
        <div className="dp-fi-empty"><Icon name="flag" size={16} /><b>No findings yet</b><span className="dp-t3">Reviews of this work’s PRs post their findings here.</span></div>
      ) : (
        <>
          {prFilterIds.length > 1 && (
            <div className="dp-fi-prs">
              <div className="dp-filters">
                <button type="button" className={prFilter === null ? 'dp-on' : ''} onClick={() => setPrFilter(null)}>All PRs <span>{inStatus.length}</span></button>
                {prFilterIds.map((k) => {
                  const pr = prOf(k);
                  return <button key={k || 'stack'} type="button" className={prFilter === k ? 'dp-on' : ''} onClick={() => setPrFilter(prFilter === k ? null : k)}>{pr ? prLabel(pr) : k ? `#${k}` : 'Stack'} <span>{prCounts[k]}</span></button>;
                })}
              </div>
            </div>
          )}
          <div className="dp-fx">
            <div className="dp-flist dp-fi-list">
              {visible.length === 0 && <div className="dp-fi-none dp-t3">Nothing {status} here.</div>}
              {groups.map((g) => (
                <div key={g.id}>
                  <div className="dp-fgrp">{g.head}<span className="dp-sp" /><span className="dp-count">{g.rows.length}</span></div>
                  {g.rows.map((r) => {
                    const pr = prOf(nOf(r));
                    return (
                      <div key={r.key} className={`dp-frow dp-fi-row${r.key === current?.key ? ' dp-sel' : ''}${status === 'dismissed' || status === 'resolved' ? ' dp-dim' : ''}`} onClick={() => setSel(r.key)}>
                        <span className={`dp-sev ${sevClass(r.severity)}`} title={r.severity || 'unrated'}><i /></span>
                        {group === 'severity' && (pr ? <PrChip pr={pr} onOpen={onOpenPr} /> : r.n != null ? <span className="dp-prb">#{r.n}</span> : null)}
                        <span className="dp-ell dp-fi-claim" title={titleOf(r)}>{titleOf(r)}</span>
                        {loc(r) && <span className="dp-mono dp-xs dp-t3 dp-ell dp-fi-loc" title={r.path}>{loc(r)}</span>}
                        <span className="dp-xs dp-t3 dp-ell dp-fi-by">{byName(r)}</span>
                        <span className="dp-xs dp-t4 dp-num dp-fi-age">{ago(r.ts)}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {current ? (
              <Detail r={current} bucket={bucketOf(current, left)} pr={prOf(nOf(current))} busy={busy} pending={pending} onAct={(action) => act(action, current)} />
            ) : (
              <div className="dp-fdetail dp-fi-pick dp-t3">Select a finding.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
