import React, { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import Markdown from '../components/Markdown.tsx';
import { FindingBody, Inline } from '../components/Blocks.tsx';
import Thread, { threadKey, threadLabel, useThreadSummary, useThreadsOf } from '../components/Thread.tsx';
import { CodeRefScope } from '../components/CodeRefs.tsx';
import { pendingClass, useAction } from '../components/action.ts';
import { decisionBullet, decisionSummary, isLive, validChoice } from '../../server/decisions.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import { useUnsaved } from '../updates.ts';
import OptionPicker, { MoreButton, Sure } from './chat/OptionPicker.tsx';
import RowsPicker from './chat/RowsPicker.tsx';
import Icon from './Icon.tsx';
import PrChip, { prLabel } from './PrChip.tsx';
import { prKey, prTitle } from './data.ts';
import NavLevels, { NavHead, NavRow, useNavMode } from './nav/NavLevels.tsx';
import type { Level } from './nav/NavLevels.tsx';
import { useNav } from './nav/use-nav.ts';
import type { PreviewData } from './data.ts';
import type { CardOption, Decision, ThreadSummary, WorkDetail } from '../types.ts';
import type { DecisionChoice, DecisionView, WorkPr } from '../workbench/types.ts';
import './chat/card.css';
import './findings.css';
import './decisions.css';

type Bucket = 'open' | 'taken' | 'all' | 'archived';
const BUCKETS: Bucket[] = ['open', 'taken', 'all', 'archived'];

const bucketOf = (d: Decision): Bucket => (!isLive(d) ? 'archived' : d.status === 'taken' ? 'taken' : 'open');
const inBucket = (d: Decision, b: Bucket) => (b === 'all' ? isLive(d) : bucketOf(d) === b);
const prOf = (d: Decision) => (d.pr == null ? '' : String(d.pr));
const day = (iso?: string | null) => iso?.slice(0, 10) || '';

export const decisionCounts = (w: Pick<WorkDetail, 'decisions'>) => {
  const live = (w.decisions || []).filter(isLive);
  return { taken: live.filter((d) => d.status === 'taken').length, total: live.length };
};

const takenMarkdown = (decisions: Decision[]) => decisions.filter((d) => d.status === 'taken' && isLive(d)).map(decisionBullet).join('\n');

const initialChoice = (d: DecisionView): DecisionChoice => d.choice || (d.rows ? Object.fromEntries(d.rows.flatMap((r): [string, string][] => (r.recommended ? [[r.key, r.recommended]] : []))) : d.recommended || '');

const optionLabel = (d: DecisionView, key?: string) => d.options.find((o) => o.key === key)?.label || '';
const leading = (d: DecisionView) => {
  if (d.status === 'taken') return String(decisionSummary(d) ?? '');
  return d.rows ? `${d.rows.length} rows to pick` : optionLabel(d, d.recommended);
};

type Focus = { id?: string; pr?: string };
const useFocus = create<{ focus: Focus | null }>(() => ({ focus: null }));
const focusOn = (focus: Focus) => {
  useFocus.setState({ focus });
  useWorkbench.getState().open('decisions');
};
export const openDecision = (id: string) => focusOn({ id });
export const openDecisionsOf = (pr: string) => focusOn({ pr });

function Waiting({ s }: { s?: ThreadSummary }) {
  if (s?.asks) return <span className="dp-chip dp-warn" title="The decision's thread asks you something">{threadLabel(s, '')}</span>;
  if (s?.waiting) return <span className="dp-chip dp-info" title="An agent works in the decision's thread">agent working</span>;
  return null;
}

function Positions({ positions, initial }: { positions?: Record<string, string>; initial: boolean }) {
  const [open, setOpen] = useState(initial);
  const list = Object.entries(positions || {});
  if (!list.length) return null;
  return (
    <div className="dp-dc-sec">
      <MoreButton open={open} onToggle={() => setOpen(!open)}>{list.length} reviewer {list.length === 1 ? 'position' : 'positions'}</MoreButton>
      {open && (
        <div className="dp-dc-pos">
          {list.map(([who, text]) => <div key={who} className="dp-dc-posi"><b>{who}</b><Markdown text={text} /></div>)}
        </div>
      )}
    </div>
  );
}

function Evidence({ d, folded }: { d: DecisionView; folded: boolean }) {
  const [open, setOpen] = useState(!folded);
  const body = d.blocks?.length ? <FindingBody r={{ summary: d.summary, blocks: d.blocks, sources: d.sources }} /> : d.details ? <Markdown text={d.details} /> : null;
  if (!body) return null;
  return (
    <div className="dp-dc-sec">
      {folded && <MoreButton open={open} onToggle={() => setOpen(!open)}>{open ? 'Hide details' : 'Show details'}</MoreButton>}
      {open && <div className="dp-dc-ev">{body}</div>}
    </div>
  );
}

type DetailProps = { d: DecisionView; slug: string; pr?: WorkPr; onOpenPr?: (key: string) => void; onDecide: (body: Record<string, unknown>) => Promise<unknown>; onReload?: () => unknown; talk?: boolean; keys?: boolean };

// one decision: its question and evidence, the options or the rows to pick, the rationale, then its thread
export function DecisionDetail({ d, slug, pr, onOpenPr, onDecide, onReload, talk, keys }: DetailProps) {
  const [choice, setChoice] = useState<DecisionChoice>(() => initialChoice(d));
  const [rationale, setRationale] = useState(d.rationale || '');
  useUnsaved(rationale.trim() !== (d.rationale || '').trim());
  const { pending, busy, run } = useAction();
  const key = threadKey.decision(d.id);
  const summary = useThreadSummary(slug, key);
  const [talking, setTalking] = useState<boolean | null>(talk ?? null);
  const showThread = talking ?? Boolean(summary?.asks || summary?.waiting);
  const taken = d.status === 'taken';
  const archived = !isLive(d);
  const act = (what: string, body: Record<string, unknown>) => run(what, () => onDecide(body));
  const options: CardOption[] = d.options.map((o) => ({ ...o, recommended: o.key === d.recommended }));
  const picks = typeof choice === 'object' && choice ? choice : {};
  const ro = taken || busy;
  return (
    <CodeRefScope n={d.pr ?? undefined}>
      <div className="dp-row dp-g4" style={{ flexWrap: 'wrap' }}>
        <span className={`dp-chip ${taken ? 'dp-ok' : 'dp-warn'}`}>{taken ? `taken ${day(d.decidedAt)}` : 'open'}</span>
        {archived && <span className="dp-chip">archived {day(d.archivedAt)}</span>}
        <Sure value={d.confidence} title="How sure the author is of the recommendation" />
        <Waiting s={summary} />
        <span className="dp-sp" />
        {keys && <span className="dp-xs dp-t3"><kbd>J</kbd> <kbd>K</kbd> move</span>}
      </div>
      <h2 className="dp-h1 dp-dc-title">{d.title}</h2>
      <div className="dp-row dp-g4 dp-xs dp-t3" style={{ flexWrap: 'wrap' }}>
        {pr ? <PrChip pr={pr} onOpen={onOpenPr} /> : d.pr != null ? <span className="dp-prb">#{d.pr}</span> : <span>Whole work</span>}
        {d.source && <><span className="dp-t4">·</span><span>{d.source}</span></>}
      </div>
      {d.question && <Inline as="p" className="dp-dc-q" text={d.question} />}
      <Evidence d={d} folded={taken} />
      <Positions positions={d.positions} initial={!taken} />

      <div className="dp-dc-sec">
        <div className="dp-sec-t">{d.rows ? 'One pick per row' : taken ? 'Taken' : 'Options'}</div>
        {d.rows ? (
          <RowsPicker name={`dec-${d.id}`} columns={['']} rows={d.rows.map((r) => ({ key: r.key, cells: [r.label], recommended: r.recommended, details: r.details, confidence: r.confidence }))} options={options} ticked={[]} picks={picks} ro={ro} onPick={setChoice} markdown done={taken} />
        ) : (
          <OptionPicker name={`dec-${d.id}`} label={d.title} options={options} picked={typeof choice === 'string' && choice ? [choice] : []} ro={ro} onPick={setChoice} openRecommended={!taken} markdown done={taken} />
        )}
      </div>

      {taken ? d.rationale && (
        <div className="dp-dc-sec dp-dc-why"><div className="dp-sec-t">Rationale</div><Markdown text={d.rationale} /></div>
      ) : (
        <textarea className="dp-inp dp-cd-ta dp-dc-ta" rows={3} value={rationale} disabled={busy} aria-label="Rationale" placeholder="Why (optional, markdown: goes to the notes and the timeline)" onChange={(e) => setRationale(e.target.value)} />
      )}

      <div className="dp-row dp-g6 dp-dc-actions">
        {taken ? (
          <button type="button" className={`dp-btn${pendingClass(pending === 'reopen')}`} disabled={busy} title="Back to open; the notes bullet stays as history" onClick={() => act('reopen', { id: d.id, status: 'pending' })}>Reopen</button>
        ) : (
          <button type="button" className={`dp-btn dp-primary${pendingClass(pending === 'take')}`} disabled={busy || !validChoice(d, choice)} title={d.rows ? 'Every row needs a pick' : undefined} onClick={() => act('take', { id: d.id, choice, rationale })}><Icon name="check" size={14} />Take decision</button>
        )}
        <button type="button" className={`dp-btn dp-ghost${pendingClass(pending === 'archive')}`} disabled={busy} title={archived ? 'Back to the live decisions' : 'Overtaken by later work: out of counts, briefs and the review feed'} onClick={() => act('archive', { id: d.id, archived: !archived })}><Icon name="archive" size={14} />{archived ? 'Unarchive' : 'Archive'}</button>
        <button type="button" className={`dp-btn dp-ghost dp-dc-talk${showThread ? ' dp-on' : ''}${summary?.asks ? ' dp-dc-hot' : ''}`} aria-expanded={showThread} title="Ask a scoped agent about this decision" onClick={() => setTalking(!showThread)}><Icon name="message-square" size={14} />{threadLabel(summary, 'Ask an agent')}</button>
      </div>
      {showThread && <div className="dp-dc-thread"><Thread slug={slug} threadKey={key} onSettled={onReload} /></div>}
    </CodeRefScope>
  );
}

type Group = { id: string; pr?: WorkPr; rows: DecisionView[] };

export default function DecisionsView({ d, onOpenPr, onCurrentPr }: { d: PreviewData; onOpenPr: (key: string) => void; onCurrentPr?: (key: string | null) => void }) {
  const all = (d.work.w?.decisions || []) as DecisionView[];
  const { summaries } = useThreadsOf(d.slug);
  const focus = useFocus((s) => s.focus);
  const [status, setStatus] = useState<Bucket>(() => (all.some((x) => bucketOf(x) === 'open') ? 'open' : 'all'));
  const [prFilter, setPrFilter] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [copied, setCopied] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const { taken, total } = decisionCounts({ decisions: all });

  const prRow = (k: string) => d.prs.find((p) => prKey(p) === k);
  const at = (k: string) => { if (!k) return -1; const i = d.prs.findIndex((p) => prKey(p) === k); return i < 0 ? 1e6 : i; };
  const counts = useMemo(() => Object.fromEntries(BUCKETS.map((b) => [b, all.filter((x) => inBucket(x, b)).length])) as Record<Bucket, number>, [all]);
  const inStatus = useMemo(() => all.filter((x) => inBucket(x, status)), [all, status]);
  const prCounts = useMemo(() => inStatus.reduce<Record<string, number>>((acc, x) => ((acc[prOf(x)] = (acc[prOf(x)] || 0) + 1), acc), {}), [inStatus]);
  const groups = useMemo<Group[]>(() => {
    const shown = inStatus.filter((x) => prFilter === null || prOf(x) === prFilter);
    const keys = Array.from(new Set(shown.map(prOf))).sort((a, b) => at(a) - at(b));
    return keys.map((k) => ({ id: k || 'work', pr: prRow(k), rows: shown.filter((x) => prOf(x) === k).sort((a, b) => Number(bucketOf(a) !== 'open') - Number(bucketOf(b) !== 'open')) }));
  }, [inStatus, prFilter, d.prs]);
  const visible = groups.flatMap((g) => g.rows);
  // a beta navigation mode opens a decision as the level under the list, from the tab's path
  const beta = useNavMode() !== 'classic';
  const nav = useNav();
  const current = beta ? visible.find((x) => x.id === nav.path[0]) : visible.find((x) => x.id === sel) || visible[0];

  useEffect(() => {
    if (!focus) return;
    const target = focus.id ? all.find((x) => x.id === focus.id) : undefined;
    if (target) {
      setStatus(bucketOf(target));
      setPrFilter(null);
      setSel(target.id);
      if (beta) nav.open(0, target.id);
    } else if (focus.pr !== undefined) {
      const mine = all.filter((x) => prOf(x) === focus.pr && isLive(x));
      setStatus(mine.some((x) => bucketOf(x) === 'open') ? 'open' : 'all');
      setPrFilter(focus.pr);
      setSel(null);
    }
    useFocus.setState({ focus: null });
  }, [focus]);

  useEffect(() => {
    const list = root.current?.querySelector('.dp-dc-list');
    const row = current && list?.querySelector(`[data-dec="${CSS.escape(current.id)}"]`);
    if (!list || !row) return;
    const l = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const head = 28;
    if (r.top < l.top + head) list.scrollTop -= l.top + head - r.top;
    else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom;
  }, [current?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (beta || !root.current?.offsetParent || e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable]')) return;
      const i = current ? visible.indexOf(current) : -1;
      if (e.key === 'j' && visible[i + 1]) setSel(visible[i + 1].id);
      else if (e.key === 'k' && visible[i - 1]) setSel(visible[i - 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, current, beta]);
  const currentPr = current ? prOf(current) || null : null;
  useEffect(() => { onCurrentPr?.(currentPr); }, [currentPr]);

  const copy = async () => {
    const ok = await navigator.clipboard.writeText(takenMarkdown(all)).then(() => true, () => false);
    setCopied(ok ? `${taken} copied` : 'Copy failed');
    setTimeout(() => setCopied(''), 2500);
  };
  const prFilterIds = Object.keys(prCounts).sort((a, b) => at(a) - at(b));
  const detail = (x: DecisionView) => <DecisionDetail d={x} slug={d.slug} pr={prRow(prOf(x))} onOpenPr={onOpenPr} onDecide={d.work.decide} onReload={() => d.work.load()} keys />;

  const classic = (
    <div className="dp-dc" ref={root}>
      <div className="dp-vbar">
        <span className="dp-title">Decisions</span>
        <div className="dp-filters">
          {BUCKETS.map((b) => <button key={b} type="button" className={status === b ? 'dp-on' : ''} onClick={() => { setStatus(b); setPrFilter(null); }}>{b[0].toUpperCase() + b.slice(1)} <span>{counts[b]}</span></button>)}
        </div>
        <span className="dp-sp" />
        <span className="dp-xs dp-t3 dp-num dp-dc-tally">{taken} / {total} taken</span>
        <button type="button" className="dp-btn dp-sm" disabled={!taken} title="The taken decisions as notes bullets, to paste into a plan" onClick={copy}><Icon name={copied.endsWith('copied') ? 'check' : 'copy'} size={12} />{copied || 'Copy taken as markdown'}</button>
      </div>

      {all.length === 0 ? (
        <div className="dp-fi-empty"><Icon name="scale" size={16} /><b>No decisions yet</b><span className="dp-t3">Agents add them with upsert_decision, or add a <code>decisions</code> array to the work JSON.</span></div>
      ) : (
        <>
          {prFilterIds.length > 1 && (
            <div className="dp-fi-prs">
              <div className="dp-filters">
                <button type="button" className={prFilter === null ? 'dp-on' : ''} onClick={() => setPrFilter(null)}>All <span>{inStatus.length}</span></button>
                {prFilterIds.map((k) => {
                  const pr = prRow(k);
                  return <button key={k || 'work'} type="button" className={prFilter === k ? 'dp-on' : ''} onClick={() => setPrFilter(prFilter === k ? null : k)}>{!k ? 'Whole work' : pr ? prLabel(pr) : `#${k}`} <span>{prCounts[k]}</span></button>;
                })}
              </div>
            </div>
          )}
          <div className="dp-fx">
            <div className="dp-flist dp-dc-list">
              {visible.length === 0 && <div className="dp-fi-none dp-t3">Nothing {status} here.</div>}
              {groups.map((g) => (
                <div key={g.id}>
                  <div className="dp-fgrp">
                    {g.pr ? <PrChip pr={g.pr} onOpen={onOpenPr} /> : g.id !== 'work' && <span className="dp-prb">#{g.id}</span>}
                    <span className="dp-ell">{g.pr ? prTitle(g.pr) : g.id === 'work' ? 'Whole work' : ''}</span>
                    <span className="dp-sp" /><span className="dp-count">{g.rows.length}</span>
                  </div>
                  {g.rows.map((x) => {
                    const b = bucketOf(x);
                    const lead = leading(x);
                    return (
                      <div key={x.id} data-dec={x.id} className={`dp-frow dp-dc-row${x.id === current?.id ? ' dp-sel' : ''}${b === 'archived' ? ' dp-dim' : ''}`} onClick={() => setSel(x.id)}>
                        <span className={`dp-dc-dot dp-dc-${b === 'archived' ? 'arch' : b}`} title={b} />
                        <span className="dp-dc-main">
                          <span className="dp-ell dp-dc-t" title={x.title}>{x.title}</span>
                          {x.question && <span className="dp-ell dp-xs dp-t3" title={x.question}>{x.question}</span>}
                        </span>
                        <span className="dp-dc-side">
                          <Waiting s={summaries[threadKey.decision(x.id)]} />
                          {lead && <span className="dp-ell dp-xs dp-t2 dp-dc-lead" title={x.status === 'taken' ? 'taken' : 'recommended'}>{x.status === 'taken' ? '✓ ' : '→ '}{lead}</span>}
                          {x.status !== 'taken' && <Sure value={x.confidence} title="How sure the author is of the recommendation" />}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {current ? (
              <div key={`${current.id}-${current.status}-${current.decidedAt || ''}-${current.archivedAt || ''}`} className="dp-fdetail dp-dc-detail">
                {detail(current)}
              </div>
            ) : (
              <div className="dp-fdetail dp-fi-pick dp-t3">Select a decision.</div>
            )}
          </div>
        </>
      )}
    </div>
  );

  const list = (child: (key: string) => React.ReactNode) => (
    <div className="dp-dc dp-dc-nav">
      <div className="dp-filters dp-nfilters">
        {BUCKETS.map((b) => <button key={b} type="button" className={status === b ? 'dp-on' : ''} onClick={() => { setStatus(b); setPrFilter(null); }}>{b[0].toUpperCase() + b.slice(1)} <span>{counts[b]}</span></button>)}
      </div>
      {all.length === 0 && <div className="dp-fi-none dp-t3">No decisions yet. Agents add them with upsert_decision.</div>}
      {all.length > 0 && visible.length === 0 && <div className="dp-fi-none dp-t3">Nothing {status} here.</div>}
      {groups.map((g) => (
        <div key={g.id}>
          <NavHead>{g.pr ? <PrChip pr={g.pr} onOpen={onOpenPr} /> : g.id !== 'work' && <span className="dp-prb">#{g.id}</span>}<span className="dp-ell">{g.pr ? prTitle(g.pr) : g.id === 'work' ? 'Whole work' : ''}</span><span className="dp-sp" /><span className="dp-count">{g.rows.length}</span></NavHead>
          {g.rows.map((x) => {
            const b = bucketOf(x);
            const lead = leading(x);
            return (
              <React.Fragment key={x.id}>
                <NavRow
                  on={x.id === current?.id}
                  onOpen={() => nav.open(0, x.id, true)}
                  className={b === 'archived' ? 'dp-dim' : ''}
                  icon={<span className={`dp-dc-dot dp-dc-${b === 'archived' ? 'arch' : b}`} title={b} />}
                  title={x.title}
                  sub={lead ? `${x.status === 'taken' ? '✓' : '→'} ${lead}` : x.question}
                  meta={<Waiting s={summaries[threadKey.decision(x.id)]} />}
                />
                {child(x.id)}
              </React.Fragment>
            );
          })}
        </div>
      ))}
    </div>
  );
  const levels: Level[] = [
    { key: 'decisions', label: 'Decisions', render: list },
    ...(current ? [{ key: current.id, label: current.title, render: () => <div key={`${current.id}-${current.status}-${current.decidedAt || ''}`} className="dp-fdetail dp-dc-detail">{detail(current)}</div> }] : []),
  ];
  return <NavLevels classic={classic} levels={levels} />;
}
