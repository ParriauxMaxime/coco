import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon.tsx';
import { openLauncher } from './launcher.ts';

// a work's New agent: Ask coco (reads, answers, proposes) or a free agent from the launcher, in the work's place
export default function NewAgentMenu({ onAsk, place }: { onAsk: () => void; place: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => { if (!(e.target instanceof Node && box.current?.contains(e.target))) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('mousedown', away);
    addEventListener('keydown', esc);
    return () => {
      removeEventListener('mousedown', away);
      removeEventListener('keydown', esc);
    };
  }, [open]);
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <span className="dp-newmenu" ref={box}>
      <button type="button" className={`dp-btn dp-sm${open ? ' dp-on' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="bot" size={14} />New agent<Icon name="chevron-down" size={12} /></button>
      {open && (
        <div className="dp-pop dp-on dp-newmenu-pop" role="menu">
          <div className="dp-pop-s">
            <div role="menuitem" className="dp-mi dp-newmenu-mi" onClick={pick(onAsk)}>
              <span className="dp-cocoav">c</span>
              <span className="dp-newmenu-t"><b>Ask coco</b><span className="dp-xs dp-t3">Reads the work, its PRs and code; answers and proposes</span></span>
            </div>
            <div role="menuitem" className="dp-mi dp-newmenu-mi" onClick={pick(() => openLauncher({ place }))}>
              <span className="dp-bot"><Icon name="bot" size={12} /></span>
              <span className="dp-newmenu-t"><b>Agent</b><span className="dp-xs dp-t3">A free session in the work's Plan, a PR's worktree or a repo, as in Paseo</span></span>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
