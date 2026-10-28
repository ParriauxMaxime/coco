import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import Icon from '../Icon.tsx';
import { pendingClass } from '../../components/action.ts';
import { useUnsaved } from '../../updates.ts';
import { FILES_ONLY, MAX_ATTACHMENTS, fileProblem, isImage, sizeOf } from './Attachments.tsx';
import { useAgentInput } from './agent-input.tsx';
import type { UploadRef } from '../../types.ts';

// follows the bottom while new steps arrive, unless the owner scrolled up to read
export function Log({ size, className = '', children }: { size: number; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [size]);
  return <div ref={ref} className={`dp-agent-log${className ? ` ${className}` : ''}`} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>{children}</div>;
}

// a file waiting to leave with the next message: uploaded as soon as it is added, ref once stored
type Attached = { key: string; name: string; size: number; preview: string | null; ref: UploadRef | null };
let seq = 0;

// images and files come by paste, drop or the paperclip; each uploads at once and leaves with the message as an attachment id
// tools: controls after the paperclip · actions(text, clear): buttons before Send that use the text · busy: another action holds Send · sending: Send in flight
// onStop: the agent is mid-turn; a Stop button and Esc interrupt it · allowEmpty: Send works without text · attach: false hides the paperclip and refuses pasted files
type ComposerProps = {
  placeholder: string;
  note?: string;
  disabled?: boolean;
  busy?: boolean;
  sending?: boolean;
  sendLabel?: string;
  autoFocus?: boolean;
  className?: string;
  tools?: React.ReactNode;
  actions?: (text: string, clear: () => void, fill: (text: string) => void) => React.ReactNode;
  onSend: (text: string, files: UploadRef[]) => Promise<boolean>;
  onStop?: () => Promise<unknown>;
  allowEmpty?: boolean;
  attach?: boolean;
  // false: no text box, only the footer and its Send (the action takes no words)
  withText?: boolean;
  initial?: string;
  // the text held by the caller, which may rewrite it (a prefilled note)
  value?: string;
  onValue?: (text: string) => void;
  // Esc when no agent runs to stop
  onCancel?: () => void;
  // where the unsent text is kept for this tab (sessionStorage), so a reload onto a new coco build loses no words
  draft?: string;
  // the live agent it talks to: `/` lists its slash commands, ↑ in an empty box recalls its earlier prompts
  agentId?: string | null;
};

const DRAFT = 'coco.draft.';
const readDraft = (key?: string) => {
  try {
    return key ? sessionStorage.getItem(DRAFT + key) : null;
  } catch {
    return null;
  }
};
const keepDraft = (key: string, text: string) => {
  try {
    if (text.trim()) sessionStorage.setItem(DRAFT + key, text);
    else sessionStorage.removeItem(DRAFT + key);
  } catch {}
};

// a message that did not leave goes back into its box, before what was typed since; a box not mounted gets it as its draft
const refills = new Map<string, (text: string, files: UploadRef[]) => void>();
export function refillDraft(key: string, text: string, files: UploadRef[] = []) {
  const said = text === FILES_ONLY ? '' : text;
  const fill = refills.get(key);
  if (fill) return fill(said, files);
  const typed = readDraft(key);
  keepDraft(key, typed?.trim() ? `${said}\n\n${typed}` : said);
}

// a text held by the caller (value) is the caller's alone: no draft is read into it or kept from it
export function Composer({ placeholder, note, disabled = false, busy = false, sending = false, sendLabel = 'Send', autoFocus = false, className = '', tools, actions, onSend, onStop, allowEmpty = false, attach = true, withText = true, initial = '', value, onValue, onCancel, draft, agentId }: ComposerProps) {
  const controlled = value !== undefined;
  const kept = controlled ? undefined : draft;
  const [own, setOwn] = useState(() => readDraft(kept) ?? initial);
  const [draftOf, setDraftOf] = useState(kept);
  if (draftOf !== kept) {
    setDraftOf(kept);
    setOwn(readDraft(kept) ?? initial);
  }
  const text = controlled ? value : own;
  const setText = onValue ?? setOwn;
  const agentInput = useAgentInput(disabled ? null : agentId, text, setText);
  useEffect(() => {
    if (kept) keepDraft(kept, text);
  }, [kept, text]);
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    if (!onStop || stopping) return;
    setStopping(true);
    onStop().catch((e) => setErrors([`Stop failed: ${errorMessage(e)}`])).finally(() => setStopping(false));
  };
  const [files, setFiles] = useState<Attached[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const live = useRef(files);
  live.current = files;
  useEffect(() => () => live.current.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)), []);
  useEffect(() => {
    if (!kept) return undefined;
    const fill = (said: string, refs: UploadRef[]) => {
      if (said) setOwn((typed) => (typed.trim() ? `${said}\n\n${typed}` : said));
      setFiles((prev) => [...prev, ...refs.map((ref) => ({ key: `f${++seq}`, name: ref.fileName, size: ref.size, preview: null, ref }))]);
    };
    refills.set(kept, fill);
    return () => {
      if (refills.get(kept) === fill) refills.delete(kept);
    };
  }, [kept]);

  const upload = (key: string, file: File, name: string) =>
    api.upload(file, name).then(
      (ref) => {
        if (!live.current.some((f) => f.key === key)) return void api.dropUpload(ref.id).catch(() => {});
        setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ref } : f)));
      },
      (e) => {
        drop(key, false);
        setErrors((prev) => [...prev, `${name}: ${errorMessage(e)}`]);
      },
    );
  const add = (list: File[]) => {
    if (disabled || !attach || !list.length) return;
    const problems: string[] = [];
    const ok = list.filter((f) => {
      const why = fileProblem(f);
      if (why) problems.push(`${f.name || 'pasted file'}: ${why}`);
      return !why;
    });
    const room = MAX_ATTACHMENTS - live.current.length;
    if (ok.length > room) problems.push(`at most ${MAX_ATTACHMENTS} files per message`);
    const taken = ok.slice(0, Math.max(0, room)).map((file) => ({ file, item: { key: `f${++seq}`, name: file.name || `pasted.${file.type.split('/')[1] || 'bin'}`, size: file.size, preview: isImage(file.type) ? URL.createObjectURL(file) : null, ref: null } }));
    setErrors(problems);
    setFiles((prev) => [...prev, ...taken.map((t) => t.item)]);
    for (const { file, item } of taken) void upload(item.key, file, item.name);
  };
  const drop = (key: string, forget = true) => {
    const f = live.current.find((x) => x.key === key);
    if (f?.preview) URL.revokeObjectURL(f.preview);
    if (forget && f?.ref) api.dropUpload(f.ref.id).catch(() => {});
    setFiles((prev) => prev.filter((x) => x.key !== key));
  };

  // a text held by the caller is the caller's to count
  useUnsaved((!controlled && text.trim() !== initial.trim()) || files.length > 0);
  const uploading = files.some((f) => !f.ref);
  const empty = withText && !allowEmpty && !text.trim() && !files.length;
  const send = async () => {
    if (empty || disabled || busy || sending || uploading) return;
    // the key can change while it sends (a new conversation gets its id) and the box unmount: the sent text leaves its own key
    const from = draft;
    if (await onSend(text.trim() || (files.length ? FILES_ONLY : ''), files.flatMap((f) => (f.ref ? [f.ref] : [])))) {
      if (from) keepDraft(from, '');
      agentInput.sent();
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      setText('');
      setFiles([]);
      setErrors([]);
    }
  };
  const dragging = (e: React.DragEvent) => !disabled && attach && e.dataTransfer.types.includes('Files');
  return (
    <div className={`dp-composer${className ? ` ${className}` : ''}`}>
      <div
        className={`dp-composer-in${drag ? ' dp-upl-drag' : ''}`}
        onDragOver={(e) => { if (dragging(e)) { e.preventDefault(); setDrag(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false); }}
        onDrop={(e) => { if (!dragging(e)) return; e.preventDefault(); setDrag(false); add([...e.dataTransfer.files]); }}
      >
        {files.length > 0 && (
          <div className="dp-upl-list dp-upl-pend">
            {files.map((f) => (
              <span key={f.key} className={`${f.preview ? 'dp-upl-img' : 'dp-upl-chip'}${f.ref ? '' : ' dp-upl-busy'}`} title={`${f.name} · ${sizeOf(f.size)}${f.ref ? '' : ' · uploading…'}`}>
                {f.preview ? <img src={f.preview} alt={f.name} /> : <><Icon name="file" size={14} /><span className="dp-ell">{f.name}</span><span className="dp-t3 dp-num">{f.ref ? sizeOf(f.size) : 'uploading…'}</span></>}
                <button type="button" className="dp-upl-x" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => drop(f.key)}><Icon name="x" size={12} /></button>
              </span>
            ))}
          </div>
        )}
        {agentInput.menu}
        {errors.length > 0 && <div className="dp-upl-err" role="alert"><Icon name="alert-triangle" size={12} /><span>{errors.join(' · ')}</span></div>}
        {withText && (
          <textarea
            rows={2}
            value={text}
            disabled={disabled}
            autoFocus={autoFocus}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => { const pasted = [...e.clipboardData.files]; if (pasted.length) { e.preventDefault(); add(pasted); } }}
            onKeyDown={(e) => {
              if (agentInput.key(e)) return;
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
              else if (e.key === 'Escape' && (onStop || onCancel)) { e.preventDefault(); if (onStop) stop(); else onCancel?.(); }
            }}
          />
        )}
        <div className="dp-comp-f">
          {attach && (
            <>
              <input ref={picker} type="file" multiple hidden onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ''; }} />
              <button type="button" className="dp-btn dp-ghost dp-sm dp-upl-clip" disabled={disabled} title="Attach images or files (or paste or drop them)" aria-label="Attach files" onClick={() => picker.current?.click()}><Icon name="paperclip" size={14} /></button>
            </>
          )}
          {tools}
          <span className="dp-xs dp-t3 dp-grow dp-ell">{note}</span>
          {actions?.(text.trim(), () => setText(''), setText)}
          {onStop && <button type="button" className={`dp-btn dp-sm dp-comp-stop${pendingClass(stopping)}`} disabled={stopping} title="Interrupt the agent (Esc)" onClick={stop}><Icon name="square" size={12} />Stop<kbd>esc</kbd></button>}
          <button type="button" className={`dp-btn dp-primary dp-sm${pendingClass(sending)}`} disabled={disabled || busy || sending || empty || uploading} title={uploading ? 'Waiting for the files to upload' : 'Shift+Enter for a new line'} onClick={() => void send()}>{sendLabel}<kbd>↵</kbd></button>
        </div>
      </div>
    </div>
  );
}
