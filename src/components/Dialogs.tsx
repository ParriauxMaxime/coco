import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import Modal from '../preview/Modal.tsx';

// In-app stand-ins for window.prompt / confirm, which the desktop app (Electron) does not show: each returns a promise.
// ask({ title, fields }) → the values or null · confirmDialog({ title }) → true or false · choose({ title, choices }) → a choice's value or null
type Choice<T> = { label: string; value: T; primary?: boolean; danger?: boolean };
type Field = { placeholder: string; initial?: string };
type Request = { id: number; title: string; body?: React.ReactNode; fields: Field[]; choices: Choice<unknown>[]; done: (value: unknown, values: string[]) => void };

const useDialogs = create<{ list: Request[] }>(() => ({ list: [] }));
let seq = 0;

function open<T>(req: Omit<Request, 'id' | 'done'>, onDone: (value: unknown, values: string[]) => T) {
  return new Promise<T>((resolve) => {
    const r: Request = { ...req, id: ++seq, done: (value, values) => {
      useDialogs.setState((s) => ({ list: s.list.filter((x) => x !== r) }));
      resolve(onDone(value, values));
    } };
    useDialogs.setState((s) => ({ list: [...s.list, r] }));
  });
}

export function ask({ title, body, fields, ok = 'OK' }: { title: string; body?: React.ReactNode; fields: (string | Field)[]; ok?: string }) {
  const list = fields.map((f) => (typeof f === 'string' ? { placeholder: f } : f));
  return open({ title, body, fields: list, choices: [{ label: 'Cancel', value: null }, { label: ok, value: true, primary: true }] }, (v, values) => (v ? values : null));
}

export function confirmDialog({ title, body, ok = 'OK', danger = false }: { title: string; body?: React.ReactNode; ok?: string; danger?: boolean }) {
  return open({ title, body, fields: [], choices: [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: !danger, danger }] }, (v) => v === true);
}

export function choose<T>({ title, body, choices }: { title: string; body?: React.ReactNode; choices: Choice<T>[] }) {
  return open({ title, body, fields: [], choices: [{ label: 'Cancel', value: null }, ...choices] }, (v) => v as T | null);
}

function Dialog({ req }: { req: Request }) {
  const [values, setValues] = useState(() => req.fields.map((f) => f.initial ?? ''));
  const focus = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!req.fields.length) focus.current?.focus();
  }, [req]);
  const main = req.choices.find((c) => c.primary) ?? req.choices.at(-1);
  return (
    <Modal title={req.title} onClose={() => req.done(null, values)} foot={req.choices.map((c) => (
      <button key={c.label} ref={c === main ? focus : undefined} type="button" className={`dp-btn${c.primary ? ' dp-primary' : ''}${c.danger ? ' dp-danger' : ''}`} onClick={() => req.done(c.value, values)}>{c.label}</button>
    ))}>
      {req.body && <div>{req.body}</div>}
      {req.fields.length > 0 && (
        <form style={{ display: 'contents' }} onSubmit={(e) => { e.preventDefault(); req.done(main?.value ?? null, values); }}>
          {req.fields.map((f, i) => (
            <input key={f.placeholder} className="dp-inp" autoFocus={i === 0} value={values[i]} placeholder={f.placeholder} aria-label={f.placeholder} onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))} />
          ))}
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}

// beside <Toasts />: the oldest open request on top of the page
export default function Dialogs() {
  const req = useDialogs((s) => s.list[0]);
  if (!req) return null;
  return <div className="dp dp-float" data-coco-dialog><Dialog key={req.id} req={req} /></div>;
}
