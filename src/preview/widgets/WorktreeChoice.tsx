import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { pendingClass, useAction } from '../../components/action.ts';
import { toast } from '../../components/Toast.tsx';
import { ErrorNote } from '../pages/Page.tsx';
import type { WorkWorktree, WorktreesRemoved } from '../../types.ts';
import './widgets.css';

const safe = (w: WorkWorktree) => !w.dirty && !w.unpushed && !w.error;

type Props = {
  slug: string;
  confirmLabel: (ticked: number) => string;
  before?: () => Promise<unknown>;
  onDone: (result: WorktreesRemoved | null) => void;
  secondary?: { label: string; run: () => Promise<unknown> };
};

// the work's worktrees as a checklist: dirty or unpushed ones start unticked; nothing is removed before the confirm button
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
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!list) return <div className="dp-wt-load"><span className="dp-ag-dot dp-ag-running" />Reading the worktrees…</div>;
  return (
    <div className="dp-wt">
      {list.length === 0 ? <div className="dp-wt-load">No worktree left for this work.</div> : (
        <div className="dp-rows">
          {list.map((w) => {
            const on = ticked.has(w.path);
            return (
              <label key={w.path} className={`dp-rowi dp-click dp-wt-row${on ? ' dp-on' : ''}`}>
                <input className="dp-vh" type="checkbox" checked={on} onChange={() => toggle(w.path)} />
                <span className="dp-check" />
                <span className="dp-rowi-b">
                  <span className="dp-wt-top">
                    <b className="dp-ell">{w.title}</b>
                    <code>{w.branch || 'detached'}</code>
                    {w.dirty > 0 && <span className="dp-chip dp-warn">{w.dirty} uncommitted</span>}
                    {w.unpushed > 0 && <span className="dp-chip dp-bad">{w.unpushed} unpushed</span>}
                    {w.error && <span className="dp-chip dp-bad" title={w.error}>state unknown</span>}
                  </span>
                  <span className="dp-wt-path">{w.path}</span>
                </span>
              </label>
            );
          })}
        </div>
      )}
      <p className="dp-wt-note">Ticked worktrees go through <code>git worktree remove</code>, never forced, then their Paseo workspace is archived. Branches and the Paseo project stay.</p>
      <div className="dp-row dp-g6">
        <button type="button" className={`dp-btn dp-primary dp-sm${pendingClass(pending === 'confirm')}`} disabled={busy || (!before && !ticked.size)} onClick={confirm}>{confirmLabel(ticked.size)}</button>
        {secondary && <button type="button" className={`dp-btn dp-sm${pendingClass(pending === 'secondary')}`} disabled={busy} onClick={() => run('secondary', secondary.run)}>{secondary.label}</button>}
      </div>
    </div>
  );
}
