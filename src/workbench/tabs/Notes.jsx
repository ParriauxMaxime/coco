import React, { useState } from 'react';
import { useWork } from '../use-work.js';

function StackEditor({ work, onSave }) {
  const [text, setText] = useState((work.stack || []).map((s) => s.number || `(${s.planned?.title || 'planned'})`).join(' '));
  const save = () => {
    const numbers = text.split(/[\s,→>-]+/).filter(Boolean).map((n) => Number(n.replace('#', ''))).filter(Boolean);
    const stack = numbers.map((number) => work.stack.find((s) => s.number === number) || { number, personas: [] });
    onSave(stack);
  };
  return (
    <div className="row" style={{ marginTop: 6 }}>
      <input style={{ flex: 1, minWidth: 220 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="PR numbers in merge order" />
      <button className="primary sm" onClick={save}>Save stack</button>
    </div>
  );
}

export default function Notes() {
  const { w, saveMeta, saveNotes, saveStack } = useWork();
  const [meta, setMeta] = useState({ title: w.title || '', description: w.description || '' });
  const [notes, setNotes] = useState(w.notes || '');
  const [status, setStatus] = useState('');
  const doMeta = async () => { await saveMeta(meta); setStatus('title and description saved'); };
  const doNotes = async () => { await saveNotes(notes); setStatus('notes saved'); };
  return (
    <>
      <h3>Title <span className="status">({(meta.title || '').length}/100)</span></h3>
      <input style={{ width: '100%' }} maxLength={100} value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
      <h3>Description <span className="status">markdown · a summary paragraph, then a before/after table or a mermaid diagram</span></h3>
      <textarea value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} style={{ minHeight: '28vh' }} />
      <div className="row" style={{ margin: '6px 0 14px' }}><button className="primary sm" onClick={doMeta}>Save title and description</button><span className="status">{status}</span></div>
      <h3>Notes <span className="status">rules of thumb, do not revisit</span></h3>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ minHeight: '30vh' }} />
      <div className="row" style={{ marginTop: 6 }}><button className="primary sm" onClick={doNotes}>Save notes</button><span className="status">{status}</span></div>
      <h3>Stack</h3><StackEditor key={w.updatedAt} work={w} onSave={saveStack} />
    </>
  );
}
