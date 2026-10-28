import React, { useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { toast } from '../components/Toast.tsx';
import './agent-title.css';

const MAX = 80;

// an agent header's title; a live agent's (agentId) is a click to rename it in Paseo, ↵ saves, esc leaves it
export function AgentTitle({ title, agentId, onRenamed }: { title: string; agentId: string | null; onRenamed?: (title: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ was: string; now: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // the new name shows until the lists bring it back
  const shown = saved && saved.was === title ? saved.now : title;
  if (!agentId) return <span className="dp-title dp-ell">{title}</span>;
  const save = async () => {
    const name = (draft ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name === shown) return setDraft(null);
    setBusy(true);
    try {
      const r = await api.renameAgent(agentId, name);
      setSaved({ was: title, now: r.title });
      setDraft(null);
      onRenamed?.(r.title);
    } catch (e) {
      toast.error(`Not renamed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };
  if (draft != null) {
    return (
      <input
        className="dp-inp dp-title dp-ag-rename"
        aria-label="Agent name"
        autoFocus
        maxLength={MAX}
        value={draft}
        disabled={busy}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void save(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(null); }
        }}
      />
    );
  }
  return (
    <span className="dp-title dp-ell dp-ag-name" role="button" tabIndex={0} title="Rename this agent (in Paseo too)" onClick={() => setDraft(shown)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); setDraft(shown); } }}>
      {shown}
    </span>
  );
}
