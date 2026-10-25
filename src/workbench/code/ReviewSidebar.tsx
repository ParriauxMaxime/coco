import React from 'react';
import Collapsible from '../../components/Collapsible.tsx';
import FileList from './FileList.tsx';
import { CATEGORIES, CAT_CHIP } from './review-order.ts';
import './code.css';

export const CHIP = { open: 'c-blue', sent: 'c-orange', fixed: 'c-green', declined: 'c-red', outdated: 'c-grey', running: 'c-orange', done: 'c-green' };

function OrderBar({ planned, mode, setMode, catCounts, hidden, onToggleCat }) {
  return (
    <div className="rv-order">
      <span className="rv-seg">
        <button type="button" className={mode === 'suggested' ? 'on' : ''} onClick={() => setMode('suggested')}>{planned ? 'plan' : 'suggested'}</button>
        <button type="button" className={mode === 'tree' ? 'on' : ''} onClick={() => setMode('tree')}>tree</button>
      </span>
      {CATEGORIES.filter((c) => catCounts[c]).map((c) => {
        const off = hidden.includes(c);
        return <button key={c} type="button" className={`chip rv-cat ${off ? 'off' : CAT_CHIP[c]}`} title={off ? `show ${c} files` : `hide ${c} files`} onClick={() => onToggleCat(c)}>{c} {catCounts[c]}</button>;
      })}
    </div>
  );
}

// left pane of the Review tab: the changed files in suggested review order (or as a tree), ticks and comment counts; folded on phone
// files: every changed file · shown: files left after hidden categories · order: { mode, setMode, groups, hidden, onToggleCat, catCounts, ticks }
export default function ReviewSidebar({ files, shown, order, rv, activePath, onPick, phone = false }) {
  const add = files.reduce((s, f) => s + f.additions, 0);
  const del = files.reduce((s, f) => s + f.deletions, 0);
  const bar = rv.plan && <OrderBar planned={Boolean(rv.plan.plan)} {...order} />;
  const tree = rv.refs ? <FileList files={shown} groups={order.groups} ticks={order.ticks} cats={rv.plan?.categories} activePath={activePath} commentsByPath={rv.byPath} onOpen={(p) => onPick(p)} follow={!phone} /> : <span className="sub">{rv.error ? '' : 'Loading files…'}</span>;
  if (phone) return <Collapsible level="pm" title={`Files · ${files.length}`} badge={`+${add} −${del}`}>{bar}{tree}</Collapsible>;
  return (
    <aside className="rv-side">
      <div className="rv-side-stat">{files.length} files <span className="add">+{add}</span> <span className="del">−{del}</span>{order.ticks.size > 0 && ` · ${files.filter((f) => order.ticks.has(f.filename)).length} reviewed`}</div>
      {bar}
      <div className="rv-tree">{tree}</div>
    </aside>
  );
}
