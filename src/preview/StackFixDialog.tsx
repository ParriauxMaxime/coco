import { useEffect, useState } from 'react';
import { reviewApi } from '../workbench/code/use-comments.ts';
import { keyLabel } from '../workbench/code/ids.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import { useConfig } from '../config.ts';
import { pendingClass } from '../components/action.ts';
import { errorMessage } from '../api.ts';
import type { StackFixOpenRow, StackFixRun, StackFixState } from '../workbench/types.ts';
import Icon from './Icon.tsx';
import Modal from './Modal.tsx';
import { ErrorNote } from './pages/Page.tsx';
import { ago, stamp } from './format.ts';
import './findings.css';

const POLL_MS = 5000;
const RUN_TONE: Record<string, string> = { running: 'dp-warn', done: 'dp-ok', failed: 'dp-bad' };

export function useStackFix(slug: string, live: boolean) {
  const [state, setState] = useState<StackFixState>({ runs: [], open: [] });
  const [nonce, setNonce] = useState(0);
  const running = state.runs.some((r) => r.status === 'running');
  useEffect(() => {
    if (!live) return undefined;
    let on = true;
    const load = () => reviewApi.stackFix(slug).then((s: StackFixState) => on && setState(s)).catch(() => {});
    load();
    const t = setInterval(load, running ? POLL_MS : 30000);
    return () => { on = false; clearInterval(t); };
  }, [slug, live, running, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

export const openStackRun = (id: string) => {
  const s = useWorkbench.getState();
  s.open(`stack-${id}`, { group: s.otherGroup() });
};

export function StackRunChip({ run }: { run: StackFixRun }) {
  return (
    <button type="button" className="dp-btn dp-ghost dp-sm dp-sf-run" title={`Stack fix ${run.id}, started ${stamp(run.startedAt)}: open its tab`} onClick={() => openStackRun(run.id)}>
      <Icon name="git-branch" size={12} />Stack fix
      <span className={`dp-chip ${RUN_TONE[run.status] || ''}`}>{run.status}</span>
      {run.pushWarned && <span className="dp-chip dp-bad">remote head moved</span>}
      <span className="dp-t3 dp-num">{ago(run.startedAt)}</span>
    </button>
  );
}

type FixDialogProps = { slug: string; open: StackFixOpenRow[]; select?: 'accepted'; onClose: () => void; onSent: (run: StackFixRun) => void };

export function FixDialog({ slug, open, select, onClose, onSent }: FixDialogProps) {
  const accepted = select === 'accepted';
  const countOf = (r: StackFixOpenRow) => (accepted ? r.accepted || 0 : r.count);
  const chain = open.slice(Math.max(0, open.findIndex(countOf)));
  const total = open.reduce((n, r) => n + countOf(r), 0);
  const [commits, setCommits] = useState<'one' | 'squash'>('one');
  const models = useConfig((s) => s.models);
  const providers = [...new Set([models.default, models.fast].filter(Boolean))];
  const [picked, setProvider] = useState('');
  const provider = picked || providers[0] || '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
  const unit = accepted ? 'finding' : 'comment';
  return (
    <Modal title={accepted ? 'Fix accepted findings' : 'Fix all comments'} wide busy={busy} onClose={onClose} foot={
      <>
        <button type="button" className="dp-btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className={`dp-btn dp-primary${pendingClass(busy)}`} disabled={busy || !total} onClick={send}><Icon name="wrench" size={14} />Start fix · {total}</button>
      </>
    }>
      <p className="dp-keep-lead">One agent works bottom-up: row 1 first, each row fixed on its own branch, its children restacked with <code>git rebase --onto</code>. {accepted ? 'Each accepted finding goes with its board note and thread. ' : ''}A restack conflict stops the chain. Nothing is pushed or posted.</p>
      <ol className="dp-sf-rows">
        {chain.map((r, i) => (
          <li key={String(r.key)}>
            <span className="dp-sf-i dp-num">{i + 1}</span>
            <b title={keyLabel(r.key)}>{keyLabel(r.key)}</b>
            <span className="dp-t3">{countOf(r) ? `${countOf(r)} ${accepted ? 'accepted' : 'open'}` : 'restack only, if its parent moves'}</span>
          </li>
        ))}
      </ol>
      <div className="dp-sf-opts">
        <span className="dp-seg" role="group" aria-label="Commits">
          <button type="button" className={commits === 'one' ? 'dp-on' : 'dp-off'} onClick={() => setCommits('one')}>One commit per {unit}</button>
          <button type="button" className={commits === 'squash' ? 'dp-on' : 'dp-off'} onClick={() => setCommits('squash')}>One commit per row</button>
        </span>
        {providers.length > 1 && (
          <span className="dp-seg" role="group" aria-label="Model">
            {providers.map((p) => <button key={p} type="button" className={provider === p ? 'dp-on' : 'dp-off'} onClick={() => setProvider(p)}>{p}</button>)}
          </span>
        )}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}
