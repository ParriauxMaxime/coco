import React, { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import Blocks, { Inline } from '../../components/Blocks.tsx';
import { pendingClass } from '../../components/action.ts';
import ErrorBoundary from '../../ErrorBoundary.tsx';
import Icon from '../Icon.tsx';
import type { IconName } from '../Icon.tsx';
import OptionPicker from './OptionPicker.tsx';
import RowsPicker from './RowsPicker.tsx';
import type { Card, CardAnswerBody, CardField, CardValue } from '../../types.ts';
import './card.css';

const KIND: Record<Card['kind'], [string, IconName]> = { post: ['note', 'notebook'], choice: ['question', 'message-square'], rows: ['pick rows', 'list'], form: ['form', 'pencil'], confirm: ['approval', 'check'] };

export const cardDomId = (id: string) => `coco-card-${id}`;
const clock = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

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

const fieldsOk = (c: Card, d: Draft) => (c.fields ?? []).every((f) => !fieldError(f, d.values[f.key]));

const isValid = (c: Card, d: Draft) => {
  const other = hasOther(c) && d.other.trim() !== '';
  if (c.kind === 'choice') return d.picked.length > 0 || other;
  if (c.kind === 'rows') {
    if (c.rowOptions?.length) return other || Object.keys(d.rowPicks).length > 0;
    return other || (c.select === 'one' ? d.rows.length === 1 : d.rows.length > 0);
  }
  if (c.kind === 'form') return fieldsOk(c, d);
  return false;
};

const valuesOf = (c: Card, d: Draft) => Object.fromEntries((c.fields ?? []).flatMap((f): [string, CardValue][] => {
  const v = d.values[f.key];
  if (f.type !== 'toggle' && (v == null || String(v).trim() === '')) return [];
  return [[f.key, f.type === 'number' ? Number(v) : v]];
}));

const answerOf = (c: Card, d: Draft): CardAnswerBody => {
  const other = (hasOther(c) && d.other.trim()) || undefined;
  if (c.kind === 'choice') return { picked: d.picked, other };
  if (c.kind === 'rows') return c.rowOptions?.length ? { rowPicks: d.rowPicks, other } : { rows: d.rows, other };
  if (c.kind === 'form') return { values: valuesOf(c, d), other };
  return { other };
};

function Other({ value, ro, single, onChange }: { value: string; ro: boolean; single?: boolean; onChange: (v: string) => void }) {
  if (ro && !value) return null;
  return <input className={`dp-inp dp-cd-other${value ? ' dp-on' : ''}`} value={value} disabled={ro} placeholder={single ? 'Other… your own answer instead' : 'Other… add your own words'} aria-label="Other" onChange={(e) => onChange(e.target.value)} />;
}

const pickIn = (c: Card, d: Draft, k: string): Partial<Draft> => (c.multi ? { picked: d.picked.includes(k) ? d.picked.filter((x) => x !== k) : [...d.picked, k] } : { picked: [k], other: '' });

function Choice({ c, d, set, ro }: Part) {
  return (
    <OptionPicker name={`${c.id}-opt`} label={c.title} options={c.options ?? []} picked={d.picked} multi={c.multi} ro={ro} numbered={!ro} onPick={(k) => set(pickIn(c, d, k))}>
      {hasOther(c) && <Other value={d.other} ro={ro} single={!c.multi} onChange={(v) => set(c.multi || !v ? { other: v } : { other: v, picked: [] })} />}
    </OptionPicker>
  );
}

function Rows({ c, d, set, ro }: Part) {
  return (
    <RowsPicker name={c.id} columns={c.columns} rows={c.rows ?? []} options={c.rowOptions} select={c.select} ticked={d.rows} picks={d.rowPicks} ro={ro} onTick={(rows) => set({ rows })} onPick={(rowPicks) => set({ rowPicks })}>
      {hasOther(c) && <Other value={d.other} ro={ro} onChange={(v) => set({ other: v })} />}
    </RowsPicker>
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

// a confirm card's fields come with the approval: no Other box of their own, the note is the card's
function Form({ c, d, set, ro, tried }: Part & { tried: boolean }) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  return (
    <div className="dp-cd-form">
      {(c.fields ?? []).map((f) => <Field key={f.key} f={f} v={d.values[f.key]} ro={ro} shown={tried || !!touched[f.key]} onBlur={() => setTouched((t) => ({ ...t, [f.key]: true }))} onChange={(v) => set({ values: { ...d.values, [f.key]: v } })} />)}
      {c.kind === 'form' && hasOther(c) && <Other value={d.other} ro={ro} onChange={(v) => set({ other: v })} />}
    </div>
  );
}

const delivered = (c: Card) => {
  const del = c.delivery;
  if (!del) return 'delivering…';
  if (del.skipped) return c.result?.ok ? 'done in coco: no new turn for the agent' : 'nothing to deliver: its run had ended';
  return del.ok ? 'delivered to the agent' : `agent gone: not delivered${del.error ? ` (${del.error})` : ''}`;
};

function Status({ c }: { c: Card }) {
  if (c.status === 'cancelled') return <div className="dp-cd-st"><Icon name="x" size={12} />Dismissed: the agent was told</div>;
  const bad = c.delivery && !c.delivery.ok;
  return (
    <div className={`dp-cd-st${bad ? ' dp-cd-bad' : ''}`}>
      <Icon name={bad ? 'alert-triangle' : 'check'} size={12} />
      <span>Answered {clock(c.answer?.at)}</span>
      <span>{delivered(c)}</span>
    </div>
  );
}

// what approving a proposal or picking an option with an effect did: running, done with a link to what it made, or failed
function Result({ c }: { c: Card }) {
  const r = c.result;
  if (c.status !== 'answered') return null;
  if (!r) return c.action && c.kind === 'confirm' && c.answer?.approved ? <div className="dp-cd-res"><span className="dp-ag-dot dp-ag-running" aria-label="in progress" />Running…</div> : null;
  return (
    <div className={`dp-cd-res${r.ok ? ' dp-cd-res-ok' : ' dp-cd-bad'}`} role={r.ok ? undefined : 'alert'}>
      <Icon name={r.ok ? 'check' : 'alert-triangle'} size={12} />
      <span className="dp-cd-resd">{r.detail}</span>
      {r.ok && r.link && <a className="dp-btn dp-sm dp-cd-open" href={r.link}><Icon name="external-link" size={12} />Open</a>}
    </div>
  );
}

const outcome = (c: Card): [string, string] => {
  if (c.status === 'open') return ['waiting on you', 'dp-warn'];
  if (c.status === 'cancelled') return ['dismissed', ''];
  if (c.result && !c.result.ok) return ['failed', 'dp-bad'];
  if (c.kind === 'confirm' && c.answer?.approved != null) return c.answer.approved ? [c.confirmLabel ? c.confirmLabel.toLowerCase() : 'approved', 'dp-ok'] : [c.rejectLabel ? c.rejectLabel.toLowerCase() : 'rejected', 'dp-bad'];
  return ['answered', 'dp-ok'];
};

const EDITABLE = ['INPUT', 'TEXTAREA', 'SELECT'];
const typing = (t: EventTarget) => t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type !== 'radio' && t.type !== 'checkbox') || (t instanceof HTMLElement && t.isContentEditable);

// one card an agent posted: the question and its context, the controls of its kind, then the answer once given
type CardProps = { card: Card; onCard?: (c: Card) => void; focus?: boolean };

export default function CardView(props: CardProps) {
  return <ErrorBoundary label={`card ${props.card.id}`} inline><CardBody {...props} /></ErrorBoundary>;
}

function CardBody({ card: c, onCard, focus = false }: CardProps) {
  const [d, setD] = useState(() => draftOf(c));
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [details, setDetails] = useState(false);
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
  const approve = () => {
    setTried(true);
    if (!fieldsOk(c, d) || busy) return;
    void answer('yes', { approved: true, ...(c.fields?.length ? { values: valuesOf(c, d) } : {}), other: note });
  };
  const onKey = (e: React.KeyboardEvent) => {
    const option = /^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && c.kind === 'choice' && !ro ? c.options?.[Number(e.key) - 1] : undefined;
    if (option && (e.altKey || !typing(e.target))) {
      e.preventDefault();
      set(pickIn(c, d, option.key));
      return;
    }
    if (e.key !== 'Enter'|| e.shiftKey || e.nativeEvent.isComposing || !open || c.kind === 'confirm') return;
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
        {c.blocks && c.blocks.length > 0 && !open && !post && (
          <button type="button" className={`dp-btn dp-ghost dp-sm dp-cd-more dp-cd-fold${details ? ' dp-open' : ''}`} aria-expanded={details} onClick={() => setDetails(!details)}>
            <Icon name="chevron-right" size={12} />{details ? 'Hide details' : 'Show details'}
          </button>
        )}
        {c.blocks && c.blocks.length > 0 && (open || post || details) && <div className="dp-cd-blocks"><Blocks blocks={c.blocks} /></div>}
        {Kind && <Kind c={c} d={d} set={set} ro={ro} />}
        {(c.kind === 'form' || (c.kind === 'confirm' && (c.fields?.length ?? 0) > 0)) && <Form c={c} d={d} set={set} ro={ro} tried={tried} />}
        {c.kind === 'confirm' && hasOther(c) && (open ? <textarea className="dp-inp dp-cd-ta dp-cd-note" rows={2} value={d.other} disabled={ro} placeholder="Optional note for the agent" aria-label="Note for the agent" onChange={(e) => set({ other: e.target.value })} /> : d.other && <div className="dp-cd-said"><span className="dp-t3">Note:</span> {d.other}</div>)}
      </div>
      {open && !post && (
        <div className="dp-cq-f dp-cd-f">
          {c.kind === 'confirm' ? (
            <>
              <button type="button" className={`dp-btn dp-primary dp-sm${pendingClass(pending === 'yes')}`} disabled={busy} onClick={approve}><Icon name="check" size={12} />{c.confirmLabel || 'Approve'}</button>
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
      <Result c={c} />
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
