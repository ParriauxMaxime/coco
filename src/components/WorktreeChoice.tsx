import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { useAction, pendingClass } from './action.ts';
import { toast } from './Toast.tsx';
import type { WorkWorktree, WorktreesRemoved } from '../types.ts';

const safe = (w: WorkWorktree) => !w.dirty && !w.unpushed && !w.error;

type Props = {
  slug: string;
  confirmLabel: (ticked: number) => string;
  before?: () => Promise<unknown>;
  onDone: (result: WorktreesRemoved | null) => void;
  secondary?: { label: string; run: () => Promise<unknown> };
};

// the work's worktrees as a checkbox list: dirty or unpushed ones start unticked; nothing is removed before the confirm button
export default function WorktreeChoice({ slug, confirmLabel, before, onDone, secondary }: Props) {
  const [list, setList] = useState<WorkWorktree[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const { pending, busy, run } = useAction();
  useEffect(() => {
    api.worktrees(slug).then((l) => {
      setList(l);
      setTicked(new Set(l.filter(safe).map((w) => w.path)));
    }, (e) => setError(errorMessage(e)));
  }, [slug]);
  const toggle = (p: string) => setTicked((s) => {
    const next = new Set(s);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    return next;
  });
  const confirm = () => run('confirm', async () => {
    await before?.();
    const paths = [...ticked];
    const result = paths.length ? await api.removeWorktrees(slug, paths) : null;
    if (result?.removed.length) toast.success(`Removed ${result.removed.length} worktree${result.removed.length > 1 ? 's' : ''}`);
    for (const k of result?.kept || []) toast.error(`Kept ${k.path}: ${k.why}`);
    for (const u of result?.unarchived || []) toast.error(`Workspace ${u.workspaceId} not archived: ${u.why}`);
    onDone(result);
  });
  if (error) return <div className="status danger">{error}</div>;
  if (!list) return <div className="status"><span className="spinner" aria-hidden /> reading the worktrees…</div>;
  return (
    <div className="wt-choice">
      {list.length === 0 && <div className="status">No worktree left for this work.</div>}
      {list.map((w) => (
        <label key={w.path} className="list-item wt-row">
          <input type="checkbox" checked={ticked.has(w.path)} onChange={() => toggle(w.path)} />
          <span>
            <span className="row">
              <b>{w.title}</b>
              <code>{w.branch || 'detached'}</code>
              {w.dirty > 0 && <span className="chip c-orange">{w.dirty} uncommitted</span>}
              {w.unpushed > 0 && <span className="chip c-red">{w.unpushed} unpushed</span>}
              {w.error && <span className="chip c-red" title={w.error}>state unknown</span>}
            </span>
            <span className="status">{w.path}</span>
          </span>
        </label>
      ))}
      <p className="sub">Ticked worktrees go through <code>git worktree remove</code>, never forced, then their Paseo workspace is archived. Branches and the Paseo project stay.</p>
      <div className="row">
        <button className={`sm primary${pendingClass(pending === 'confirm')}`} disabled={busy || (!before && !ticked.size)} onClick={confirm}>{confirmLabel(ticked.size)}</button>
        {secondary && <button className={`sm${pendingClass(pending === 'secondary')}`} disabled={busy} onClick={() => run('secondary', secondary.run)}>{secondary.label}</button>}
      </div>
    </div>
  );
}
