import React, { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import Blocks, { Inline } from '../../components/Blocks.tsx';
import { pendingClass } from '../../components/action.ts';
import Icon from '../Icon.tsx';
import type { IconName } from '../Icon.tsx';
import type { Card, CardAnswerBody, CardField, CardOption, CardValue, TableCell } from '../../types.ts';
import './card.css';

const KIND: Record<Card['kind'], [string, IconName]> = { post: ['note', 'notebook'], choice: ['question', 'message-square'], rows: ['pick rows', 'list'], form: ['form', 'pencil'], confirm: ['approval', 'check'] };

export const cardDomId = (id: string) => `coco-card-${id}`;
const clock = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

export function Sure({ value }: { value?: number }) {
  if (value == null) return null;
  const n = Math.round(value <= 1 ? value * 100 : value);
  return <span className={`dp-chip ${n >= 75 ? 'dp-ok' : n >= 50 ? 'dp-warn' : 'dp-bad'}`} title="How sure the agent is of this option">{n}% sure</span>;
}
const Rec = () => <span className="dp-chip dp-acc">recommended</span>;

type Draft = { picked: string[]; rows: string[]; rowPicks: Record<string, string>; values: Record<string, CardValue>; other: string };
type Part = { c: Card; d: Draft; set: (p: Partial<Draft>) => void; ro: boolean };

const draftOf = (c: Card): Draft => {
  const a = c.answer;
  if (c.status !== 'open') return { picked: a?.picked ?? [], rows: a?.rows ?? [], rowPicks: a?.rowPicks ?? {}, values: a?.values ?? {}, other: a?.other ?? '' };
  return {
    picked: (c.options ?? []).filter((o) => o.recommended).map((o) => o.key).slice(0, c.multi ? undefined : 1),
    rows: (c.rows ?? []).filter((r) => r.recommended === true).map((r) => r.key).slice(0, c.select === 'one' ? 1 : undefined),
    rowPicks: Object.fromEntries((c.rows ?? []).flatMap((r) => (typeof r.recommended === 'string' ? [[r.key, r.recommended]] : []))),
    values: Object.fromEntries((c.fields ?? []).map((f) => [f.key, f.default ?? (f.type === 'toggle' ? false : '')])),
    other: '',
  };
};

const fieldError = (f: CardField, v: CardValue | undefined) => {
  if (f.type === 'toggle') return '';
  const s = v == null ? '' : String(v).trim();
  if (!s) return f.required ? 'Required' : '';
  if (f.type === 'number' && !Number.isFinite(Number(s))) return 'Enter a number';
  return '';
};

const hasOther = (c: Card) => (c.kind === 'form' ? c.other === true : c.other !== false);

const isValid = (c: Card, d: Draft) => {
  const other = hasOther(c) && d.other.trim() !== '';
  if (c.kind === 'choice') return d.picked.length > 0 || other;
  if (c.kind === 'rows') {
    if (c.rowOptions?.length) return other || Object.keys(d.rowPicks).length > 0;
    return other || (c.select === 'one' ? d.rows.length === 1 : d.rows.length > 0);
  }
  if (c.kind === 'form') return (c.fields ?? []).every((f) => !fieldError(f, d.values[f.key]));
  return false;
};

const answerOf = (c: Card, d: Draft): CardAnswerBody => {
  const other = (hasOther(c) && d.other.trim()) || undefined;
  if (c.kind === 'choice') return { picked: d.picked, other };
  if (c.kind === 'rows') return c.rowOptions?.length ? { rowPicks: d.rowPicks, other } : { rows: d.rows, other };
  if (c.kind === 'form') {
    const values = (c.fields ?? []).flatMap((f): [string, CardValue][] => {
      const v = d.values[f.key];
      if (f.type !== 'toggle' && (v == null || String(v).trim() === '')) return [];
      return [[f.key, f.type === 'number' ? Number(v) : v]];
    });
    return { values: Object.fromEntries(values), other };
  }
  return { other };
};

function Other({ value, ro, single, onChange }: { value: string; ro: boolean; single?: boolean; onChange: (v: string) => void }) {
  if (ro && !value) return null;
  return <input className={`dp-inp dp-cd-other${value ? ' dp-on' : ''}`} value={value} disabled={ro} placeholder={single ? 'Other… your own answer instead' : 'Other… add your own words'} aria-label="Other" onChange={(e) => onChange(e.target.value)} />;
}

function Option({ o, on, multi, name, ro, onPick }: { o: CardOption; on: boolean; multi?: boolean; name: string; ro: boolean; onPick: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dp-cd-opt">
      <label className={`dp-opt${on ? ' dp-on' : ''}${ro ? ' dp-cd-ro' : ''}`}>
        <input className="dp-vh" type={multi ? 'checkbox' : 'radio'} name={name} checked={on} disabled={ro} onChange={onPick} />
        <span className={multi ? 'dp-check' : 'dp-radio'} />
        <span className="dp-ol"><Inline text={o.label} /></span>
        {o.recommended && <Rec />}
        <Sure value={o.confidence} />
        {o.details && (
          <button type="button" className={`dp-btn dp-ghost dp-sm dp-cd-more${open ? ' dp-open' : ''}`} aria-expanded={open} onClick={(e) => { e.preventDefault(); setOpen(!open); }}>
            <Icon name="chevron-right" size={12} />details
          </button>
        )}
      </label>
      {o.details && open && <Inline as="div" className="dp-cd-det" text={o.details} />}
    </div>
  );
}

function Choice({ c, d, set, ro }: Part) {
  const pick = (k: string) => set(c.multi ? { picked: d.picked.includes(k) ? d.picked.filter((x) => x !== k) : [...d.picked, k] } : { picked: [k], other: '' });
  return (
    <div className="dp-cd-opts" role={c.multi ? 'group' : 'radiogroup'} aria-label={c.title}>
      {(c.options ?? []).map((o) => <Option key={o.key} o={o} on={d.picked.includes(o.key)} multi={c.multi} name={`${c.id}-opt`} ro={ro} onPick={() => pick(o.key)} />)}
      {hasOther(c) && <Other value={d.other} ro={ro} single={!c.multi} onChange={(v) => set(c.multi || !v ? { other: v } : { other: v, picked: [] })} />}
    </div>
  );
}

const cellText = (x: TableCell) => (typeof x === 'string' ? x : x.text);
const Cell = ({ x }: { x: TableCell }) => <td className={typeof x === 'string' || !x.tone ? undefined : `dp-cd-tone dp-cd-${x.tone}`}><Inline text={cellText(x)} /></td>;

function Rows({ c, d, set, ro }: Part) {
  const rows = c.rows ?? [];
  const opts = c.rowOptions ?? [];
  const one = c.select === 'one';
  const all = rows.length > 0 && rows.every((r) => d.rows.includes(r.key));
  const tick = (k: string) => !ro && set({ rows: one ? [k] : d.rows.includes(k) ? d.rows.filter((x) => x !== k) : [...d.rows, k] });
  return (
    <div className="dp-cd-rows">
      <div className="dp-cd-tblw">
        <table className="dp-tbl dp-cd-tbl">
          <thead>
            <tr>
              {!opts.length && (
                <th className="dp-cb">
                  {!one && (
                    <label className={`dp-cd-cb${all ? ' dp-on' : ''}`} title={all ? 'Untick all' : 'Tick all'}>
                      <input className="dp-vh" type="checkbox" checked={all} disabled={ro} aria-label="Tick all rows" onChange={() => set({ rows: all ? [] : rows.map((r) => r.key) })} />
                      <span className="dp-check" />
                    </label>
                  )}
                </th>
              )}
              {(c.columns ?? []).map((h, i) => <th key={i}>{h}</th>)}
              {opts.map((o) => <th key={o.key} className="dp-cd-pickh" title={o.details}><Inline text={o.label} />{o.confidence != null && <> <Sure value={o.confidence} /></>}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const on = d.rows.includes(r.key);
              return (
                <tr key={r.key} className={!opts.length && on ? 'dp-sel' : undefined} onClick={opts.length ? undefined : (e) => { if (!(e.target as HTMLElement).closest('label')) tick(r.key); }}>
                  {!opts.length && (
                    <td className="dp-cb">
                      <label className={`dp-cd-cb${on ? ' dp-on' : ''}`}>
                        <input className="dp-vh" type={one ? 'radio' : 'checkbox'} name={`${c.id}-row`} checked={on} disabled={ro} aria-label={`Tick ${cellText(r.cells[0] ?? r.key)}`} onChange={() => tick(r.key)} />
                        <span className={one ? 'dp-radio' : 'dp-check'} />
                      </label>
                    </td>
                  )}
                  {r.cells.map((x, i) => <Cell key={i} x={x} />)}
                  {opts.map((o) => {
                    const picked = d.rowPicks[r.key] === o.key;
                    return (
                      <td key={o.key} className={`dp-cd-pick${r.recommended === o.key ? ' dp-cd-rec' : ''}`} title={r.recommended === o.key ? 'recommended' : undefined}>
                        <label className={`dp-cd-cb${picked ? ' dp-on' : ''}`}>
                          <input className="dp-vh" type="radio" name={`${c.id}-${r.key}`} checked={picked} disabled={ro} aria-label={`${cellText(r.cells[0] ?? r.key)}: ${o.label}`} onChange={() => set({ rowPicks: { ...d.rowPicks, [r.key]: o.key } })} />
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
      {hasOther(c) && <Other value={d.other} ro={ro} onChange={(v) => set({ other: v })} />}
    </div>
  );
}

function Field({ f, v, ro, shown, onChange, onBlur }: { f: CardField; v: CardValue | undefined; ro: boolean; shown: boolean; onChange: (v: CardValue) => void; onBlur: () => void }) {
  const err = shown && !ro ? fieldError(f, v) : '';
  const s = v == null ? '' : String(v);
  const common = { disabled: ro, onBlur, 'aria-invalid': err ? true : undefined, placeholder: ro ? undefined : f.placeholder };
  if (f.type === 'toggle') return (
    <label className={`dp-cd-tgl${v ? ' dp-on' : ''}${ro ? ' dp-cd-ro' : ''}`}>
      <input className="dp-vh" type="checkbox" checked={!!v} disabled={ro} onChange={(e) => onChange(e.target.checked)} />
      <span className="dp-check" />
      <span>{f.label}</span>
    </label>
  );
  return (
    <label className="dp-cd-field">
      <span className="dp-cd-fl">{f.label}{f.required && <i className="dp-cd-req" title="required">*</i>}</span>
      {f.type === 'textarea' ? <textarea className="dp-inp dp-cd-ta" rows={3} value={s} {...common} onChange={(e) => onChange(e.target.value)} />
        : f.type === 'select' ? (
          <select className="dp-inp" value={s} {...common} onChange={(e) => onChange(e.target.value)}>
            {!f.required || !s ? <option value="">{f.placeholder || 'Pick one'}</option> : null}
            {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )
        : <input className="dp-inp" type={f.type === 'number' ? 'number' : 'text'} value={s} {...common} onChange={(e) => onChange(e.target.value)} />}
      {err && <span className="dp-cd-err">{err}</span>}
    </label>
  );
}

function Form({ c, d, set, ro, tried }: Part & { tried: boolean }) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  return (
    <div className="dp-cd-form">
      {(c.fields ?? []).map((f) => <Field key={f.key} f={f} v={d.values[f.key]} ro={ro} shown={tried || !!touched[f.key]} onBlur={() => setTouched((t) => ({ ...t, [f.key]: true }))} onChange={(v) => set({ values: { ...d.values, [f.key]: v } })} />)}
      {hasOther(c) && <Other value={d.other} ro={ro} onChange={(v) => set({ other: v })} />}
    </div>
  );
}

function Status({ c }: { c: Card }) {
  if (c.status === 'cancelled') return <div className="dp-cd-st"><Icon name="x" size={12} />Dismissed: the agent was told</div>;
  const del = c.delivery;
  return (
    <div className={`dp-cd-st${del && !del.ok ? ' dp-cd-bad' : ''}`}>
      <Icon name={del && !del.ok ? 'alert-triangle' : 'check'} size={12} />
      <span>Answered {clock(c.answer?.at)}</span>
      <span>{!del ? 'delivering…' : del.ok ? 'delivered to the agent' : `agent gone: not delivered${del.error ? ` (${del.error})` : ''}`}</span>
    </div>
  );
}

const outcome = (c: Card): [string, string] => {
  if (c.status === 'open') return ['waiting on you', 'dp-warn'];
  if (c.status === 'cancelled') return ['dismissed', ''];
  if (c.kind === 'confirm' && c.answer?.approved != null) return c.answer.approved ? [c.confirmLabel ? c.confirmLabel.toLowerCase() : 'approved', 'dp-ok'] : [c.rejectLabel ? c.rejectLabel.toLowerCase() : 'rejected', 'dp-bad'];
  return ['answered', 'dp-ok'];
};

const EDITABLE = ['INPUT', 'TEXTAREA', 'SELECT'];

// one card an agent posted: the question and its context, the controls of its kind, then the answer once given
export default function CardView({ card: c, onCard, focus = false }: { card: Card; onCard?: (c: Card) => void; focus?: boolean }) {
  const [d, setD] = useState(() => draftOf(c));
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const busy = pending !== null;
  const run = async (key: string, fn: () => Promise<Card>) => {
    setPending(key);
    setErr('');
    try {
      onCard?.(await fn());
    } catch (e) {
      setErr(errorMessage(e));
      api.card(c.id).then((r) => r.status !== 'open' && onCard?.(r), () => {});
    } finally {
      setPending(null);
    }
  };
  const root = useRef<HTMLDivElement>(null);
  const open = c.status === 'open';
  const post = c.kind === 'post';
  const ro = !open || busy;
  useEffect(() => {
    if (!open) setD(draftOf(c));
  }, [c.status, c.answer?.at]);
  useEffect(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!focus || !open || (a && (EDITABLE.includes(a.tagName) || a.isContentEditable))) return;
    root.current?.querySelector<HTMLElement>('.dp-cd-b input:not([disabled]), .dp-cd-b textarea:not([disabled]), .dp-cd-b select:not([disabled])')?.focus({ preventScroll: true });
  }, []);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const ok = isValid(c, d);
  const answer = (key: string, body: CardAnswerBody) => run(key, () => api.answerCard(c.id, body));
  const submit = () => {
    setTried(true);
    if (ok && !busy) void answer('answer', answerOf(c, d));
  };
  const note = d.other.trim() || undefined;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || !open || c.kind === 'confirm') return;
    const t = e.target as HTMLElement;
    if (t.tagName === 'BUTTON' || (t.tagName === 'TEXTAREA' && !(e.metaKey || e.ctrlKey))) return;
    e.preventDefault();
    submit();
  };
  const [label, icon] = KIND[c.kind] || ['card', 'bot'];
  const [state, tone] = outcome(c);
  const Kind = c.kind === 'choice' ? Choice : c.kind === 'rows' ? Rows : null;
  return (
    <div ref={root} id={cardDomId(c.id)} className={`dp-card-q dp-cd${open && !post ? ' dp-attn' : ''}${!open && !post ? ' dp-cd-done' : ''}`} onKeyDown={onKey}>
      <div className="dp-cq-h">
        <span className="dp-ic"><Icon name={icon} size={14} /></span>
        <span className="dp-chip">{label}</span>
        <b className="dp-ell dp-cd-t" title={c.title}>{c.title}</b>
        <span className="dp-sp" />
        {!post && <span className={`dp-chip ${tone}`}>{state}</span>}
        <span className="dp-xs dp-t3 dp-num" title={c.createdAt}>{clock(c.createdAt)}</span>
      </div>
      <div className="dp-cq-b dp-cd-b">
        {c.question && <Inline as="div" className="dp-cd-q" text={c.question} />}
        {c.blocks && c.blocks.length > 0 && <div className="dp-cd-blocks"><Blocks blocks={c.blocks} /></div>}
        {Kind && <Kind c={c} d={d} set={set} ro={ro} />}
        {c.kind === 'form' && <Form c={c} d={d} set={set} ro={ro} tried={tried} />}
        {c.kind === 'confirm' && hasOther(c) && (open ? <textarea className="dp-inp dp-cd-ta dp-cd-note" rows={2} value={d.other} disabled={ro} placeholder="Optional note for the agent" aria-label="Note for the agent" onChange={(e) => set({ other: e.target.value })} /> : d.other && <div className="dp-cd-said"><span className="dp-t3">Note:</span> {d.other}</div>)}
      </div>
      {open && !post && (
        <div className="dp-cq-f dp-cd-f">
          {c.kind === 'confirm' ? (
            <>
              <button type="button" className={`dp-btn dp-primary dp-sm${pendingClass(pending === 'yes')}`} disabled={busy} onClick={() => void answer('yes', { approved: true, other: note })}><Icon name="check" size={12} />{c.confirmLabel || 'Approve'}</button>
              <button type="button" className={`dp-btn dp-danger dp-sm${pendingClass(pending === 'no')}`} disabled={busy} onClick={() => void answer('no', { approved: false, other: note })}><Icon name="x" size={12} />{c.rejectLabel || 'Reject'}</button>
              {note && <button type="button" className={`dp-btn dp-ghost dp-sm${pendingClass(pending === 'note')}`} disabled={busy} onClick={() => void answer('note', { other: note })}>Send the note only</button>}
            </>
          ) : (
            <>
              <button type="button" className={`dp-btn dp-primary dp-sm${pendingClass(pending === 'answer')}`} disabled={busy || (tried && !ok)} onClick={submit}>Send answer<kbd>↵</kbd></button>
              {tried && !ok && <span className="dp-cd-err">{c.kind === 'form' ? 'Fix the fields above' : c.kind === 'rows' && c.select === 'one' && !c.rowOptions?.length ? 'Tick one row, or write your own' : 'Pick one, or write your own'}</span>}
            </>
          )}
          {err && <span className="dp-cd-err" role="alert">{err}</span>}
          <span className="dp-sp" />
          <button type="button" className={`dp-btn dp-ghost dp-sm${pendingClass(pending === 'cancel')}`} disabled={busy} title="Close this question; the agent is told you dismissed it" onClick={() => void run('cancel', () => api.cancelCard(c.id))}>Dismiss</button>
        </div>
      )}
      {!open && !post && <Status c={c} />}
      {!open && err && <div className="dp-cd-st dp-cd-bad" role="alert"><Icon name="alert-triangle" size={12} />{err}</div>}
    </div>
  );
}

// the open cards of a view, as one pointer by the composer that scrolls to the oldest
export function CardsWaiting({ cards }: { cards: Card[] }) {
  const open = cards.filter((c) => c.status === 'open' && c.kind !== 'post');
  if (!open.length) return null;
  const go = () => {
    const el = document.getElementById(cardDomId(open[0].id));
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button')?.focus({ preventScroll: true });
  };
  return (
    <div className="dp-cd-wait">
      <button type="button" className="dp-btn dp-sm dp-cd-waitb" onClick={go}>
        <span className="dp-ag-dot dp-ag-waiting" />
        {open.length === 1 ? `1 question waiting on you: ${open[0].title}` : `${open.length} questions waiting on you`}
        <Icon name="chevron-down" size={12} />
      </button>
    </div>
  );
}
