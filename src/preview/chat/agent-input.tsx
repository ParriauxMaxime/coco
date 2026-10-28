import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api.ts';
import type { AgentCommand } from '../../types.ts';
import './agent-input.css';

const SHOWN = 60;
const SLASH = /^\/(\S*)$/;

// what a composer bound to an agent adds, as in Paseo's: `/` at the start lists the agent's slash commands (filtered as you type, ↵ or Tab inserts),
// ↑ in an empty box recalls the prompts sent to it, newest first, ↓ goes back; text the user typed is never replaced
export function useAgentInput(agentId: string | null | undefined, text: string, setText: (t: string) => void) {
  const [commands, setCommands] = useState<{ list: AgentCommand[]; error: string | null } | null>(null);
  const [hi, setHi] = useState(0);
  const [closedOn, setClosedOn] = useState<string | null>(null);
  const prompts = useRef<string[] | null>(null);
  const recall = useRef<{ at: number; text: string } | null>(null);
  const loading = useRef(false);
  useEffect(() => {
    setCommands(null);
    prompts.current = null;
    recall.current = null;
    loading.current = false;
  }, [agentId]);

  const typed = agentId ? SLASH.exec(text) : null;
  useEffect(() => {
    if (!typed || !agentId || commands || loading.current) return;
    loading.current = true;
    api.agentCommands(agentId).then((r) => setCommands({ list: r.commands, error: r.error }), (e) => setCommands({ list: [], error: String(e?.message || e) })).finally(() => (loading.current = false));
  }, [Boolean(typed), agentId]);
  const query = typed?.[1].toLowerCase() ?? '';
  const matches = (commands?.list ?? []).filter((c) => c.name.toLowerCase().includes(query)).sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query))).slice(0, SHOWN);
  const open = Boolean(typed) && closedOn !== text;
  useEffect(() => setHi(0), [query]);
  const insert = (c: AgentCommand) => setText(`/${c.name} `);

  const go = (step: 1 | -1, el: HTMLTextAreaElement) => {
    const list = prompts.current;
    if (!list?.length) return;
    const at = (recall.current?.at ?? list.length) - step;
    if (at < 0) return;
    if (at >= list.length) {
      recall.current = null;
      return setText('');
    }
    recall.current = { at, text: list[at] };
    setText(list[at]);
    requestAnimationFrame(() => el.setSelectionRange(list[at].length, list[at].length));
  };
  const recalling = () => recall.current != null && recall.current.text === text;

  // true when the key was the menu's or the recall's, so the composer leaves it alone
  const key = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!agentId || e.nativeEvent.isComposing || e.altKey || e.metaKey || e.ctrlKey) return false;
    if (open && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHi((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        return true;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        insert(matches[Math.min(hi, matches.length - 1)]);
        return true;
      }
    }
    if (open && e.key === 'Escape') {
      e.preventDefault();
      setClosedOn(text);
      return true;
    }
    const el = e.currentTarget;
    if (e.key === 'ArrowUp' && !e.shiftKey && (text === '' || (recalling() && !el.value.slice(0, el.selectionStart).includes('\n')))) {
      e.preventDefault();
      if (prompts.current) go(1, el);
      else api.agentPrompts(agentId).then((r) => {
        prompts.current = r.prompts.map((p) => p.text);
        if (el.value === '') go(1, el);
      }, () => (prompts.current = []));
      return true;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && recalling() && !el.value.slice(el.selectionEnd).includes('\n')) {
      e.preventDefault();
      go(-1, el);
      return true;
    }
    return false;
  };

  // after a send the next ↑ reads the prompts again, the one just sent included
  const sent = () => {
    prompts.current = null;
    recall.current = null;
  };

  const menu = open && agentId ? (
    <div className="dp-pop dp-on dp-slash" role="listbox" aria-label="Slash commands">
      <div className="dp-pop-h"><b>Commands</b><span className="dp-xs dp-t3 dp-ell">↑↓ pick · ↵ or tab inserts · esc closes</span></div>
      <div className="dp-pop-s dp-slash-list">
        {!commands && <div className="dp-slash-note dp-xs dp-t3">Asking the agent for its commands…</div>}
        {commands?.error && <div className="dp-slash-note dp-xs dp-warn">{commands.error}</div>}
        {commands && !matches.length && !commands.error && <div className="dp-slash-note dp-xs dp-t3">No command matches /{query}</div>}
        {matches.map((c, i) => (
          <div key={c.name} ref={i === hi ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined} role="option" aria-selected={i === hi} className={`dp-mi dp-slash-mi${i === hi ? ' dp-hl' : ''}`} title={c.description || c.name} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); insert(c); }}>
            <span className="dp-slash-n">/{c.name}</span>
            {c.hint && <span className="dp-t3 dp-slash-h">{c.hint}</span>}
            <span className="dp-r dp-ell">{c.description}</span>
          </div>
        ))}
      </div>
    </div>
  ) : null;

  return { key, menu, sent };
}
