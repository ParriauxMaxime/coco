import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { useAction } from './action.ts';
import { toast } from './Toast.tsx';
import { Composer } from '../preview/chat/Composer.tsx';
import { ModelControls, useModelChoice } from '../preview/chat/ModelPicker.tsx';
import { loadPersonas } from '../preview/parts.tsx';
import type { DispatchEntry, PreflightResult } from '../types.ts';
import './parts.css';

type Key = string | number;
type Props = {
  slug: string;
  // the PR it dispatches on; without one, rows lets the user pick a PR (or the whole work, for a free prompt)
  prKey?: Key | null;
  rows?: { key: Key; label: string }[];
  personas?: string[];
  initial?: string;
  // picked findings of a PR, for fix findings; none = every open one
  commentIdsFor?: (key: Key) => string[];
  onClose: () => void;
};

const catalogs = new Map<string, Promise<DispatchEntry[]>>();
const catalogOf = (slug: string) => {
  const hit = catalogs.get(slug) ?? api.dispatchCatalog(slug).then((r) => r.catalog);
  catalogs.set(slug, hit);
  hit.catch(() => catalogs.delete(slug));
  return hit;
};

// pick a catalog agent (or a free prompt) and dispatch it; coco places it: read-only in the Plan workspace, the rest in the PR's own
export default function DispatchMenu({ slug, prKey = null, rows = [], personas = [], initial, commentIdsFor, onClose }: Props) {
  const [entries, setEntries] = useState<DispatchEntry[] | null>(null);
  const [known, setKnown] = useState<string[]>([]);
  const [id, setId] = useState(initial || 'ask');
  const [key, setKey] = useState<string>(prKey == null ? String(rows[0]?.key ?? '') : String(prKey));
  const [persona, setPersona] = useState(personas[0] || '');
  const [answer, setAnswer] = useState('');
  const [edits, setEdits] = useState(false);
  const { busy, run } = useAction();
  const model = useModelChoice(`dispatch-${id}`, { fast: id === 'persona-review' });
  useEffect(() => {
    catalogOf(slug).then(setEntries, (e) => toast.error(errorMessage(e)));
    loadPersonas().then((list) => setKnown(list.map((p) => p.login)));
  }, [slug]);
  const video = id.startsWith('gate:kit-video:') && key !== '';
  const [pre, setPre] = useState<PreflightResult | null>(null);
  useEffect(() => {
    setPre(null);
    if (video) api.preflight(slug, id, key).then(setPre, () => setPre(null));
  }, [slug, id, key, video]);
  const red = Boolean(pre?.checks.some((c) => !c.ok));
  if (!entries) return <div className="dp-dsp dp-dsp-load">Loading the catalog…</div>;
  const entry = entries.find((e) => e.id === id) || entries[0];
  const onPr = key !== '';
  const picked = onPr && entry.kind === 'fix-findings' ? commentIdsFor?.(key) || [] : [];
  const writesBranch = entry.kind === 'prompt' ? onPr && edits : entry.edits;
  const noText = entry.kind === 'fix-findings' || entry.kind === 'persona-review';
  const missing = (entry.needsPr && !onPr) || (entry.needsPersona && !persona.trim()) || Boolean(entry.ask && !answer.trim());
  const go = (prompt: string) => run('dispatch', async () => {
    const r = await api.dispatch(slug, { entry: entry.id, key: onPr ? key : null, prompt: noText ? '' : prompt, persona, edits, ...(entry.ask ? { args: `${answer.trim()} ${key}` } : {}), ...(picked.length ? { commentIds: picked } : {}), ...model.body() });
    toast.success(`Starting ${r.job.label}: it shows in the status bar until it is done`);
    onClose();
    return r;
  });
  const group = (edit: boolean) => entries.filter((e) => e.edits === edit && e.kind !== 'prompt');
  return (
    <div className="dp-dsp" onClick={(e) => e.stopPropagation()}>
      <div className="dp-dsp-r">
        <b>New agent</b>
        <select className="dp-inp" value={entry.id} aria-label="Agent" onChange={(e) => setId(e.target.value)}>
          <optgroup label="Read-only, Plan workspace">{group(false).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</optgroup>
          <optgroup label="On the PR branch, its own workspace">{group(true).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</optgroup>
          {entries.filter((e) => e.kind === 'prompt').map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select>
        {prKey == null && rows.length > 0 && (
          <select className="dp-inp" value={key} aria-label="PR" onChange={(e) => setKey(e.target.value)}>
            {!entry.needsPr && <option value="">whole work</option>}
            {rows.map((r) => <option key={r.key} value={String(r.key)}>{r.label}</option>)}
          </select>
        )}
      </div>
      {entry.needsPersona && (
        <div className="dp-dsp-r">
          <input className="dp-inp" list={`dispatch-personas-${slug}`} value={persona} placeholder="persona login" onChange={(e) => setPersona(e.target.value)} />
          <datalist id={`dispatch-personas-${slug}`}>{[...new Set([...personas, ...known])].map((p) => <option key={p} value={p} />)}</datalist>
        </div>
      )}
      {video && (
        <ul className="dp-dsp-pre" aria-label="Preflight">
          {pre ? pre.checks.map((c) => <li key={c.name} className={c.ok ? 'dp-ok' : 'dp-bad'}>{c.ok ? '✓' : '✕'} <b>{c.name}</b> {c.detail}{!c.ok && c.fix ? ` · fix: ${c.fix}` : ''}</li>) : <li>Checking…</li>}
        </ul>
      )}
      {entry.ask && <input className="dp-inp" value={answer} placeholder={entry.ask} onChange={(e) => setAnswer(e.target.value)} />}
      {entry.kind === 'prompt' && onPr && <label className="dp-dsp-chk"><input type="checkbox" checked={edits} onChange={(e) => setEdits(e.target.checked)} />works on the PR branch</label>}
      <Composer
        key={entry.id}
        draft={`dispatch:${slug}:${key}:${entry.id}`}
        autoFocus
        attach={false}
        allowEmpty={!entry.needsPrompt}
        withText={!noText}
        placeholder={entry.kind === 'ask' ? 'Your question about this PR (↵)' : entry.kind === 'prompt' ? 'The task (↵)' : 'Extra instructions, optional (↵)'}
        note={`${entry.kind === 'fix-findings' ? `${picked.length ? `${picked.length} picked finding${picked.length > 1 ? 's' : ''}` : 'every open finding of the PR'} · ` : ''}${writesBranch ? 'runs in the PR’s own workspace' : 'read-only, runs in the work’s Plan workspace'}`}
        busy={missing}
        sending={busy}
        sendLabel={busy ? 'Writing the brief…' : red ? 'Start anyway' : 'Start agent'}
        tools={<ModelControls choice={model.choice} onPick={model.pick} hint="for the agent this starts" />}
        actions={() => <button type="button" className="dp-btn dp-sm dp-ghost" onClick={onClose}>Cancel</button>}
        onSend={async (text) => (await go(text)) !== undefined}
      />
    </div>
  );
}
