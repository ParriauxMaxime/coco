import React, { useState } from 'react';
import { api } from '../api.js';
import { useConfig } from '../config.js';
import { Proposal, Transcript, useAskRun } from './Ask.jsx';

// a link in, a work scaffold proposal out; the work exists once Create work is pressed
export default function Inbox() {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const github = useConfig((s) => s.repo.github);
  const { run, events, history, busy, setBusy, follow, open } = useAskRun('inbox');
  const read = async () => {
    setError('');
    setBusy(true);
    try {
      const { id } = await api.inbox({ url, note });
      follow(id, url);
      setUrl('');
      setNote('');
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <>
      <h1>Inbox</h1>
      <p className="sub">Paste a Notion page, a {github || 'GitHub'} PR or issue, or a Slack permalink. Coco reads it (read-only Notion, gh and Slack tools), then proposes a work: tier, title, Surface | Before | After table, precedents, surfaces, personas, planned stack. Nothing is created until you press Create work.</p>
      <div className="card">
        <input style={{ width: '100%' }} value={url} placeholder={`https://www.notion.so/… · https://github.com/${github || 'acme/widgets'}/issues/… · https://example.slack.com/archives/…`} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && !busy && read()} />
        <input style={{ width: '100%', marginTop: 6 }} value={note} placeholder="note for coco (optional): who asked, deadline, what you suspect" onChange={(e) => setNote(e.target.value)} />
        <div className="row" style={{ marginTop: 6 }}>
          <button className="primary" disabled={busy || !url.trim()} onClick={read}>{busy ? <><span className="spinner" aria-hidden /> coco is reading…</> : 'Read and propose'}</button>
          {error && <span className="status danger">{error}</span>}
        </div>
      </div>
      {run && (
        <>
          <div className="card"><div className="status" style={{ marginBottom: 6 }}>run {run.id.slice(0, 8)} · {run.prompt.split('\n')[0]}</div><Transcript events={events} /></div>
          <Proposal run={run} label="Create work" onApplied={(slug) => { location.hash = `#/work/${slug}`; }} />
        </>
      )}
      {history.length > 0 && (
        <>
          <h2>Previous links</h2>
          <div className="card">{history.map((h) => <div key={h.id} className="list-item row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => open(h)}><span><span className={`chip ${h.status === 'done' ? 'c-green' : 'c-red'}`}>{h.status}</span> {(h.prompt.split('\n')[0].match(/https?:\/\/\S+/) || [h.prompt])[0].slice(0, 110)}</span><span className="status">{h.startedAt.slice(0, 16).replace('T', ' ')}{h.proposal ? ` · ${h.proposal.title}` : ''}</span></div>)}</div>
        </>
      )}
    </>
  );
}
