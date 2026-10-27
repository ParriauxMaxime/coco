import React from 'react';
import Fold from './Fold.tsx';
import FileList from './FileList.tsx';
import { CATEGORIES } from './review-order.ts';
import type { ReviewHandle } from './use-comments.ts';
import type { FileGroup, RefFile } from '../types.ts';
import './code.css';

export type OrderState = {
  mode: string;
  setMode: (mode: string) => void;
  groups: FileGroup[] | null;
  hidden: string[];
  onToggleCat: (category: string) => void;
  catCounts: Record<string, number>;
  ticks: Set<string>;
};

export const TONE: Record<string, string> = { open: 'dp-info', sent: 'dp-warn', fixed: 'dp-ok', declined: 'dp-bad', outdated: '', running: 'dp-warn', done: 'dp-ok' };

function OrderBar({ planned, mode, setMode, catCounts, hidden, onToggleCat }: OrderState & { planned: boolean }) {
  return (
    <div className="rv-order">
      <span className="dp-seg" role="group" aria-label="File order">
        <button type="button" className={mode === 'suggested' ? 'dp-on' : 'dp-off'} onClick={() => setMode('suggested')}>{planned ? 'Plan' : 'Suggested'}</button>
        <button type="button" className={mode === 'tree' ? 'dp-on' : 'dp-off'} onClick={() => setMode('tree')}>Tree</button>
      </span>
      <div className="dp-filters rv-cats">
        {CATEGORIES.filter((c) => catCounts[c]).map((c) => {
          const off = hidden.includes(c);
          return (
            <button key={c} type="button" className={`rv-cat-${c}${off ? ' dp-off' : ' dp-on'}`} aria-pressed={!off} title={off ? `Show ${c} files` : `Hide ${c} files`} onClick={() => onToggleCat(c)}>
              <span className="dp-dot" />{c} <span>{catCounts[c]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// left pane of the Review tab: the changed files in suggested review order (or as a tree), ticks and comment counts; folded on phone
type Props = {
  files: RefFile[];
  shown: RefFile[];
  order: OrderState;
  rv: ReviewHandle;
  activePath: string | null;
  onPick: (path: string) => void;
  phone?: boolean;
};

export default function ReviewSidebar({ files, shown, order, rv, activePath, onPick, phone = false }: Props) {
  const add = files.reduce((s, f) => s + f.additions, 0);
  const del = files.reduce((s, f) => s + f.deletions, 0);
  const bar = rv.plan && <OrderBar planned={Boolean(rv.plan.plan)} {...order} />;
  const tree = rv.refs ? <FileList files={shown} groups={order.groups} ticks={order.ticks} cats={rv.plan?.categories} activePath={activePath} commentsByPath={rv.byPath} onOpen={(p) => onPick(p)} follow={!phone} /> : <span className="dp-xs dp-t3">{rv.error ? '' : 'Loading files…'}</span>;
  const reviewed = order.ticks.size > 0 ? files.filter((f) => order.ticks.has(f.filename)).length : 0;
  if (phone) return <Fold title={`Files · ${files.length}`} badge={`+${add} −${del}`}>{bar}{tree}</Fold>;
  return (
    <aside className="rv-side">
      <div className="rv-side-stat">
        <b>{files.length} files</b>
        <span className="dp-mono"><span className="dp-add">+{add}</span> <span className="dp-del">−{del}</span></span>
        {reviewed > 0 && <span className="dp-sp" />}
        {reviewed > 0 && <span className="dp-num" title="Files ticked reviewed">{reviewed}/{files.length} reviewed</span>}
      </div>
      {bar}
      <div className="rv-tree">{tree}</div>
    </aside>
  );
}
