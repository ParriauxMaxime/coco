import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import Icon from '../Icon.tsx';
import './parts.css';

export const inline = (s?: string) => (s || '').split(/`([^`]+)`/).map((x, i) => (i % 2 ? <code key={i}>{x}</code> : x));

// underline tabs whose state lives in the URL: base/<id>
export function SubTabs({ tabs, on, base, extra }: { tabs: { id: string; label: string; count?: number }[]; on: string; base: string; extra?: React.ReactNode }) {
  return (
    <div className="dp-subtabs">
      <nav className="dp-subtabs-l" role="tablist">
        {tabs.map((t) => (
          <a key={t.id} role="tab" aria-selected={on === t.id} className={`dp-subtab${on === t.id ? ' dp-on' : ''}`} href={`${base}/${t.id}`}>
            {t.label}{t.count !== undefined && <span className="dp-count">{t.count}</span>}
          </a>
        ))}
      </nav>
      {extra && <div className="dp-subtabs-x">{extra}</div>}
    </div>
  );
}

export function FeedbackForm({ node, title, verdicts = ['accurate', 'partly', 'wrong', 'missing'], placeholder }: { node: string; title: string; verdicts?: string[]; placeholder?: string }) {
  const [verdict, setVerdict] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const send = async () => {
    setStatus('Sending…');
    try {
      await api.sendFeedback({ node, title, verdict, text });
      setStatus(`Sent ${new Date().toLocaleTimeString()}`);
      setText('');
      setVerdict('');
    } catch (e) {
      setStatus(`Failed: ${errorMessage(e)}`);
    }
  };
  return (
    <div className="dp-fbform">
      <div className="dp-row dp-g8">
        <span className="dp-t3 dp-sm">Verdict</span>
        <span className="dp-seg">{verdicts.map((v) => <button key={v} type="button" className={verdict === v ? 'dp-on' : ''} onClick={() => setVerdict(verdict === v ? '' : v)}>{v}</button>)}</span>
      </div>
      <textarea className="dp-inp dp-fbform-t" rows={2} placeholder={placeholder || 'What is off, what is missing?'} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="dp-row dp-g8">
        <button type="button" className="dp-btn dp-primary dp-sm" disabled={!verdict && !text} onClick={send}><Icon name="send" size={12} />Send to host</button>
        <span className="dp-t3 dp-sm">{status}</span>
      </div>
    </div>
  );
}

export function FileEditor({ load, save, label }: { load: () => Promise<string>; save: (text: string) => Promise<{ bytes: number }>; label: string }) {
  const [text, setText] = useState('');
  const [initial, setInitial] = useState('');
  const [status, setStatus] = useState('Loading…');
  useEffect(() => {
    let alive = true;
    setStatus('Loading…');
    load().then((t) => {
      if (!alive) return;
      setText(t);
      setInitial(t);
      setStatus('');
    }).catch((e) => alive && setStatus(`Load failed: ${errorMessage(e)}`));
    return () => { alive = false; };
  }, [load]);
  const dirty = text !== initial;
  const onSave = async () => {
    setStatus('Saving…');
    try {
      const r = await save(text);
      setInitial(text);
      setStatus(`Saved ${r.bytes} bytes, .bak kept`);
    } catch (e) {
      setStatus(`Save failed: ${errorMessage(e)}`);
    }
  };
  return (
    <div className="dp-box dp-editor">
      <div className="dp-editor-bar">
        <Icon name="file" size={14} />
        <span className="dp-mono dp-ell">{label}</span>
        {dirty && <span className="dp-chip dp-warn">unsaved</span>}
        <span className="dp-t3 dp-sm dp-ell">{status}</span>
        <span className="dp-sp" />
        <button type="button" className="dp-btn dp-sm" disabled={!dirty} onClick={() => setText(initial)}><Icon name="refresh" size={12} />Revert</button>
        <button type="button" className="dp-btn dp-primary dp-sm" disabled={!dirty} onClick={onSave}><Icon name="check" size={12} />Save</button>
      </div>
      <textarea className="dp-editor-ta" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={label} />
    </div>
  );
}

export function FileList({ files, on, pick }: { files: string[]; on: string; pick: (f: string) => void }) {
  return (
    <nav className="dp-files" aria-label="Files">
      <span className="dp-files-h">Files<span className="dp-count">{files.length}</span></span>
      {files.map((f) => (
        <button key={f} type="button" className={`dp-file${f === on ? ' dp-on' : ''}`} onClick={() => pick(f)} title={f}>
          <Icon name="file" size={12} /><span className="dp-ell">{f}</span>
        </button>
      ))}
    </nav>
  );
}
