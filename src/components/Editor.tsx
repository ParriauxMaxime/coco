import React, { useEffect, useState } from 'react';

export default function Editor({ load, save, label }) {
  const [text, setText] = useState('');
  const [initial, setInitial] = useState('');
  const [status, setStatus] = useState('loading…');

  useEffect(() => {
    let alive = true;
    setStatus('loading…');
    load().then((t) => {
      if (!alive) return;
      setText(t);
      setInitial(t);
      setStatus('');
    });
    return () => (alive = false);
  }, [load]);

  const dirty = text !== initial;
  const onSave = async () => {
    setStatus('saving…');
    try {
      const r = await save(text);
      setInitial(text);
      setStatus(`saved ${r.bytes} bytes, .bak kept`);
    } catch (e) {
      setStatus(`save failed: ${e.message}`);
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="sub" style={{ margin: 0 }}>{label}</span>
        <button className="primary" disabled={!dirty} onClick={onSave}>Save</button>
        <button disabled={!dirty} onClick={() => setText(initial)}>Revert</button>
        <span className="status">{status}{dirty && !status ? 'unsaved changes' : ''}</span>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
    </div>
  );
}
