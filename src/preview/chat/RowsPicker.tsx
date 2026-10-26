import React, { useState } from 'react';
import type { ReactNode } from 'react';
import { Inline } from '../../components/Blocks.tsx';
import { Details, MoreButton, Sure } from './OptionPicker.tsx';
import type { CardOption, CardRow, TableCell } from '../../types.ts';

export type PickRow = CardRow & { details?: string; confidence?: number };

export const cellText = (x: TableCell) => (typeof x === 'string' ? x : x.text);
const tone = (x: TableCell) => (typeof x === 'string' || !x.tone ? undefined : `dp-cd-tone dp-cd-${x.tone}`);
const Cell = ({ x }: { x: TableCell }) => <td className={tone(x)}><Inline text={cellText(x)} /></td>;

function LeadCell({ x, r, markdown }: { x: TableCell; r: PickRow; markdown?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <td className={tone(x)}>
      <div className="dp-cd-lead"><Inline text={cellText(x)} /><Sure value={r.confidence} title="How sure the agent is of the recommended pick" />{r.details && <MoreButton open={open} onToggle={() => setOpen(!open)} />}</div>
      {r.details && open && <Details text={r.details} markdown={markdown} />}
    </td>
  );
}

type Props = {
  name: string;
  columns?: string[];
  rows: PickRow[];
  options?: CardOption[];
  select?: 'many' | 'one';
  ticked: string[];
  picks: Record<string, string>;
  ro: boolean;
  onTick?: (rows: string[]) => void;
  onPick?: (picks: Record<string, string>) => void;
  markdown?: boolean;
  done?: boolean;
  children?: ReactNode;
};

// a table of rows: tick some (or one), or with options one pick per row, the recommended pick underlined
export default function RowsPicker({ name, columns, rows, options: opts = [], select, ticked, picks, ro, onTick, onPick, markdown, done, children }: Props) {
  const one = select === 'one';
  const all = rows.length > 0 && rows.every((r) => ticked.includes(r.key));
  const tick = (k: string) => !ro && onTick?.(one ? [k] : ticked.includes(k) ? ticked.filter((x) => x !== k) : [...ticked, k]);
  return (
    <div className={`dp-cd-rows${done ? ' dp-cd-done' : ''}`}>
      <div className="dp-cd-tblw">
        <table className="dp-tbl dp-cd-tbl">
          <thead>
            <tr>
              {!opts.length && (
                <th className="dp-cb">
                  {!one && (
                    <label className={`dp-cd-cb${all ? ' dp-on' : ''}`} title={all ? 'Untick all' : 'Tick all'}>
                      <input className="dp-vh" type="checkbox" checked={all} disabled={ro} aria-label="Tick all rows" onChange={() => onTick?.(all ? [] : rows.map((r) => r.key))} />
                      <span className="dp-check" />
                    </label>
                  )}
                </th>
              )}
              {(columns ?? []).map((h, i) => <th key={i}>{h}</th>)}
              {opts.map((o) => <th key={o.key} className="dp-cd-pickh" title={o.details}><Inline text={o.label} />{o.confidence != null && <> <Sure value={o.confidence} /></>}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const on = ticked.includes(r.key);
              return (
                <tr key={r.key} className={!opts.length && on ? 'dp-sel' : undefined} onClick={opts.length ? undefined : (e) => { if (!(e.target as HTMLElement).closest('label, button')) tick(r.key); }}>
                  {!opts.length && (
                    <td className="dp-cb">
                      <label className={`dp-cd-cb${on ? ' dp-on' : ''}`}>
                        <input className="dp-vh" type={one ? 'radio' : 'checkbox'} name={`${name}-row`} checked={on} disabled={ro} aria-label={`Tick ${cellText(r.cells[0] ?? r.key)}`} onChange={() => tick(r.key)} />
                        <span className={one ? 'dp-radio' : 'dp-check'} />
                      </label>
                    </td>
                  )}
                  {r.cells.map((x, i) => (i === 0 && (r.details || r.confidence != null) ? <LeadCell key={i} x={x} r={r} markdown={markdown} /> : <Cell key={i} x={x} />))}
                  {opts.map((o) => {
                    const picked = picks[r.key] === o.key;
                    return (
                      <td key={o.key} className={`dp-cd-pick${r.recommended === o.key ? ' dp-cd-rec' : ''}`} title={r.recommended === o.key ? 'recommended' : undefined}>
                        <label className={`dp-cd-cb${picked ? ' dp-on' : ''}`}>
                          <input className="dp-vh" type="radio" name={`${name}-${r.key}`} checked={picked} disabled={ro} aria-label={`${cellText(r.cells[0] ?? r.key)}: ${o.label}`} onChange={() => onPick?.({ ...picks, [r.key]: o.key })} />
                          <span className="dp-radio" />
                        </label>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {opts.length > 0 && rows.some((r) => typeof r.recommended === 'string') && <div className="dp-cd-hint"><span className="dp-cd-recdot" />recommended pick</div>}
      {children}
    </div>
  );
}
