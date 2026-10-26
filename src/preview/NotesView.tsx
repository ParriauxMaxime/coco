import { useState } from 'react';
import type { ReactNode } from 'react';
import Markdown from '../components/Markdown.tsx';
import { pendingClass, useAction } from '../components/action.ts';
import type { StackRow } from '../types.ts';
import Icon from './Icon.tsx';
import { Section } from './pages/Page.tsx';
import type { PreviewData } from './data.ts';
import './notes.css';

const TITLE_MAX = 100;

function useDraft(base: string) {
  const [draft, setDraft] = useState<string | null>(null);
  return { value: draft ?? base, set: setDraft, dirty: draft !== null && draft !== base, reset: () => setDraft(null) };
}

function Actions({ dirty, busy, pending, onRevert, onSave }: { dirty: boolean; busy: boolean; pending: boolean; onRevert: () => void; onSave: () => void }) {
  return (
    <span className="dp-row dp-g6">
      {dirty && <span className="dp-chip dp-warn">unsaved</span>}
      <button type="button" className="dp-btn dp-sm dp-ghost" disabled={!dirty || busy} onClick={onRevert}><Icon name="refresh" size={12} />Revert</button>
      <button type="button" className={`dp-btn dp-sm dp-primary${pendingClass(pending)}`} disabled={!dirty || busy} onClick={onSave}><Icon name="check" size={12} />Save</button>
    </span>
  );
}

function MdField({ label, value, onChange, placeholder, empty }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; empty: ReactNode }) {
  const [mode, setMode] = useState<'write' | 'preview'>(value.trim() ? 'preview' : 'write');
  return (
    <div className="dp-box dp-nt-md">
      <div className="dp-nt-bar">
        <span className="dp-seg">
          <button type="button" className={mode === 'write' ? 'dp-on' : 'dp-off'} onClick={() => setMode('write')}><Icon name="pencil" size={12} />Write</button>
          <button type="button" className={mode === 'preview' ? 'dp-on' : 'dp-off'} onClick={() => setMode('preview')}><Icon name="eye" size={12} />Preview</button>
        </span>
        <span className="dp-xs dp-t3">Markdown</span>
      </div>
      {mode === 'write' ? (
        <textarea className="dp-nt-ta" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} aria-label={label} />
      ) : (
        <div className="dp-nt-pv" onDoubleClick={() => setMode('write')} title="Double-click to edit">{value.trim() ? <Markdown text={value} /> : <span className="dp-t3">{empty}</span>}</div>
      )}
    </div>
  );
}

const rowId = (s: StackRow) => (s.number == null || s.number === '' ? '' : String(s.number));

export default function NotesView({ d }: { d: PreviewData }) {
  const w = d.work.w;
  const { pending, busy, run } = useAction();
  const title = useDraft(w?.title || '');
  const desc = useDraft(w?.description || '');
  const notes = useDraft(w?.notes || '');
  const stack = w?.stack || [];
  const planned = stack.filter((s) => !rowId(s));
  const order = useDraft(stack.filter(rowId).map(rowId).join(' '));
  if (!w) return <div className="dp-doc"><div className="dp-doc-in dp-t3">{d.work.err || 'Loading…'}</div></div>;

  const metaDirty = title.dirty || desc.dirty;
  const saveMeta = () => run('meta', async () => { await d.work.saveMeta({ title: title.value, description: desc.value }); title.reset(); desc.reset(); });
  const saveNotes = () => run('notes', async () => { await d.work.saveNotes(notes.value); notes.reset(); });
  const saveStack = () => run('stack', async () => {
    const ids = Array.from(new Set(order.value.split(/[\s,→>]+/).map((t) => t.replace(/^#/, '')).filter(Boolean)));
    const rows = ids.map((id) => stack.find((s) => rowId(s) === id) || (/^\d+$/.test(id) ? { number: Number(id), personas: [] } : null)).filter((s): s is StackRow => s !== null);
    await d.work.saveStack([...rows, ...planned]);
    order.reset();
  });

  return (
    <div className="dp-nt">
      <div className="dp-vbar">
        <span className="dp-title">Notes</span>
        <span className="dp-xs dp-t3 dp-ell">Title, description, rules of thumb and stack order of this work</span>
      </div>
      <div className="dp-doc">
        <div className="dp-doc-in dp-nt-in">
          <Section title="Title and description" meta="a summary paragraph, then a before/after table or a mermaid diagram" action={<Actions dirty={metaDirty} busy={busy} pending={pending === 'meta'} onRevert={() => { title.reset(); desc.reset(); }} onSave={saveMeta} />}>
            <label className="dp-nt-field">
              <span className="dp-nt-lbl">Title<span className={`dp-num${title.value.length >= TITLE_MAX ? ' dp-nt-max' : ''}`}>{title.value.length}/{TITLE_MAX}</span></span>
              <input className="dp-inp dp-nt-title" maxLength={TITLE_MAX} value={title.value} onChange={(e) => title.set(e.target.value)} />
            </label>
            <div className="dp-nt-field">
              <span className="dp-nt-lbl">Description</span>
              <MdField label="Description" value={desc.value} onChange={desc.set} placeholder="What this work changes, for whom, and why" empty="No description yet." />
            </div>
          </Section>
          <Section title="Notes" meta="rules of thumb, do not revisit" action={<Actions dirty={notes.dirty} busy={busy} pending={pending === 'notes'} onRevert={notes.reset} onSave={saveNotes} />}>
            <MdField label="Notes" value={notes.value} onChange={notes.set} placeholder="Rules of thumb, decisions not to revisit" empty="No notes yet." />
          </Section>
          <Section title="Stack order" meta={`PR numbers in merge order${planned.length ? `; the ${planned.length} planned PRs stay after them` : ''}`} action={<Actions dirty={order.dirty} busy={busy} pending={pending === 'stack'} onRevert={order.reset} onSave={saveStack} />}>
            <input className="dp-inp dp-nt-stack" value={order.value} onChange={(e) => order.set(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && order.dirty && !busy && saveStack()} placeholder="101 102 103" aria-label="PR numbers in merge order" />
          </Section>
        </div>
      </div>
    </div>
  );
}
