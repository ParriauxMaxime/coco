import React, { useLayoutEffect, useRef, useState } from 'react';

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

export function Composer({ placeholder, note, disabled = false, sendLabel = 'Send', onSend }: { placeholder: string; note?: string; disabled?: boolean; sendLabel?: string; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const send = async () => {
    const t = text.trim();
    if (t && !disabled && (await onSend(t))) setText('');
  };
  return (
    <div className="dp-composer">
      <div className="dp-composer-in">
        <textarea rows={2} value={text} disabled={disabled} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
        <div className="dp-comp-f">
          <span className="dp-xs dp-t3 dp-grow dp-ell">{note}</span>
          <button type="button" className="dp-btn dp-primary dp-sm" disabled={disabled || !text.trim()} onClick={() => void send()}>{sendLabel}<kbd>⌘</kbd><kbd>↵</kbd></button>
        </div>
      </div>
    </div>
  );
}
