import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { useAction, pendingClass } from './action.ts';
import { toast } from './Toast.tsx';
import type { DispatchEntry, DispatchResult } from '../types.ts';

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
  onStarted?: (r: DispatchResult) => void;
};

const catalogs = new Map<string, Promise<DispatchEntry[]>>();
const catalogOf = (slug: string) => {
  const hit = catalogs.get(slug) ?? api.dispatchCatalog(slug).then((r) => r.catalog);
  catalogs.set(slug, hit);
  hit.catch(() => catalogs.delete(slug));
  return hit;
};
let logins: Promise<string[]> | null = null;
const personaLogins = () => (logins ??= api.personas().then((list) => list.map((p) => p.login), () => []));

// pick a catalog agent (or a free prompt) and dispatch it; coco places it: read-only in the Plan workspace, the rest in the PR's own
export default function DispatchMenu({ slug, prKey = null, rows = [], personas = [], initial, commentIdsFor, onClose, onStarted }: Props) {
  const [entries, setEntries] = useState<DispatchEntry[] | null>(null);
  const [known, setKnown] = useState<string[]>([]);
  const [id, setId] = useState(initial || 'ask');
  const [key, setKey] = useState<string>(prKey == null ? String(rows[0]?.key ?? '') : String(prKey));
  const [prompt, setPrompt] = useState('');
  const [persona, setPersona] = useState(personas[0] || '');
  const [answer, setAnswer] = useState('');
  const [edits, setEdits] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => {
    catalogOf(slug).then(setEntries, (e) => toast.error(errorMessage(e)));
    personaLogins().then(setKnown);
  }, [slug]);
  if (!entries) return <div className="gate-detail status">Loading the catalog…</div>;
  const entry = entries.find((e) => e.id === id) || entries[0];
  const onPr = key !== '';
  const picked = onPr && entry.kind === 'fix-findings' ? commentIdsFor?.(key) || [] : [];
  const writesBranch = entry.kind === 'prompt' ? onPr && edits : entry.edits;
  const missing = (entry.needsPr && !onPr) || (entry.needsPrompt && !prompt.trim()) || (entry.needsPersona && !persona.trim()) || Boolean(entry.ask && !answer.trim());
  const go = () => run('dispatch', async () => {
    const r = await api.dispatch(slug, { entry: entry.id, key: onPr ? key : null, prompt, persona, edits, ...(entry.ask ? { args: `${answer.trim()} ${key}` } : {}), ...(picked.length ? { commentIds: picked } : {}) });
    toast.success(`Started ${r.title} in the ${r.edits ? 'PR' : 'Plan'} workspace`);
    onStarted?.(r);
    onClose();
  });
  const group = (edit: boolean) => entries.filter((e) => e.edits === edit && e.kind !== 'prompt');
  return (
    <div className="gate-detail dispatch-menu" onClick={(e) => e.stopPropagation()}>
      <div className="row">
        <b>Dispatch</b>
        <select value={entry.id} onChange={(e) => setId(e.target.value)}>
          <optgroup label="Read-only, Plan workspace">{group(false).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</optgroup>
          <optgroup label="On the PR branch, its own workspace">{group(true).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</optgroup>
          {entries.filter((e) => e.kind === 'prompt').map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select>
        {prKey == null && rows.length > 0 && (
          <select value={key} onChange={(e) => setKey(e.target.value)}>
            {!entry.needsPr && <option value="">whole work</option>}
            {rows.map((r) => <option key={r.key} value={String(r.key)}>{r.label}</option>)}
          </select>
        )}
      </div>
      {entry.needsPersona && (
        <div className="row">
          <input list={`dispatch-personas-${slug}`} value={persona} placeholder="persona login" onChange={(e) => setPersona(e.target.value)} />
          <datalist id={`dispatch-personas-${slug}`}>{[...new Set([...personas, ...known])].map((p) => <option key={p} value={p} />)}</datalist>
        </div>
      )}
      {entry.ask && <input value={answer} placeholder={entry.ask} onChange={(e) => setAnswer(e.target.value)} />}
      {entry.kind !== 'fix-findings' && entry.kind !== 'persona-review' && (
        <textarea className="short" value={prompt} placeholder={entry.kind === 'ask' ? 'Your question about this PR' : entry.kind === 'prompt' ? 'The task' : 'Extra instructions (optional)'} onChange={(e) => setPrompt(e.target.value)} />
      )}
      {entry.kind === 'prompt' && onPr && <label className="row status"><input type="checkbox" checked={edits} onChange={(e) => setEdits(e.target.checked)} /> works on the PR branch</label>}
      <div className="row">
        <span className="status">{entry.kind === 'fix-findings' ? `${picked.length ? `${picked.length} picked finding${picked.length > 1 ? 's' : ''}` : 'every open finding of the PR'} · ` : ''}{writesBranch ? 'runs in the PR’s own workspace' : 'read-only, runs in the work’s Plan workspace'}</span>
        <span className="open-side row">
          <button type="button" className="sm" onClick={onClose}>Cancel</button>
          <button type="button" className={`sm primary${pendingClass(busy)}`} disabled={busy || missing} onClick={go}>Dispatch</button>
        </span>
      </div>
    </div>
  );
}
