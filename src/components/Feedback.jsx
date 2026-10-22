import React, { useState } from 'react';
import { api } from '../api.js';

export default function Feedback({ node, title, verdicts = ['accurate', 'partly', 'wrong', 'missing'], placeholder }) {
  const [verdict, setVerdict] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');

  const send = async () => {
    setStatus('sending…');
    try {
      await api.sendFeedback({ node, title, verdict, text });
      setStatus(`sent ${new Date().toLocaleTimeString()}`);
      setText('');
      setVerdict('');
    } catch (e) {
      setStatus(`failed: ${e.message}`);
    }
  };

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--line)' }}>
      <div className="opts">
        {verdicts.map((v) => (
          <button key={v} data-v={v} className={verdict === v ? 'on' : ''} onClick={() => setVerdict(v)}>{v}</button>
        ))}
      </div>
      <textarea className="short" placeholder={placeholder || 'What is off, what is missing?'} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ marginTop: 6 }}>
        <button className="primary" disabled={!verdict && !text} onClick={send}>Send to host</button>
        <span className="status">{status}</span>
      </div>
    </div>
  );
}
