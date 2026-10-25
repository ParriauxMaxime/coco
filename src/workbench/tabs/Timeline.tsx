import React, { useState } from 'react';
import { useWork } from '../use-work.ts';

export default function Timeline() {
  const { w, addNote } = useWork();
  const [note, setNote] = useState('');
  const add = async () => { await addNote(note); setNote(''); };
  return (
    <>
      <div className="row" style={{ margin: '0 0 8px' }}><input style={{ flex: 1 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="what happened…" /><button className="primary sm" onClick={add}>Add</button></div>
      {(w.timeline || []).map((t, i) => <div key={i} className="list-item"><span className={`chip ${t.kind === 'github' ? 'c-blue' : t.kind === 'coco' || t.kind === 'review' ? 'c-purple' : t.kind === 'decision' ? 'c-green' : 'c-grey'}`}>{t.kind}</span> {t.text} <span className="status">{t.ts.slice(0, 16).replace('T', ' ')}</span></div>)}
    </>
  );
}
