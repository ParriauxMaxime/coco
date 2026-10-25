import React, { useEffect, useMemo, useRef, useState } from 'react';
import './code.css';

const MAX_ROWS = 20;
const pathOf = (x) => (typeof x === 'string' ? x : x.filename || x.path);

// every typed char in order, case-insensitive; lower score is better, null = no match
export function fuzzyScore(path, query) {
  if (!query) return 0;
  const hay = path.toLowerCase();
  const slash = hay.lastIndexOf('/') + 1;
  let at = -1;
  let score = 0;
  for (const ch of query.toLowerCase()) {
    const next = hay.indexOf(ch, at + 1);
    if (next < 0) return null;
    score += next === at + 1 ? 0 : 3 + (next - at);
    if (next < slash) score += 1;
    at = next;
  }
  const base = hay.slice(slash);
  if (base.includes(query.toLowerCase())) score -= 20;
  return score + hay.length / 20;
}

export function useQuickOpenShortcut(onOpen) {
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpen]);
}

// prFiles: [{ filename } | path] · fetchTree(): Promise<{ files } | string[]> of every head file, called once on first open
export default function QuickOpen({ open, onClose, prFiles = [], fetchTree, onOpen }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [tree, setTree] = useState(null);
  const requested = useRef(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    inputRef.current?.focus();
    if (requested.current || !fetchTree) return;
    requested.current = true;
    Promise.resolve(fetchTree())
      .then((r) => setTree((Array.isArray(r) ? r : r?.files || []).map(pathOf)))
      .catch(() => {
        requested.current = false;
      });
  }, [open]);

  const rows = useMemo(() => {
    const pr = prFiles.map(pathOf);
    const inPr = new Set(pr);
    const all = [...pr, ...(tree || []).filter((p) => !inPr.has(p))];
    const scored = [];
    for (const p of all) {
      const score = fuzzyScore(p, query);
      if (score !== null) scored.push({ path: p, pr: inPr.has(p), score });
    }
    scored.sort((a, b) => Number(b.pr) - Number(a.pr) || a.score - b.score || a.path.localeCompare(b.path));
    return scored.slice(0, MAX_ROWS);
  }, [prFiles, tree, query]);

  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;
  const choose = (row) => {
    if (!row) return;
    onClose();
    onOpen(row.path);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[cursor]);
    }
  };
  return (
    <div className="qo-backdrop" onMouseDown={onClose}>
      <div className="qo" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          autoFocus
          className="qo-input"
          value={query}
          placeholder="Go to file (PR files first)"
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
        />
        <ul ref={listRef} className="qo-list">
          {rows.map((row, i) => (
            <li key={row.path} className={i === cursor ? 'on' : ''} onMouseEnter={() => setCursor(i)} onClick={() => choose(row)}>
              <span className="qo-path">{row.path}</span>
              {row.pr && <span className="chip c-blue">PR</span>}
            </li>
          ))}
          {!rows.length && <li className="qo-empty">{tree ? 'No match.' : 'Loading files…'}</li>}
        </ul>
      </div>
    </div>
  );
}
