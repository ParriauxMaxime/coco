import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { toast } from '../../components/Toast.tsx';
import Icon from '../Icon.tsx';
import { Empty, ErrorNote, Loading, Page, PageHead, Section } from './Page.tsx';
import type { Rule, RulesResponse } from '../../types.ts';
import './rules.css';

const POLL_MS = 3000;
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
type Patch = { status?: string; drop?: boolean };

function RuleRow({ r, onSet }: { r: Rule; onSet: (r: Rule, patch: Patch) => void }) {
  return (
    <div className={`dp-rowi dp-rules-row dp-rules-${r.status}`}>
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

export default function RulesPage() {
  const [data, setData] = useState<RulesResponse | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const load = () => api.rules(null).then(setData, (e) => setError(errorMessage(e)));
  useEffect(() => { load(); }, []);
  const running = data?.proposing?.status === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [running]);

  const run = (p: Promise<RulesResponse>) => p.then(setData, (e) => toast.error(errorMessage(e)));
  const set = (r: Rule, patch: Patch) => run(api.updateRule(null, r.id, { scope: 'global', ...patch }));
  const add = () => text.trim() && run(api.addRule(null, { scope: 'global', text, source: 'added by hand' })).then(() => setText(''));
  const propose = () => excerpt.trim() && run(api.proposeRules(null, { scope: 'global', text: excerpt })).then(() => setExcerpt(''));

  const head = <PageHead icon="scale" title="Rules" sub="Kept rules go into every agent brief and review plan. A work's own rules and its PRs' live on that work's page." />;
  if (error) return <Page>{head}<ErrorNote>{error}</ErrorNote></Page>;
  if (!data) return <Page>{head}<Loading what="Loading rules…" /></Page>;
  const of = (s: string) => data.global.filter((r) => r.status === s);
  const [proposedRules, kept, retired] = [of('proposed'), of('kept'), of('retired')];

  return (
    <Page>
      {head}
      {proposedRules.length > 0 && (
        <Section title="Proposed" count={proposedRules.length} meta="keep or drop each">
          <div className="dp-rows">{proposedRules.map((r) => <RuleRow key={r.id} r={r} onSet={set} />)}</div>
        </Section>
      )}
      <Section title="Kept" count={kept.length}>
        {kept.length ? <div className="dp-rows">{kept.map((r) => <RuleRow key={r.id} r={r} onSet={set} />)}</div> : <Empty icon="scale">No rule yet: add one below, or let coco propose some from a chat excerpt.</Empty>}
      </Section>
      <Section title="Add rules">
        <div className="dp-rules-add">
          <div className="dp-row dp-g6">
            <input className="dp-inp dp-grow" value={text} maxLength={200} placeholder="One line rule" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button type="button" className="dp-btn dp-primary" disabled={!text.trim()} onClick={add}><Icon name="plus" size={14} />Add</button>
          </div>
          <div className="dp-rules-prop">
            <textarea className="dp-inp dp-rules-ta" rows={4} value={excerpt} placeholder="Paste a chat excerpt where you corrected an agent: coco proposes the rules, you keep or drop each" onChange={(e) => setExcerpt(e.target.value)} />
            <div className="dp-row dp-g8">
              <button type="button" className="dp-btn" disabled={running || !excerpt.trim()} onClick={propose}>
                {running ? <span className="dp-ag-dot dp-ag-running" /> : <Icon name="sparkles" size={14} />}{running ? 'coco is reading…' : 'Propose rules'}
              </button>
              {data.proposing && !running && <span className={`dp-sm ${data.proposing.error ? 'dp-rules-err' : 'dp-t3'}`}>{data.proposing.error || `Last run: ${data.proposing.added ?? 0} proposed`}</span>}
            </div>
          </div>
        </div>
      </Section>
      {retired.length > 0 && (
        <Section
          title={<button type="button" className="dp-rules-fold" aria-expanded={showRetired} onClick={() => setShowRetired((v) => !v)}><span className={`dp-caret${showRetired ? ' dp-open' : ''}`}><Icon name="chevron-right" size={12} /></span>Retired</button>}
          count={retired.length}
        >
          <div className={`dp-collapse${showRetired ? ' dp-open' : ''}`}><div><div className="dp-rows">{retired.map((r) => <RuleRow key={r.id} r={r} onSet={set} />)}</div></div></div>
        </Section>
      )}
    </Page>
  );
}
