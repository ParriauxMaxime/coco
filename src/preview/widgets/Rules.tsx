import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { toast } from '../../components/Toast.tsx';
import { useUnsaved } from '../../updates.ts';
import Icon from '../Icon.tsx';
import { ErrorNote, Loading } from '../pages/Page.tsx';
import CardView from '../chat/Card.tsx';
import type { Card, Rule, RuleScope, RulesResponse } from '../../types.ts';
import '../pages/rules.css';

const POLL_MS = 3000;
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
export type Patch = { status?: string; drop?: boolean };
type ScopeEntry = [string, string, Rule[]];

export function RuleRow({ r, scope, onSet }: { r: Rule; scope?: string; onSet: (r: Rule, patch: Patch) => void }) {
  return (
    <div className={`dp-rowi dp-rules-row dp-rules-${r.status}`}>
      {scope && <span className="dp-chip dp-rules-scope">{scope}</span>}
      <span className="dp-rowi-b">
        <span className="dp-rules-text">{r.text}</span>
        {r.source && <span className="dp-t3 dp-ell" title={r.source}>{r.source}</span>}
      </span>
      <span className="dp-rowi-m">{day(r.addedAt)}</span>
      <span className="dp-row dp-g4 dp-rules-acts">
        {r.status !== 'kept' && <button type="button" className={`dp-btn dp-sm${r.status === 'proposed' ? ' dp-primary' : ''}`} onClick={() => onSet(r, { status: 'kept' })}><Icon name="check" size={12} />Keep</button>}
        {r.status === 'kept' && <button type="button" className="dp-btn dp-sm dp-ghost" onClick={() => onSet(r, { status: 'retired' })}><Icon name="archive" size={12} />Retire</button>}
        {r.status === 'proposed' && <button type="button" className="dp-btn dp-sm dp-ghost" onClick={() => onSet(r, { drop: true })}><Icon name="x" size={12} />Drop</button>}
      </span>
    </div>
  );
}

// the card of the last Propose rules run: Keep or Drop per rule, the kept ones join the ledger
export function ProposedRules({ cardId, onAnswered }: { cardId?: string; onAnswered: () => void }) {
  const [card, setCard] = useState<Card | null>(null);
  useEffect(() => {
    setCard(null);
    if (cardId) api.card(cardId).then(setCard, () => {});
  }, [cardId]);
  if (!card || card.kind === 'post') return null;
  return <CardView card={card} onCard={(c) => { setCard(c); if (c.status !== 'open') onAnswered(); }} />;
}

// global, work and PR rules in one ledger; slug null is the global ledger only
export default function RulesLedger({ slug = null }: { slug?: string | null }) {
  const [data, setData] = useState<RulesResponse | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [excerpt, setExcerpt] = useState('');
  useUnsaved(Boolean(text.trim() || excerpt.trim()));
  const [target, setTarget] = useState(slug ? 'work' : 'global');
  const [showRetired, setShowRetired] = useState(false);
  const load = () => api.rules(slug).then(setData, (e) => setError(errorMessage(e)));
  useEffect(() => { load(); }, [slug]);
  const running = data?.proposing?.status === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [running]);

  const where = (t: string): RuleScope => (t.startsWith('pr:') ? { scope: 'pr', pr: t.slice(3) } : { scope: t });
  const run = (p: Promise<RulesResponse>) => p.then(setData, (e) => toast.error(errorMessage(e)));
  const set = (scopeKey: string) => (r: Rule, patch: Patch) => run(api.updateRule(slug, r.id, { ...where(scopeKey), ...patch }));
  const add = () => text.trim() && run(api.addRule(slug, { ...where(target), text, source: 'added by hand' })).then(() => setText(''));
  const propose = () => excerpt.trim() && run(api.proposeRules(slug, { ...where(target), text: excerpt })).then(() => setExcerpt(''));

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading what="Loading rules…" />;
  const scopes: ScopeEntry[] = [['global', 'global', data.global], ...(slug ? [['work', 'work', data.work ?? []] satisfies ScopeEntry, ...(data.prs ?? []).filter((p) => p.key).map((p): ScopeEntry => [`pr:${p.key}`, p.title, p.rules])] : [])];
  const live = scopes.flatMap(([k, label, list]) => list.filter((r) => r.status !== 'retired').map((r): [string, string, Rule] => [k, label, r]));
  const retired = scopes.flatMap(([k, label, list]) => list.filter((r) => r.status === 'retired').map((r): [string, string, Rule] => [k, label, r]));
  const order: Record<string, number> = { proposed: 0, kept: 1 };
  const scoped = scopes.length > 1;
  return (
    <div className="dp-rules-ledger">
      <p className="dp-rules-lead">Kept rules go into every agent brief and review plan{slug ? ': global first, then this work, then the PR' : ''}.</p>
      {live.length ? (
        <div className="dp-rows">{live.sort((a, b) => order[a[2].status] - order[b[2].status]).map(([k, label, r]) => <RuleRow key={r.id} r={r} scope={scoped ? label : undefined} onSet={set(k)} />)}</div>
      ) : <div className="dp-pempty"><Icon name="scale" size={16} /><span>No rule yet.</span></div>}
      <div className="dp-box dp-rules-box">
        <div className="dp-row dp-g6">
          {scoped && <select className="dp-inp dp-rules-sel" aria-label="Scope" value={target} onChange={(e) => setTarget(e.target.value)}>{scopes.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select>}
          <input className="dp-inp dp-grow" value={text} maxLength={200} placeholder="One line rule" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button type="button" className="dp-btn dp-primary" disabled={!text.trim()} onClick={add}><Icon name="plus" size={14} />Add</button>
        </div>
        <textarea className="dp-inp dp-rules-ta" rows={3} value={excerpt} placeholder="Paste a chat excerpt where you corrected an agent: coco proposes the rules, you keep or drop each" onChange={(e) => setExcerpt(e.target.value)} />
        <div className="dp-row dp-g8">
          <button type="button" className="dp-btn" disabled={running || !excerpt.trim()} onClick={propose}>
            {running ? <span className="dp-ag-dot dp-ag-running" /> : <Icon name="sparkles" size={14} />}{running ? 'coco is reading…' : 'Propose rules'}
          </button>
          {data.proposing && !running && <span className={`dp-sm ${data.proposing.error ? 'dp-rules-err' : 'dp-t3'}`}>{data.proposing.error || `Last run: ${data.proposing.added ?? 0} proposed`}</span>}
        </div>
      </div>
      <ProposedRules cardId={data.proposing?.cardId} onAnswered={() => void load()} />
      {retired.length > 0 && (
        <div>
          <button type="button" className="dp-rules-fold" aria-expanded={showRetired} onClick={() => setShowRetired((v) => !v)}><span className={`dp-caret${showRetired ? ' dp-open' : ''}`}><Icon name="chevron-right" size={12} /></span>Retired<span className="dp-count">{retired.length}</span></button>
          <div className={`dp-collapse${showRetired ? ' dp-open' : ''}`}><div><div className="dp-rows dp-rules-retired-list">{retired.map(([k, label, r]) => <RuleRow key={r.id} r={r} scope={scoped ? label : undefined} onSet={set(k)} />)}</div></div></div>
        </div>
      )}
    </div>
  );
}
