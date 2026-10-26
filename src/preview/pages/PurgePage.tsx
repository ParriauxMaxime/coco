import React, { useEffect, useState } from 'react';
import { errorMessage } from '../../api.ts';
import Icon from '../Icon.tsx';
import type { IconName } from '../Icon.tsx';
import { workHref } from '../prefs.ts';
import { Empty, ErrorNote, Loading, Page, PageHead, Section, Tiles } from './Page.tsx';
import './purge.css';

type Kind = 'agent' | 'worktree' | 'workspace';
type Fact = { text: string; tone?: 'ok' | 'warn' | 'bad' | 'info' };
type Item = {
  id: string;
  kind: Kind;
  title: string;
  status: string;
  activityAt: string | null;
  where: { repo?: string; work?: { slug: string; title: string }; pr?: string; path?: string };
  facts: Fact[];
  recommendation: 'purge' | 'keep';
  reason: string;
  locked: boolean;
};
type PurgeList = { items: Item[]; at: string; errors: string[] };
type Result = { kind: Kind; id: string; ok: boolean; error?: string; note?: string };

const KINDS: { kind: Kind; title: string; icon: IconName; act: string; empty: string }[] = [
  { kind: 'agent', title: 'Agents', icon: 'bot', act: 'archived in Paseo', empty: 'No Paseo agent left to sort.' },
  { kind: 'worktree', title: 'Worktrees', icon: 'git-branch', act: 'removed with git worktree remove (never forced), then their Paseo workspaces archived', empty: 'No git worktree besides the main checkouts.' },
  { kind: 'workspace', title: 'Workspaces', icon: 'folder', act: 'archived in Paseo', empty: 'No Paseo workspace.' },
];
const DOT: Record<string, string> = { running: 'dp-ag-running', initializing: 'dp-ag-running', waiting: 'dp-ag-waiting', idle: 'dp-ag-done', error: 'dp-ag-failed', clean: 'dp-ag-done', dirty: 'dp-ag-waiting', live: 'dp-ag-done', gone: 'dp-ag-failed' };
const keyOf = (i: { kind: Kind; id: string }) => `${i.kind}:${i.id}`;
const tilde = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

async function load(fresh: boolean): Promise<PurgeList> {
  const res = await fetch(`/api/purge${fresh ? '?refresh=1' : ''}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
}
async function purge(items: { kind: Kind; id: string; force?: boolean }[]): Promise<Result[]> {
  const res = await fetch('/api/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body.results;
}

function Row({ item, on, result, onToggle }: { item: Item; on: boolean; result?: Result; onToggle: () => void }) {
  const { where } = item;
  const off = item.locked || Boolean(result?.ok);
  return (
    <div className={`dp-rowi dp-purge-row${on ? ' dp-on' : ''}${result?.ok ? ' dp-purge-gone' : ''}`}>
      <button type="button" className={`dp-purge-tick${on ? ' dp-on' : ''}`} disabled={off} aria-pressed={on} aria-label={`${on ? 'Unselect' : 'Select'} ${item.title}`} title={item.locked ? 'Protected: never purged' : undefined} onClick={onToggle}><span className="dp-check" /></button>
      <span className={`dp-ag-dot ${DOT[item.status] || 'dp-ag-archived'}`} title={item.status} />
      <span className="dp-rowi-b">
        <span className="dp-purge-t"><span className="dp-ell">{item.title}</span><span className="dp-purge-facts">{item.facts.map((f, i) => <span key={i} className={`dp-chip${f.tone ? ` dp-${f.tone}` : ''}`}>{f.text}</span>)}</span></span>
        <span className="dp-purge-where">
          {where.repo && <span className="dp-purge-w">{where.repo}</span>}
          {where.work && <a className="dp-purge-w dp-purge-link dp-ell" href={workHref(where.work.slug)}><Icon name="layers" size={12} />{where.work.title}</a>}
          {where.pr && <span className="dp-purge-w">{where.pr}</span>}
          {where.path && <span className="dp-purge-path dp-ell" title={where.path}>{tilde(where.path)}</span>}
        </span>
      </span>
      <span className="dp-purge-rec">
        {result ? (
          <span className={`dp-chip ${result.ok ? 'dp-ok' : 'dp-bad'}`}><Icon name={result.ok ? 'check' : 'alert-triangle'} size={12} />{result.ok ? 'done' : 'failed'}</span>
        ) : item.locked ? (
          <span className="dp-chip">protected</span>
        ) : (
          <span className={`dp-chip${item.recommendation === 'purge' ? ' dp-warn' : ''}`}>{item.recommendation}</span>
        )}
        <span className={`dp-purge-why${result && !result.ok ? ' dp-purge-err' : ''}`}>{result ? result.error || result.note || item.reason : item.reason}</span>
      </span>
    </div>
  );
}

function Confirm({ items, onCancel, onGo }: { items: Item[]; onCancel: () => void; onGo: (force: boolean) => void }) {
  const [force, setForce] = useState(false);
  const recommended = items.filter((i) => i.recommendation === 'purge');
  const kept = items.filter((i) => i.recommendation === 'keep');
  const sending = recommended.length + (force ? kept.length : 0);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, []);
  const list = (of: Item[]) => KINDS.map((k) => {
    const mine = of.filter((i) => i.kind === k.kind);
    return mine.length ? (
      <div key={k.kind} className="dp-purge-cgrp">
        <div className="dp-purge-ch"><Icon name={k.icon} size={12} />{mine.length} {k.title.toLowerCase()} {k.act}</div>
        <ul>{mine.slice(0, 6).map((i) => <li key={i.id} className="dp-ell">{i.title}<span className="dp-t3"> · {i.reason}</span></li>)}{mine.length > 6 && <li className="dp-t3">and {mine.length - 6} more</li>}</ul>
      </div>
    ) : null;
  });
  return (
    <div className="dp-purge-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dp-dialog dp-purge-dialog" role="dialog" aria-modal="true" aria-labelledby="dp-purge-dh">
        <div className="dp-dh" id="dp-purge-dh">Purge {sending} {sending === 1 ? 'item' : 'items'}?</div>
        <div className="dp-db">
          <p className="dp-purge-lead">Each item is checked again first; one whose recommendation changed is skipped.</p>
          {list(recommended)}
          {kept.length > 0 && (
            <div className="dp-purge-kept">
              <div className="dp-purge-ch dp-purge-warn"><Icon name="alert-triangle" size={12} />{kept.length} recommended to keep</div>
              {list(kept)}
              <label className="dp-purge-force"><button type="button" className={`dp-purge-tick${force ? ' dp-on' : ''}`} aria-pressed={force} onClick={() => setForce(!force)}><span className="dp-check" /></button>Purge these too, against the recommendation</label>
            </div>
          )}
        </div>
        <div className="dp-df">
          <button type="button" className="dp-btn" onClick={onCancel} autoFocus>Cancel</button>
          <button type="button" className="dp-btn dp-primary dp-purge-go" disabled={!sending} onClick={() => onGo(force)}><Icon name="trash" size={14} />Purge {sending}</button>
        </div>
      </div>
    </div>
  );
}

export default function PurgePage() {
  const [data, setData] = useState<PurgeList | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [working, setWorking] = useState(false);
  const [results, setResults] = useState<Map<string, Result>>(new Map());
  const refresh = (fresh: boolean) => {
    setBusy(true);
    return load(fresh).then((d) => { setData(d); setErr(''); setResults(new Map()); setPicked(new Set()); }, (e) => setErr(errorMessage(e))).finally(() => setBusy(false));
  };
  useEffect(() => { void refresh(false); }, []);

  const items = data?.items || [];
  const open = items.filter((i) => !i.locked && !results.get(keyOf(i))?.ok);
  const recommended = open.filter((i) => i.recommendation === 'purge');
  const chosen = items.filter((i) => picked.has(keyOf(i)));
  const toggle = (i: Item) => setPicked((s) => { const n = new Set(s); n.has(keyOf(i)) ? n.delete(keyOf(i)) : n.add(keyOf(i)); return n; });
  const selectRecommended = () => setPicked(new Set(recommended.map(keyOf)));
  const run = async (force: boolean) => {
    setConfirm(false);
    setWorking(true);
    try {
      const body = chosen.filter((i) => i.recommendation === 'purge' || force).map((i) => ({ kind: i.kind, id: i.id, ...(i.recommendation === 'keep' ? { force: true } : {}) }));
      const out = await purge(body);
      setResults(new Map(out.map((r) => [keyOf(r), r])));
      setPicked(new Set());
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setWorking(false);
    }
  };

  const head = (
    <PageHead
      icon="trash"
      title="Purge"
      sub="What can be cleaned off this machine: Paseo agents, git worktrees and Paseo workspaces, each with a recommendation and its reason. Nothing is archived or removed until you pick it, click Purge and confirm."
      actions={<button type="button" className="dp-btn" disabled={busy} onClick={() => void refresh(true)}><span className={busy ? 'dp-purge-spin' : 'dp-purge-ic'}><Icon name="refresh" size={14} /></span>Refresh</button>}
    />
  );
  if (!data) return <Page>{head}{err ? <ErrorNote>{err}</ErrorNote> : <Loading what="Reading agents, worktrees and workspaces…" />}</Page>;

  const count = (k: Kind) => recommended.filter((i) => i.kind === k).length;
  const done = [...results.values()];
  return (
    <Page>
      {head}
      <Tiles items={[
        ...KINDS.map((k) => ({ label: `${k.title} to purge`, value: count(k.kind), hint: `of ${items.filter((i) => i.kind === k.kind).length} listed`, tone: count(k.kind) ? ('warn' as const) : undefined })),
        { label: 'Selected', value: chosen.length, hint: chosen.some((i) => i.recommendation === 'keep') ? 'some against the advice' : 'nothing goes until you confirm', tone: chosen.length ? ('acc' as const) : undefined },
      ]} />

      <div className="dp-purge-bar">
        <div className="dp-seg">
          <button type="button" className={all ? '' : 'dp-on'} onClick={() => setAll(false)}>Recommended <span className="dp-t3">{recommended.length}</span></button>
          <button type="button" className={all ? 'dp-on' : ''} onClick={() => setAll(true)}>All <span className="dp-t3">{items.length}</span></button>
        </div>
        {done.length > 0 && <span className="dp-purge-sum">{done.filter((r) => r.ok).length} purged{done.some((r) => !r.ok) ? `, ${done.filter((r) => !r.ok).length} failed` : ''} · refresh to rescan</span>}
        <span className="dp-grow" />
        <button type="button" className="dp-btn" disabled={!recommended.length || working} onClick={selectRecommended}><Icon name="check" size={14} />Select recommended</button>
        {chosen.length > 0 && <button type="button" className="dp-btn dp-ghost" onClick={() => setPicked(new Set())}>Clear</button>}
        <button type="button" className="dp-btn dp-primary dp-purge-go" disabled={!chosen.length || working} onClick={() => setConfirm(true)}><Icon name="trash" size={14} />{working ? 'Purging…' : `Purge selected (${chosen.length})`}</button>
      </div>

      {err && <ErrorNote>{err}</ErrorNote>}
      {data.errors.map((e) => <ErrorNote key={e}>{e}</ErrorNote>)}

      {KINDS.map((k) => {
        const mine = items.filter((i) => i.kind === k.kind);
        const shown = mine.filter((i) => all || i.recommendation === 'purge' || picked.has(keyOf(i)) || results.has(keyOf(i)));
        return (
          <Section key={k.kind} title={<span className="dp-row dp-g6"><Icon name={k.icon} size={14} />{k.title}</span>} count={mine.length} meta={count(k.kind) ? `${count(k.kind)} to purge` : 'nothing to purge'}>
            {shown.length ? <div className="dp-rows">{shown.map((i) => <Row key={i.id} item={i} on={picked.has(keyOf(i))} result={results.get(keyOf(i))} onToggle={() => toggle(i)} />)}</div>
              : <Empty icon={k.icon}>{mine.length ? `Nothing recommended for purge; ${mine.length} kept under All.` : k.empty}</Empty>}
          </Section>
        );
      })}
      {confirm && <Confirm items={chosen} onCancel={() => setConfirm(false)} onGo={(force) => void run(force)} />}
    </Page>
  );
}
