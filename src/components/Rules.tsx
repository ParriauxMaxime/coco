import React, { useEffect, useState } from 'react';
import Collapsible from './Collapsible.tsx';
import { api, errorMessage } from '../api.ts';
import { toast } from './Toast.tsx';
import type { Rule, RuleScope, RulesResponse } from '../types.ts';

const POLL_MS = 3000;
const STATUS_CHIP: Record<string, string> = { proposed: 'c-orange', kept: 'c-green', retired: 'c-grey' };

type Patch = { status?: string; drop?: boolean };
type ScopeEntry = [string, string, Rule[]];

function RuleLine({ r, scope, onSet }: { r: Rule; scope: string; onSet: (r: Rule, patch: Patch) => void }) {
  return (
    <div className={`list-item rule-line ${r.status}`}>
      <span className="chip c-grey">{scope}</span>
      {r.status !== 'kept' && <span className={`chip ${STATUS_CHIP[r.status]}`}>{r.status}</span>}
      <span className="rule-text" title={r.source ? `source: ${r.source}` : ''}>{r.text}</span>
      <span className="row rule-acts">
        {r.status !== 'kept' && <button className="sm" onClick={() => onSet(r, { status: 'kept' })}>keep</button>}
        {r.status === 'kept' && <button className="sm" onClick={() => onSet(r, { status: 'retired' })}>retire</button>}
        {r.status === 'proposed' && <button className="sm" onClick={() => onSet(r, { drop: true })}>drop</button>}
      </span>
    </div>
  );
}

// global, work and PR rules on one page; slug null is the global ledger only
export default function Rules({ slug = null }: { slug?: string | null }) {
  const [data, setData] = useState<RulesResponse | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [target, setTarget] = useState(slug ? 'work' : 'global');
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

  if (error) return <div className="card danger">{error}</div>;
  if (!data) return <div className="sub">Loading rules…</div>;
  const scopes: ScopeEntry[] = [['global', 'global', data.global], ...(slug ? [['work', 'work', data.work ?? []] satisfies ScopeEntry, ...(data.prs ?? []).filter((p) => p.key).map((p): ScopeEntry => [`pr:${p.key}`, p.title, p.rules])] : [])];
  const live = scopes.flatMap(([k, label, list]) => list.filter((r) => r.status !== 'retired').map((r): [string, string, Rule] => [k, label, r]));
  const retired = scopes.flatMap(([k, label, list]) => list.filter((r) => r.status === 'retired').map((r): [string, string, Rule] => [k, label, r]));
  const order: Record<string, number> = { proposed: 0, kept: 1 };
  return (
    <div className="rules">
      <p className="sub">Kept rules go into every agent brief and review plan{slug ? ': global first, then this work, then the PR' : ''}.</p>
      <div className="card">
        {live.sort((a, b) => order[a[2].status] - order[b[2].status]).map(([k, label, r]) => <RuleLine key={r.id} r={r} scope={label} onSet={set(k)} />)}
        {!live.length && <div className="sub">No rule yet.</div>}
      </div>
      <div className="card">
        <div className="row">
          <select value={target} onChange={(e) => setTarget(e.target.value)}>{scopes.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select>
          <input style={{ flex: 1, minWidth: 180 }} value={text} maxLength={200} placeholder="One line rule" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="sm primary" disabled={!text.trim()} onClick={add}>Add</button>
        </div>
        <textarea className="cc-textarea" style={{ marginTop: 8 }} rows={3} value={excerpt} placeholder="Paste a chat excerpt where you corrected an agent: coco proposes the rules, you keep or drop each" onChange={(e) => setExcerpt(e.target.value)} />
        <div className="row">
          <button className="sm" disabled={running || !excerpt.trim()} onClick={propose}>{running ? <><span className="spinner" aria-hidden /> coco is reading…</> : '🦜 Propose rules'}</button>
          {data.proposing && !running && <span className="status">{data.proposing.error || `last run: ${data.proposing.added} proposed`}</span>}
        </div>
      </div>
      {retired.length > 0 && <Collapsible title={`Retired · ${retired.length}`}>{retired.map(([k, label, r]) => <RuleLine key={r.id} r={r} scope={label} onSet={set(k)} />)}</Collapsible>}
    </div>
  );
}
