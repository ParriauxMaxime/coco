import { useEffect, useState } from 'react';
import { useWorkbench } from '../workbench-store.ts';
import { reviewApi } from './use-comments.ts';
import { keyLabel } from './ids.ts';
import { useConfig } from '../../config.ts';
import { pendingClass } from '../../components/action.ts';
import { errorMessage } from '../../api.ts';
import type { StackFixOpenRow, StackFixRun, StackFixState } from '../types.ts';
import './code.css';

const POLL_MS = 5000;
const STATUS_CHIP: Record<string, string> = { running: 'c-orange', done: 'c-green', failed: 'c-red' };

export function useStackFix(slug: string, live: boolean) {
  const [state, setState] = useState<StackFixState>({ runs: [], open: [] });
  const [nonce, setNonce] = useState(0);
  const running = state.runs.some((r) => r.status === 'running');
  useEffect(() => {
    if (!live) return undefined;
    let on = true;
    const load = () => reviewApi.stackFix(slug).then((s) => on && setState(s)).catch(() => {});
    load();
    const t = setInterval(load, running ? POLL_MS : 30000);
    return () => { on = false; clearInterval(t); };
  }, [slug, live, running, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

export const openStackRun = (id: string, group: number) => useWorkbench.getState().open(`stack-${id}`, { group });

export function StackRunLink({ run, onOpen }: { run: StackFixRun; onOpen: (id: string) => void }) {
  return (
    <span className="status">
      <a href="#" onClick={(e) => { e.preventDefault(); onOpen(run.id); }}>stack fix {run.id}</a> <span className={`chip ${STATUS_CHIP[run.status] || 'c-grey'}`}>{run.status}</span> {new Date(run.startedAt).toLocaleString()}
      {run.pushWarned && <span className="chip c-red">remote head moved</span>}
    </span>
  );
}

// select 'accepted': only the findings accepted on the board, with their triage
type FixDialogProps = { slug: string; open: StackFixOpenRow[]; select?: string; onClose: () => void; onSent: (run: StackFixRun) => void };

export function FixDialog({ slug, open, select, onClose, onSent }: FixDialogProps) {
  const accepted = select === 'accepted';
  const countOf = (r: StackFixOpenRow) => (accepted ? r.accepted || 0 : r.count);
  const chain = open.slice(Math.max(0, open.findIndex(countOf)));
  const [commits, setCommits] = useState('one');
  const models = useConfig((s) => s.models);
  const providers = [...new Set([models.default, models.fast].filter(Boolean))];
  const [picked, setProvider] = useState('');
  const provider = picked || providers[0] || '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const total = open.reduce((n, r) => n + countOf(r), 0);
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      onSent(await reviewApi.startStackFix(slug, { commits, ...(select ? { select } : {}), ...(provider ? { provider } : {}) }));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div className="cc-scrim" onMouseDown={() => !busy && onClose()}>
      <div className="card cc-dialog" role="dialog" aria-label={accepted ? 'Fix accepted findings' : 'Fix all comments'} onMouseDown={(e) => e.stopPropagation()}>
        <b>{accepted ? 'Fix accepted findings' : 'Fix all comments'} · one agent, bottom-up</b>
        <ul className="sd-list">
          {chain.map((r, i) => <li key={r.key}><code>{i + 1}</code> {keyLabel(r.key)} · {countOf(r) ? `${countOf(r)} ${accepted ? 'accepted' : 'open'}` : 'restack only when its parent moves'}</li>)}
        </ul>
        <div className="row">
          <label className="row"><input type="radio" name="sf-commits" checked={commits === 'one'} onChange={() => setCommits('one')} /> one commit per comment</label>
          <label className="row"><input type="radio" name="sf-commits" checked={commits === 'squash'} onChange={() => setCommits('squash')} /> one commit per row</label>
          {providers.length > 0 && <select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ marginLeft: 'auto' }}>{providers.map((p) => <option key={p}>{p}</option>)}</select>}
        </div>
        <pre className="sd-preview">{`${total} ${accepted ? 'accepted findings, with their notes and threads' : 'comments'} · row 1 first, each row fixed on its branch, children restacked with git rebase --onto\na restack conflict stops the chain · never push, never post`}</pre>
        {error && <div className="card danger" style={{ margin: '8px 0 0' }}>{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="sm" disabled={busy} onClick={onClose}>Cancel</button>
          <button className={`sm primary${pendingClass(busy)}`} disabled={busy || !total} onClick={send}>Start</button>
        </div>
      </div>
    </div>
  );
}
