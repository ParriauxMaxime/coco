import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import Markdown from './Markdown.tsx';
import Blocks from './Blocks.tsx';
import AgentActivity from './AgentActivity.tsx';
import { api, errorMessage } from '../api.ts';
import { toast } from './Toast.tsx';
import { pendingClass } from './action.ts';
import CardView from '../preview/chat/Card.tsx';
import { mergeCards } from '../preview/chat/cards.ts';
import { Composer } from '../preview/chat/Composer.tsx';
import { SentFiles } from '../preview/chat/Attachments.tsx';
import { CARD_MSG, CardMessage } from '../preview/chat/Conversation.tsx';
import type { ActivityEvent, Card, Suggestion as SuggestionData, SuggestionAction, Thread as ThreadData, ThreadGroup, ThreadMessage, ThreadSummary, UploadRef } from '../types.ts';

const POLL_MS = 10000;
const MODELS: [string, string][] = [['sonnet', 'Sonnet'], ['opus', 'Opus · deep']];
const OPEN = ['pending', 'queued', 'conflict'];
const STATE_CHIP: Record<string, string> = { pending: 'c-blue', queued: 'c-orange', conflict: 'c-red', applied: 'c-green', dismissed: 'c-grey' };
const STATE_NOTE: Record<string, string> = { queued: 'approved, applies when the PR worktree is free', conflict: 'does not apply on the PR branch' };

type ThreadsOf = { summaries: Record<string, ThreadSummary>; groups: ThreadGroup[] };
export type Verdict = { label: string; title?: string; on: (text: string) => void; allowEmpty?: boolean; className?: string; pending?: boolean };
type SendResult = boolean | undefined | void;

// per work: thread summaries ({ count, waiting, lastTs, groupId, open }) and dispatch groups, for toggles, the activity feed and regrouping
const useThreads = create<Record<string, ThreadsOf>>(() => ({}));
export const refreshThreads = (slug: string) => Promise.all([api.threads(slug), api.groups(slug)]).then(([summaries, groups]) => useThreads.setState({ [slug]: { summaries, groups } }), () => {});
const requested = new Set<string>();
export function useThreadsOf(slug: string): ThreadsOf {
  useEffect(() => {
    if (requested.has(slug)) return;
    requested.add(slug);
    refreshThreads(slug);
  }, [slug]);
  return useThreads((s) => s[slug]) || { summaries: {}, groups: [] };
}
export const useThreadSummary = (slug: string, key: string): ThreadSummary | undefined => useThreadsOf(slug).summaries[key];

export const threadKey = { decision: (id: string) => `d.${id}`, comment: (n: string | number, id: string) => `c.${String(n).replaceAll(':', '~')}.${id}`, plan: (n: string | number) => `p.${String(n).replaceAll(':', '~')}` };
const groupLabel = (g: ThreadGroup) => `${g.id} · ${g.model}${g.files ? ` · ${g.files.map((f) => f.split('/').pop()).join(', ')}` : ''}`;

export const threadLabel = (s: ThreadSummary | undefined, idle: string) => (s?.asks ? `${s.asks === 1 ? 'a question' : `${s.asks} questions`} for you` : s?.waiting ? 'agent working…' : s?.open ? `${s.open} to review` : s?.count ? `thread · ${s.count}` : idle);

type ToggleProps ={ slug: string; threadKey: string; open?: boolean; onClick: () => void; label?: string };
export function ThreadToggle({ slug, threadKey: key, open, onClick, label: idle = 'ask an agent' }: ToggleProps) {
  const s = useThreadSummary(slug, key);
  const label = threadLabel(s, idle);
  return <button type="button" className={`thread-toggle ${open ? 'on' : ''} ${s?.open || s?.asks ? 'hot' : ''}`} title="One box: ask a scoped agent about it, or leave a remark with your verdict" onClick={onClick}>{s?.waiting ? <span className="spinner" aria-hidden /> : '💬'} {label}</button>;
}

// options of a reply written before agents asked through cards: shown as they were, read-only
function OldChoices({ m }: { m: ThreadMessage }) {
  return (
    <ul className="thread-choices thread-choices-ro">
      {(m.choices || []).map((c, i) => (
        <li key={i} className={`thread-choice${m.picked === i ? ' on' : ''}`}>
          <b>{c.label}</b>{c.text && <span>{c.text}</span>}{m.picked === i && <span className="chip c-blue">picked</span>}
        </li>
      ))}
    </ul>
  );
}

// where a card sits: before the message recording its answer or effect, else before your first message after it, else at the end
function cardSlots(messages: ThreadMessage[], cards: Card[]) {
  const at = new Map<number, Card[]>();
  for (const c of cards) {
    let i = messages.findIndex((m) => m.card === c.id);
    if (i < 0) i = messages.findIndex((m) => m.role === 'user' && (m.ts ?? '') > c.createdAt);
    if (i < 0) i = messages.length;
    at.set(i, [...(at.get(i) ?? []), c]);
  }
  return at;
}

// pending: 'approve' | 'dismiss' while that decision is in flight
type SuggestionProps = { s: SuggestionData; onDecide: (action: SuggestionAction) => void; busy: boolean; pending: string | null };
function Suggestion({ s, onDecide, busy, pending }: SuggestionProps) {
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

const nonceOf = () => Math.random().toString(36).slice(2, 12);
// a POST answers the thread without its agent or cards: keep the ones already shown
const keep = (prev: ThreadData | null, next: ThreadData): ThreadData => ({ ...next, agent: next.agent ?? prev?.agent ?? null, cards: next.cards ?? prev?.cards });

// each message's share of the agent's activity; a call that settles after a steer stays with the message it started under
function activityByMessage(events: ActivityEvent[]) {
  const owner = new Map<string, string>();
  const out: Record<string, ActivityEvent[]> = {};
  for (const ev of events) {
    const msgId = String((ev.type === 'tool' && ev.id && owner.get(ev.id)) || ev.msgId);
    if (ev.type === 'tool' && ev.id && !owner.has(ev.id)) owner.set(ev.id, msgId);
    (out[msgId] ||= []).push(ev);
  }
  return out;
}

// the thread's agent activity over SSE (stored, then live), and a fresh thread on every change the server reports
function useThreadStream(slug: string, key: string, onChange: () => void) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource(`/api/works/${slug}/threads/${key}/events`);
    es.onopen = () => setEvents([]);
    es.onmessage = (m) => {
      const ev: ActivityEvent = JSON.parse(m.data);
      if (ev.type !== 'thread') return setEvents((prev) => [...prev, ev]);
      clearTimeout(timer);
      timer = setTimeout(() => changed.current?.(), 100);
    };
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [slug, key]);
  return events;
}

// a scoped agent on one item: dispatch, follow its work live, read its answer, approve or dismiss what it suggests; writing to it never waits for it
// verdicts: [{ label, title, on(note) }] buttons that use the box text as remark instead of dispatching it
type ThreadProps = { slug: string; threadKey: string; onSettled?: () => void; verdicts?: Verdict[]; autoFocus?: boolean };
export default function Thread({ slug, threadKey: key, onSettled, verdicts = [], autoFocus = false }: ThreadProps) {
  const { groups } = useThreadsOf(slug);
  const [thread, setThread] = useState<ThreadData | null>(null);
  const [error, setError] = useState('');
  // which action is in flight: 'approve', 'dismiss', 'regroup', 'prune', 'rules' or a verdict label
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;
  // messages sent and not confirmed yet
  const [sending, setSending] = useState<{ nonce: string; text: string; files: UploadRef[] }[]>([]);
  const [note, setNote] = useState('');
  const waiting = Boolean(thread?.waiting);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const decision = key.startsWith('d.');
  const plan = key.startsWith('p.');
  const prPart = key.split('.')[1];

  const wasWaiting = useRef(false);
  wasWaiting.current = waiting;
  const reload = () => api.thread(slug, key).then((t) => {
    const answered = wasWaiting.current && !t.waiting;
    wasWaiting.current = Boolean(t.waiting);
    setThread(t);
    refreshThreads(slug);
    if (answered) settled.current?.();
  }, () => {});
  const activity = useThreadStream(slug, key, reload);
  useEffect(() => {
    api.thread(slug, key).then(setThread, (e) => setError(errorMessage(e)));
  }, [slug, key]);
  // the stream reports replies at once; this catches an agent coco does not follow
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [slug, key, waiting]);
  // a queued approval lands when the PR worktree frees up: follow it through the summaries poll
  const queued = Boolean(thread?.messages.some((m) => m.suggestion?.state === 'queued'));
  useEffect(() => {
    if (!queued) return;
    const timer = setInterval(() => refreshThreads(slug).then(() => api.thread(slug, key).then(setThread)), POLL_MS * 5);
    return () => clearInterval(timer);
  }, [slug, key, queued]);

  const act = async (what: string, fn: () => Promise<ThreadData>) => {
    setPending(what);
    try {
      const next = await fn();
      setThread((prev) => keep(prev, next));
      refreshThreads(slug);
      settled.current?.();
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setPending(null);
    }
  };
  const group = groups.find((g) => g.id === thread?.groupId);
  // shown at once, confirmed by the server; while the agent works the message steers its turn
  const send = (text: string, model?: string, files: UploadRef[] = []) => {
    const nonce = nonceOf();
    setSending((s) => [...s, { nonce, text, files }]);
    api.postThread(slug, key, { text, ...(model ? { model } : {}), ...(files.length ? { attachments: files.map((f) => f.id) } : {}) })
      .then((next) => {
        wasWaiting.current = Boolean(next.waiting);
        setThread((prev) => keep(prev, next));
        refreshThreads(slug);
        settled.current?.();
      }, (e) => toast.error(errorMessage(e)))
      .finally(() => setSending((s) => s.filter((x) => x.nonce !== nonce)));
    return true;
  };

  if (!thread) return <div className="thread status">{error || 'Loading thread…'}</div>;
  const byMsg = activityByMessage(activity);
  const kind = decision ? 'decision' : plan ? 'plan' : 'code';
  const cards = thread.cards ?? [];
  const slots = cardSlots(thread.messages, cards);
  const titles = new Map(cards.map((c) => [c.id, c.title]));
  const newest = cards.findLast((c) => c.status === 'open' && c.kind !== 'post')?.id;
  const onCard = (c: Card) => setThread((prev) => prev && { ...prev, cards: mergeCards(prev.cards ?? [], [c]) });
  const cardsAt = (i: number) => slots.get(i)?.map((c) => <CardView key={c.id} card={c} onCard={onCard} focus={c.id === newest} />);
  const others = groups.filter((g) => g.status === 'active' && g.id !== thread.groupId && g.kind === kind && (decision || String(g.n).replaceAll(':', '~') === prPart));
  return (
    <div className="thread">
      <div className="row thread-group">
        <span className="status">{group ? `group ${groupLabel(group)}` : thread.newGroup ? 'a new agent group on the next message' : decision || plan ? 'no agent yet: the first message starts one' : 'no group yet: joins the one on the same file, or starts one'}</span>
        {group?.status === 'active' && thread.agent && (
          <span className={`chip ${thread.agent.live ? 'c-green' : 'c-grey'}`} title={thread.agent.live ? 'The agent keeps this thread in context: the next message is sent as a new turn' : 'The agent is gone: the next message starts a new one with the whole thread'}>
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
      {thread.messages.map((m, i) => {
        const answered = m.card && m.role === 'user' ? CARD_MSG.exec(m.text ?? '') : null;
        return (
          <React.Fragment key={m.id}>
            {cardsAt(i)}
            {answered ? <CardMessage verb={answered[2]} title={titles.get(answered[1])} /> : (
              <div className={`thread-msg ${m.role}`}>
                {m.role === 'system' && !m.agentId ? <span className="status">{m.text}</span> : (
                  <>
                    <b>{m.role === 'user' ? `You${m.model ? ` · ${m.model}` : ''}${m.steer ? ' · while it worked' : m.turn === 'follow-up' ? ' · new turn' : ''}` : m.role === 'system' ? 'cocopilot' : `Agent ${String(m.agentId || '').slice(0, 8)}`}</b>
                    {m.files?.length ? <SentFiles files={m.files} /> : null}
                    {m.blocks ? <Blocks blocks={m.blocks} /> : m.text && <Markdown text={m.text} />}
                    {m.choices && <OldChoices m={m} />}
                    {m.suggestion && <Suggestion s={m.suggestion} busy={busy} pending={pending?.startsWith(`${m.id}:`) ? pending.split(':')[1] : null} onDecide={(action) => act(`${m.id}:${action}`, () => api.suggestion(slug, key, m.id, action))} />}
                  </>
                )}
              </div>
            )}
            {(byMsg[m.id] || m.id === thread.waiting?.msgId) && <div className="thread-activity"><AgentActivity events={byMsg[m.id] || []} active={m.id === thread.waiting?.msgId} /></div>}
          </React.Fragment>
        );
      })}
      {cardsAt(thread.messages.length)}
      {sending.map((p) => <div key={p.nonce} className="thread-msg user" style={{ opacity: 0.6 }}><b>You · sending…</b>{p.files.length > 0 && <SentFiles files={p.files} />}<Markdown text={p.text} /></div>)}
      <ThreadComposer
        busy={false}
        pending={pending}
        withModel={!group}
        sendLabel={!group ? 'Start agent' : waiting ? 'Send while it works' : 'Send'}
        verdicts={verdicts}
        autoFocus={autoFocus}
        placeholder={waiting ? 'Write while it works: the message reaches the agent mid-turn (markdown, ↵)' : thread.messages.length ? 'Reply or ask for a change (markdown, ↵)' : plan ? 'Ask a scoped agent about the plan, or re-plan with this text as guidance (markdown, ↵)' : decision ? 'Ask about the card or for a card change (markdown, ↵)' : 'Ask the agent about it or for a fix (it suggests a commit you approve), or close it with this text as reason (markdown, ↵)'}
        onSend={send}
        onStop={thread.waiting?.agentId ? () => api.agentStop(thread.waiting?.agentId ?? '') : undefined}
      />
      {error && <div className="danger status">{error}</div>}
      {note && <div className="status">{note}</div>}
    </div>
  );
}

// the one text box of an item: Dispatch sends it to the scoped agent (model picked on the first dispatch), verdicts close the item with it as reason
// verdicts: [{ label, title, on(text), allowEmpty?, className?, pending? }] · pending: 'send' while the dispatch is in flight
type ComposerProps = {
  busy: boolean;
  pending?: string | null;
  withModel?: boolean;
  sendLabel?: string;
  verdicts?: Verdict[];
  placeholder?: string;
  onSend: (text: string, model?: string, files?: UploadRef[]) => SendResult | Promise<SendResult>;
  onStop?: () => Promise<unknown>;
  autoFocus?: boolean;
};
export function ThreadComposer({ busy, pending, withModel, sendLabel = 'Start agent', verdicts = [], placeholder = '', onSend, onStop, autoFocus = false }: ComposerProps) {
  const [model, setModel] = useState('sonnet');
  return (
    <Composer
      className="dp-tcomp"
      placeholder={placeholder}
      sendLabel={sendLabel}
      autoFocus={autoFocus}
      busy={busy}
      sending={busy && (pending ?? 'send') === 'send'}
      tools={withModel && (
        <span className="dp-seg" role="group" aria-label="Model">
          {MODELS.map(([k, label]) => <button key={k} type="button" className={model === k ? 'dp-on' : 'dp-off'} onClick={() => setModel(k)}>{label}</button>)}
        </span>
      )}
      actions={(text, clear) => verdicts.map((v) => (
        <button key={v.label} type="button" className={`dp-btn dp-sm${pendingClass(v.pending || pending === v.label)}`} title={v.title} disabled={busy || (!v.allowEmpty && !text)} onClick={() => { v.on(text); clear(); }}>{v.label}</button>
      ))}
      onSend={async (text, files) => (await onSend(text, withModel ? model : undefined, files)) !== false}
      onStop={onStop}
    />
  );
}
