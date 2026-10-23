import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import Markdown from './Markdown.jsx';
import Blocks from './Blocks.jsx';
import { api } from '../api.js';
import { toast } from './Toast.jsx';
import { pendingClass } from './action.js';

const POLL_MS = 3000;
const MODELS = [['sonnet', 'Sonnet'], ['opus', 'Opus · deep']];
const OPEN = ['pending', 'queued', 'conflict'];
const STATE_CHIP = { pending: 'c-blue', queued: 'c-orange', conflict: 'c-red', applied: 'c-green', dismissed: 'c-grey' };
const STATE_NOTE = { queued: 'approved, applies when the PR worktree is free', conflict: 'does not apply on the PR branch' };

// per work: thread summaries ({ count, waiting, lastTs, groupId, open }) and dispatch groups, for toggles, the activity feed and regrouping
const useThreads = create(() => ({}));
export const refreshThreads = (slug) => Promise.all([api.threads(slug), api.groups(slug)]).then(([summaries, groups]) => useThreads.setState({ [slug]: { summaries, groups } }), () => {});
const requested = new Set();
export function useThreadsOf(slug) {
  useEffect(() => {
    if (requested.has(slug)) return;
    requested.add(slug);
    refreshThreads(slug);
  }, [slug]);
  return useThreads((s) => s[slug]) || { summaries: {}, groups: [] };
}
export const useThreadSummary = (slug, key) => useThreadsOf(slug).summaries[key];

export const threadKey = { decision: (id) => `d.${id}`, comment: (n, id) => `c.${String(n).replaceAll(':', '~')}.${id}`, plan: (n) => `p.${String(n).replaceAll(':', '~')}` };
const groupLabel = (g) => `${g.id} · ${g.model}${g.files ? ` · ${g.files.map((f) => f.split('/').pop()).join(', ')}` : ''}`;

export function ThreadToggle({ slug, threadKey: key, open, onClick, label: idle = 'discuss or dispatch' }) {
  const s = useThreadSummary(slug, key);
  const label = s?.waiting ? 'agent working…' : s?.open ? `${s.open} to review` : s?.count ? `thread · ${s.count}` : idle;
  return <button type="button" className={`thread-toggle ${open ? 'on' : ''} ${s?.open ? 'hot' : ''}`} title="One box: dispatch a scoped agent on it, or leave a remark with your verdict" onClick={onClick}>{s?.waiting ? <span className="spinner" aria-hidden /> : '💬'} {label}</button>;
}

// pending: 'approve' | 'dismiss' while that decision is in flight
function Suggestion({ s, onDecide, busy, pending }) {
  const open = OPEN.includes(s.state);
  return (
    <div className="thread-sugg">
      <div className="row" style={{ gap: 6 }}>
        <span className={`chip ${STATE_CHIP[s.state] || 'c-grey'}`}>{s.state}</span>
        {s.kind === 'commit' ? <code>{s.commit.slice(0, 7)}</code> : <span className="status">card change</span>}
        {s.kind === 'commit' && <span className="status">{s.files.map((f) => f.split('/').pop()).join(', ')}</span>}
        {s.appliedCommit && <span className="status">→ {s.appliedCommit.slice(0, 7)}</span>}
        {STATE_NOTE[s.state] && <span className="status">{STATE_NOTE[s.state]}</span>}
      </div>
      <details open={open}>
        <summary className="status">{s.kind === 'commit' ? 'diff' : 'fields'}</summary>
        <Markdown text={s.kind === 'commit' ? `\`\`\`diff\n${s.diff}\n\`\`\`` : `\`\`\`json\n${JSON.stringify(s.fields, null, 1)}\n\`\`\``} />
      </details>
      {s.error && <div className="danger status">{s.error}</div>}
      {open && (
        <div className="row" style={{ gap: 6 }}>
          {s.state !== 'queued' && <button type="button" className={`sm primary${pendingClass(pending === 'approve')}`} disabled={busy} onClick={() => onDecide('approve')}>{s.state === 'conflict' ? 'Retry' : 'Approve'}</button>}
          <button type="button" className={`sm${pendingClass(pending === 'dismiss')}`} disabled={busy} onClick={() => onDecide('dismiss')}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

// a scoped agent on one item: dispatch, read its answer, approve or dismiss what it suggests
// verdicts: [{ label, title, on(note) }] buttons that use the box text as remark instead of dispatching it
export default function Thread({ slug, threadKey: key, onSettled, verdicts = [], autoFocus = false }) {
  const { groups } = useThreadsOf(slug);
  const [thread, setThread] = useState(null);
  const [error, setError] = useState('');
  // which action is in flight: 'send', 'approve', 'dismiss', 'regroup', 'prune', 'rules' or a verdict label
  const [pending, setPending] = useState(null);
  const busy = pending !== null;
  const [note, setNote] = useState('');
  const waiting = Boolean(thread?.waiting);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const decision = key.startsWith('d.');
  const plan = key.startsWith('p.');
  const prPart = key.split('.')[1];

  useEffect(() => {
    api.thread(slug, key).then(setThread, (e) => setError(e.message));
  }, [slug, key]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => api.thread(slug, key).then((t) => {
      setThread(t);
      if (t.waiting) return;
      refreshThreads(slug);
      settled.current?.();
    }, () => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [slug, key, waiting]);
  // a queued approval lands when the PR worktree frees up: follow it through the summaries poll
  const queued = Boolean(thread?.messages.some((m) => m.suggestion?.state === 'queued'));
  useEffect(() => {
    if (!queued) return;
    const timer = setInterval(() => refreshThreads(slug).then(() => api.thread(slug, key).then(setThread)), POLL_MS * 5);
    return () => clearInterval(timer);
  }, [slug, key, queued]);

  const act = async (what, fn) => {
    setPending(what);
    try {
      const next = await fn();
      setThread((prev) => ({ ...next, agent: next.agent ?? prev?.agent ?? null }));
      refreshThreads(slug);
      settled.current?.();
    } catch (e) {
      toast.error(e.message);
      return false;
    } finally {
      setPending(null);
    }
  };
  const group = groups.find((g) => g.id === thread?.groupId);
  const send = (text, model) => act('send', async () => {
    await api.postThread(slug, key, { text, ...(model ? { model } : {}) });
    return api.thread(slug, key);
  });

  if (!thread) return <div className="thread status">{error || 'Loading thread…'}</div>;
  const kind = decision ? 'decision' : plan ? 'plan' : 'code';
  const others = groups.filter((g) => g.status === 'active' && g.id !== thread.groupId && g.kind === kind && (decision || String(g.n).replaceAll(':', '~') === prPart));
  return (
    <div className="thread">
      <div className="row thread-group">
        <span className="status">{group ? `group ${groupLabel(group)}` : thread.newGroup ? 'new group on next dispatch' : decision || plan ? 'no agent yet: the first dispatch starts one' : 'no group yet: joins the one on the same file, or starts one'}</span>
        {group?.status === 'active' && thread.agent && (
          <span className={`chip ${thread.agent.live ? 'c-green' : 'c-grey'}`} title={thread.agent.live ? 'The agent keeps this thread in context: the next message is sent as a new turn' : 'The agent is gone: the next dispatch starts a new one with the whole thread'}>
            {thread.agent.live ? `agent live${thread.agent.status === 'running' ? ' · working' : ''}` : 'agent gone'}
          </span>
        )}
        {!waiting && (group || others.length > 0) && (
          <select value="" disabled={busy} onChange={(e) => act('regroup', () => api.regroup(slug, key, e.target.value))}>
            <option value="" disabled>regroup…</option>
            {others.map((g) => <option key={g.id} value={g.id}>{groupLabel(g)}</option>)}
            <option value="new">a new group</option>
          </select>
        )}
        {thread.messages.length > 1 && <button type="button" className={`sm${pendingClass(pending === 'rules')}`} disabled={busy} title="coco distills the corrections of this thread into proposed work rules" onClick={() => act('rules', async () => { await api.proposeRules(slug, { scope: 'work', threadKey: key }); setNote('coco is proposing rules: keep or drop them in the Rules tab'); return thread; })}>🦜 rules</button>}
        {!waiting && group?.status === 'active' && <button type="button" className={`sm${pendingClass(pending === 'prune')}`} disabled={busy} title="Archive the group's agent and worktree, delete its branch" onClick={() => confirm(`Prune the agent of group ${group.id} (${group.items.length} item(s)): archive it and its worktree, delete its branch?`) && act('prune', async () => { await api.closeGroup(slug, group.id); return api.thread(slug, key); })}>prune agent</button>}
      </div>
      {thread.messages.map((m) => (
        <div key={m.id} className={`thread-msg ${m.role}`}>
          {m.role === 'system' && !m.agentId ? <span className="status">{m.text}</span> : (
            <>
              <b>{m.role === 'user' ? `You${m.model ? ` · ${m.model}` : ''}${m.turn === 'follow-up' ? ' · new turn' : ''}` : m.role === 'system' ? 'cocopilot' : `Agent ${String(m.agentId || '').slice(0, 8)}`}</b>
              {m.blocks ? <Blocks blocks={m.blocks} /> : m.text && <Markdown text={m.text} />}
              {m.suggestion && <Suggestion s={m.suggestion} busy={busy} pending={pending?.startsWith(`${m.id}:`) ? pending.split(':')[1] : null} onDecide={(action) => act(`${m.id}:${action}`, () => api.suggestion(slug, key, m.id, action))} />}
            </>
          )}
        </div>
      ))}
      {waiting && <div className="thread-msg agent status"><span className="spinner" aria-hidden /> Agent {thread.waiting.agentId?.slice(0, 8)} is working…</div>}
      {!waiting && (
        <ThreadComposer
          busy={busy}
          pending={pending}
          withModel={!group}
          sendLabel={group ? 'Send' : 'Dispatch'}
          verdicts={verdicts}
          autoFocus={autoFocus}
          placeholder={thread.messages.length ? 'Reply or ask for a change (markdown, ⌘↵)' : plan ? 'Ask a scoped agent about the plan, or re-plan with this text as guidance (markdown, ⌘↵)' : decision ? 'Ask about the card or for a card change (markdown, ⌘↵)' : 'Ask the agent about it or for a fix (it suggests a commit you approve), or close it with this text as reason (markdown, ⌘↵)'}
          onSend={send}
        />
      )}
      {error && <div className="danger status">{error}</div>}
      {note && <div className="status">{note}</div>}
    </div>
  );
}

// the one text box of an item: Dispatch sends it to the scoped agent (model picked on the first dispatch), verdicts close the item with it as reason
// verdicts: [{ label, title, on(text), allowEmpty?, className?, pending? }] · pending: 'send' while the dispatch is in flight
export function ThreadComposer({ busy, pending, withModel, sendLabel = 'Dispatch', verdicts = [], placeholder, onSend, autoFocus = false, rows = 2 }) {
  const [text, setText] = useState('');
  const [model, setModel] = useState('sonnet');
  const send = async () => {
    if (!text.trim()) return;
    if ((await onSend(text.trim(), withModel ? model : undefined)) !== false) setText('');
  };
  return (
    <>
      <textarea
        className="cc-textarea"
        rows={rows}
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
      />
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className={`sm primary${pendingClass(busy && (pending ?? 'send') === 'send')}`} disabled={busy || !text.trim()} onClick={send}>{sendLabel}</button>
        {withModel && (
          <span className="rv-seg">
            {MODELS.map(([k, label]) => <button key={k} type="button" className={model === k ? 'on' : ''} onClick={() => setModel(k)}>{label}</button>)}
          </span>
        )}
        {verdicts.length > 0 && <span className="cc-spacer" />}
        {verdicts.map((v) => <button key={v.label} type="button" className={`sm ${v.className || ''}${pendingClass(v.pending || pending === v.label)}`} title={v.title} disabled={busy || (!v.allowEmpty && !text.trim())} onClick={() => { v.on(text.trim()); setText(''); }}>{v.label}</button>)}
      </div>
    </>
  );
}
