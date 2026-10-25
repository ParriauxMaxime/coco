import React, { useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { useConfig } from '../config.ts';
import { AskConversation, AskHistory, Proposal, useAskConversation } from './Ask.tsx';

// a link in, a work scaffold proposal out; the work exists once Create work is pressed
export default function Inbox() {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const github = useConfig((s) => s.repo.github);
  const convo = useAskConversation('inbox');
  const { run, history, watch, open, loadHistory } = convo;
  const read = async () => {
    setError('');
    setReading(true);
    try {
      const { id } = await api.inbox({ url, note });
      watch({ id, prompt: url, kind: 'inbox', status: 'running' });
      loadHistory();
      setUrl('');
      setNote('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setReading(false);
    }
  };
  return (
    <>
      <h1>Inbox</h1>
      <p className="sub">Paste a Notion page, a {github || 'GitHub'} PR or issue, or a Slack permalink. Coco reads it (read-only Notion, gh and Slack tools), then proposes a work: tier, title, Surface | Before | After table, precedents, surfaces, personas, planned stack. Follow up to reshape it. Nothing is created until you press Create work.</p>
      <div className="card">
        <input style={{ width: '100%' }} value={url} placeholder={`https://www.notion.so/… · https://github.com/${github || 'acme/widgets'}/issues/… · https://example.slack.com/archives/…`} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && !reading && read()} />
        <input style={{ width: '100%', marginTop: 6 }} value={note} placeholder="note for coco (optional): who asked, deadline, what you suspect" onChange={(e) => setNote(e.target.value)} />
        <div className="row" style={{ marginTop: 6 }}>
          <button className="primary" disabled={reading || !url.trim()} onClick={read}>{reading ? <><span className="spinner" aria-hidden /> starting coco…</> : 'Read and propose'}</button>
          {error && <span className="status danger">{error}</span>}
        </div>
      </div>
      {run && (
        <>
          <AskConversation convo={convo} placeholder="Reshape the proposal: smaller tier, split a PR, another precedent… (markdown, ⌘↵)" />
          <Proposal run={run} label="Create work" onApplied={(slug) => { location.hash = `#/work/${slug}`; }} />
        </>
      )}
      <AskHistory title="Previous links" history={history} onOpen={open} label={(h) => (h.prompt.split('\n')[0].match(/https?:\/\/\S+/) || [h.prompt])[0].slice(0, 110)} />
    </>
  );
}
