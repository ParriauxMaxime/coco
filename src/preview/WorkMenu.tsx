import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.ts';
import { toast } from '../components/Toast.tsx';
import { choose } from '../components/Dialogs.tsx';
import Icon from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { reloadOverview } from './overview.ts';
import { workHref } from './prefs.ts';
import type { WorkSummary } from '../types.ts';

type Item = { label: string; icon: IconName; run: () => unknown; danger?: boolean };

// the ⋯ of a sidebar work, shown on hover: open, refresh, copy its link, archive, clean up, delete
export default function WorkMenu({ w }: { w: WorkSummary }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!at) return undefined;
    const close = (e: Event) => !(e.target instanceof Element && e.target.closest('.dp-workmenu')) && setAt(null);
    addEventListener('mousedown', close);
    addEventListener('keydown', close);
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', close); };
  }, [at]);

  const act = (fn: () => Promise<unknown>, done: string) => fn().then(() => (toast.success(done), reloadOverview()), (e) => toast.error(errorMessage(e)));
  const remove = async () => {
    const full = await choose({
      title: `Delete the work "${w.title}"?`,
      body: <>
        <p>coco forgets its stack, decisions and notes; its PRs and branches stay on GitHub.</p>
        <p>Delete everything also removes its folder (threads, findings, artifacts, videos), and the plan worktree and Paseo project coco made for it, with that project's workspaces and agents. A Paseo project of your own stays.</p>
      </>,
      choices: [{ label: 'Forget the work only', value: false }, { label: 'Delete everything', value: true, danger: true }],
    });
    if (full === null) return;
    api.deleteWork(w.slug, full).then(
      (r) => {
        toast.success([`Deleted ${w.title}`, ...r.done].join(' · '));
        reloadOverview();
        if (location.hash.startsWith(workHref(w.slug))) location.hash = '#/';
      },
      (e) => toast.error(errorMessage(e)),
    );
  };
  const items: Item[][] = [
    [
      { label: 'Open overview', icon: 'home', run: () => { location.hash = workHref(w.slug); } },
      { label: 'Refresh from GitHub', icon: 'refresh', run: () => act(() => api.work(w.slug, true), `${w.title}: refreshed`) },
      { label: 'Copy link', icon: 'copy', run: () => navigator.clipboard?.writeText(`${location.origin}/${workHref(w.slug)}`).then(() => toast.success('Link copied')) },
    ],
    [
      { label: w.archived ? 'Unarchive' : 'Archive', icon: 'archive', run: () => act(() => api.archiveWork(w.slug, !w.archived), w.archived ? `${w.title} is back` : `${w.title} archived`) },
      { label: 'Clean up worktrees and agents…', icon: 'trash', run: () => { location.hash = '#/purge'; } },
      { label: 'Delete work…', icon: 'trash', run: remove, danger: true },
    ],
  ];

  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = button.current?.getBoundingClientRect();
    setAt(at || !r ? null : { top: r.bottom + 4, left: Math.min(r.left, innerWidth - 240) });
  };
  return (
    <>
      <button ref={button} type="button" className={`dp-ibtn dp-work-more${at ? ' dp-on' : ''}`} title="More" aria-label="More actions" onClick={open}><Icon name="more-horizontal" size={14} /></button>
      {at && createPortal(
        <div className="dp dp-float">
          <div className="dp-pop dp-on dp-workmenu" style={{ position: 'fixed', top: at.top, left: at.left }}>
            {items.map((group, i) => (
              <div key={i} className="dp-pop-s">
                {group.map((it) => (
                  <div key={it.label} className={`dp-mi${it.danger ? ' dp-danger' : ''}`} onClick={() => { setAt(null); it.run(); }}><Icon name={it.icon} size={14} /><span>{it.label}</span></div>
                ))}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
