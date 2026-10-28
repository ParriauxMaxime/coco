import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import Markdown from './Markdown.tsx';
import Blocks from './Blocks.tsx';
import Checks, { VerifyChips } from './Checks.tsx';
import { api, errorMessage } from '../api.ts';
import { subscribe, topic } from '../live.ts';
import { toast } from './Toast.tsx';
import { pendingClass } from './action.ts';
import Icon from '../preview/Icon.tsx';
import { Avatar, PersonaName } from '../preview/parts.tsx';
import Activity from '../preview/chat/Activity.tsx';
import CardView from '../preview/chat/Card.tsx';
import { mergeCards } from '../preview/chat/cards.ts';
import { Composer } from '../preview/chat/Composer.tsx';
import { ModelControls, useModelChoice } from '../preview/chat/ModelPicker.tsx';
import { SentFiles } from '../preview/chat/Attachments.tsx';
import { CARD_MSG, CardMessage } from '../preview/chat/Conversation.tsx';
import type { ActivityEvent, Card, Suggestion as SuggestionData, SuggestionAction, Thread as ThreadData, ThreadGroup, ThreadMessage, ThreadSummary, UploadRef, VerifyRun } from '../types.ts';
import './thread.css';

const POLL_MS = 10000;
// a long thread shows its last turns (a turn starts at one of your messages); earlier ones load by threes when scrolled to
const SHOWN_TURNS = 3;
const MORE_TURNS = 3;
const OPEN = ['pending', 'queued', 'conflict'];
const STATE_CHIP: Record<string, string> = { pending: 'dp-info', queued: 'dp-warn', conflict: 'dp-bad', applied: 'dp-ok', dismissed: '' };
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
const groupLabel = (g: ThreadGroup) => `${g.id} · ${g.model.split('/').pop()}${g.files ? ` · ${g.files.map((f) => f.split('/').pop()).join(', ')}` : ''}`;

export const threadLabel = (s: ThreadSummary | undefined, idle: string) => (s?.asks ? `${s.asks === 1 ? 'a question' : `${s.asks} questions`} for you` : s?.waiting ? 'agent working…' : s?.open ? `${s.open} to review` : s?.count ? `thread · ${s.count}` : idle);

type ToggleProps ={ slug: string; threadKey: string; open?: boolean; onClick: () => void; label?: string };
export function ThreadToggle({ slug, threadKey: key, open, onClick, label: idle = 'ask an agent' }: ToggleProps) {
  const s = useThreadSummary(slug, key);
  const label = threadLabel(s, idle);
  return <button type="button" className={`dp-btn dp-sm dp-thread-toggle${open ? ' dp-on' : ''}${s?.open || s?.asks ? ' dp-hot' : ''}`} aria-expanded={open} title="One box: ask a scoped agent about it, or leave a remark with your verdict" onClick={onClick}>{s?.waiting ? <span className="dp-ag-dot dp-ag-running dp-thr-spin" aria-hidden /> : <Icon name="message-square" size={12} />}{label}</button>;
}

// options of a reply written before agents asked through cards: shown as they were, read-only
function OldChoices({ m }: { m: ThreadMessage }) {
  return (
    <ul className="dp-thr-choices">
      {(m.choices || []).map((c, i) => (
        <li key={i} className={`dp-thr-choice${m.picked === i ? ' dp-on' : ''}`}>
          <b>{c.label}</b>{c.text && <span>{c.text}</span>}{m.picked === i && <span className="dp-chip dp-acc">picked</span>}
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
type SuggestionProps = { s: SuggestionData; onDecide: (action: SuggestionAction) => void; busy: boolean; pending: string | null; verify?: VerifyRun; onVerify: () => void };
const VERIFIED_TAG: Record<string, string> = { pass: ' · verified ✓', fail: ' · checks failed' };
function VerifyButton({ run, busy, pending, onClick }: { run?: VerifyRun; busy: boolean; pending: boolean; onClick: () => void }) {
  return <button type="button" className={`dp-btn dp-sm${pendingClass(pending)}`} disabled={busy || run?.status === 'running'} title="Run the repo's lint, format, type check and nearby tests on this commit before you approve" onClick={onClick}><Icon name="check" size={12} />{run?.status === 'running' ? 'Verifying…' : run ? 'Verify again' : 'Verify'}</button>;
}
function Suggestion({ s, onDecide, busy, pending, verify, onVerify }: SuggestionProps) {
  const open = OPEN.includes(s.state);
  const red = s.checks?.state === 'failed';
  return (
    <div className="dp-thr-sugg">
      <div className="dp-thr-sugg-h">
        <span className={`dp-chip ${STATE_CHIP[s.state] ?? ''}`}>{s.state}</span>
        {s.kind === 'commit' ? <code>{s.commit.slice(0, 7)}</code> : <span>card change</span>}
        {s.kind === 'commit' && <span className="dp-ell">{s.files.map((f) => f.split('/').pop()).join(', ')}</span>}
        {s.appliedCommit && <span>→ <code>{s.appliedCommit.slice(0, 7)}</code></span>}
        {STATE_NOTE[s.state] && <span>{STATE_NOTE[s.state]}</span>}
      </div>
      <details open={open}>
        <summary>{s.kind === 'commit' ? 'Diff' : 'Fields'}</summary>
        <Markdown text={s.kind === 'commit' ? `\`\`\`diff\n${s.diff}\n\`\`\`` : `\`\`\`json\n${JSON.stringify(s.fields, null, 1)}\n\`\`\``} />
      </details>
      {s.checks && <Checks run={s.checks} />}
      {verify && <VerifyChips run={verify} />}
      {s.error && <div className="dp-thr-err">{s.error}</div>}
      {open && (
        <div className="dp-thr-sugg-f">
          {s.kind === 'commit' && <VerifyButton run={verify} busy={busy} pending={pending === 'verify'} onClick={onVerify} />}
          {s.kind === 'commit' && <span style={{ fontSize: 11, opacity: 0.7 }}>runs the repo's checks on the agent's code</span>}
          {s.state !== 'queued' && <button type="button" className={`dp-btn dp-sm dp-primary${pendingClass(pending === 'approve')}`} disabled={busy} title={red ? "coco's checks fail on this commit" : undefined} onClick={() => (!red || confirm("coco's checks fail on this commit. Approve anyway?")) && onDecide('approve')}><Icon name={s.state === 'conflict' ? 'refresh' : 'check'} size={12} />{s.state === 'conflict' ? 'Retry' : red ? 'Approve anyway' : 'Approve'}{s.kind === 'commit' && VERIFIED_TAG[verify?.status ?? ''] || ''}</button>}
          <button type="button" className={`dp-btn dp-sm${pendingClass(pending === 'dismiss')}`} disabled={busy} onClick={() => onDecide('dismiss')}><Icon name="x" size={12} />Dismiss</button>
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
    const off = subscribe(topic('thread', slug, key), {
      open: () => setEvents([]),
      message: (ev: ActivityEvent) => {
        if (ev.type !== 'thread') return setEvents((prev) => [...prev, ev]);
        clearTimeout(timer);
        timer = setTimeout(() => changed.current?.(), 100);
      },
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [slug, key]);
  return events;
}

// a scoped agent on one item: dispatch, follow its work live, read its answer, approve or dismiss what it suggests; writing to it never waits for it
// verdicts: [{ label, title, on(note) }] buttons that use the box text as remark instead of dispatching it
type ThreadProps = { slug: string; threadKey: string; onSettled?: () => void; verdicts?: Verdict[]; autoFocus?: boolean };
function EarlierTurns({ hidden, onMore }: { hidden: number; onMore: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const more = useRef(onMore);
  more.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // only once the reader scrolls up to it, not while it sits in view at mount
    let armed = false;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) armed = true;
      else if (armed) more.current();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hidden]);
  return <button ref={ref} type="button" className="dp-btn dp-sm dp-ghost dp-thr-more" onClick={onMore}><Icon name="history" size={12} />{hidden} earlier message{hidden > 1 ? 's' : ''}</button>;
}

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
  const [turns, setTurns] = useState(SHOWN_TURNS);
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
  const verify = (commit: string) => {
    setPending('verify');
    api.verifyThread(slug, key, commit).then(reload, (e) => toast.error(errorMessage(e))).finally(() => setPending(null));
  };
  const group = groups.find((g) => g.id === thread?.groupId);
  // shown at once, confirmed by the server; while the agent works the message steers its turn
  const send = (text: string, model?: string, files: UploadRef[] = [], thinking?: string) => {
    const nonce = nonceOf();
    setSending((s) => [...s, { nonce, text, files }]);
    api.postThread(slug, key, { text, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(files.length ? { attachments: files.map((f) => f.id) } : {}) })
      .then((next) => {
        wasWaiting.current = Boolean(next.waiting);
        setThread((prev) => keep(prev, next));
        refreshThreads(slug);
        settled.current?.();
      }, (e) => toast.error(errorMessage(e)))
      .finally(() => setSending((s) => s.filter((x) => x.nonce !== nonce)));
    return true;
  };

  if (!thread) return <div className={`dp-thr ${error ? 'dp-thr-err' : 'dp-thr-load'}`}>{error || 'Loading thread…'}</div>;
  const byMsg = activityByMessage(activity);
  const kind = decision ? 'decision' : plan ? 'plan' : 'code';
  const cards = thread.cards ?? [];
  const verifyRun = thread.ready ? thread.verifies?.[thread.ready.commit] : undefined;
  const slots = cardSlots(thread.messages, cards);
  const titles = new Map(cards.map((c) => [c.id, c.title]));
  const newest = cards.findLast((c) => c.status === 'open' && c.kind !== 'post')?.id;
  const onCard = (c: Card) => setThread((prev) => prev && { ...prev, cards: mergeCards(prev.cards ?? [], [c]) });
  const cardsAt = (i: number) => slots.get(i)?.map((c) => <CardView key={c.id} card={c} onCard={onCard} focus={c.id === newest} />);
  const others = groups.filter((g) => g.status === 'active' && g.id !== thread.groupId && g.kind === kind && (decision || String(g.n).replaceAll(':', '~') === prPart));
  const asks = thread.messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  const from = asks.length > turns ? asks[asks.length - turns] : 0;
  return (
    <div className="dp-thr">
      <div className="dp-thr-h">
        <span className="dp-ell">{group ? `Group ${groupLabel(group)}` : thread.newGroup ? 'A new agent group on the next message' : decision || plan ? 'No agent yet: the first message starts one' : 'No group yet: joins the one on the same file, or starts one'}</span>
        {group?.status === 'active' && thread.agent && (
          <span className={`dp-chip${thread.agent.live ? ' dp-ok' : ''}`} title={thread.agent.live ? 'The agent keeps this thread in context: the next message is sent as a new turn' : 'The agent is gone: the next message starts a new one with the whole thread'}>
            <span className="dp-d" />{thread.waiting?.deps ? `waiting for deps (${Math.max(0, Math.round((Date.now() - Date.parse(thread.waiting.deps.since)) / 1000))} s)` : thread.agent.live ? `agent live${thread.agent.status === 'running' ? ' · working' : ''}` : 'agent gone'}
          </span>
        )}
        <span className="dp-thr-hx">
        {!waiting && (group || others.length > 0) && (
          <select className="dp-inp" value="" disabled={busy} aria-label="Regroup" onChange={(e) => act('regroup', () => api.regroup(slug, key, e.target.value))}>
            <option value="" disabled>Regroup…</option>
            {others.map((g) => <option key={g.id} value={g.id}>{groupLabel(g)}</option>)}
            <option value="new">A new group</option>
          </select>
        )}
        {thread.messages.length > 1 && <button type="button" className={`dp-btn dp-sm dp-ghost${pendingClass(pending === 'rules')}`} disabled={busy} title="coco distills the corrections of this thread into proposed work rules" onClick={() => act('rules', async () => { await api.proposeRules(slug, { scope: 'work', threadKey: key }); setNote('coco is proposing rules: keep or drop them in the Rules tab'); return thread; })}><Icon name="book" size={12} />Rules</button>}
        {!waiting && group?.status === 'active' && <button type="button" className={`dp-btn dp-sm dp-ghost${pendingClass(pending === 'prune')}`} disabled={busy} title="Archive the group's agent and worktree, delete its branch" onClick={() => confirm(`Prune the agent of group ${group.id} (${group.items.length} item(s)): archive it and its worktree, delete its branch?`) && act('prune', async () => { await api.closeGroup(slug, group.id); return api.thread(slug, key); })}><Icon name="archive" size={12} />Prune agent</button>}
        </span>
      </div>
      {thread.ready && (
        <div className="dp-thr-sys dp-thr-ready">
          commit <code>{thread.ready.commit.slice(0, 7)}</code> ready{thread.ready.approve ? <>: <button type="button" className="dp-btn dp-sm dp-ghost" onClick={() => document.getElementById(`thr-${thread.ready?.approve}`)?.scrollIntoView({ block: 'center' })}>Approve</button></> : ', no Approve offered yet'} · {thread.ready.subject}{thread.ready.stat && <span className="dp-thr-stat"> · {thread.ready.stat}</span>}
          <VerifyButton run={verifyRun} busy={busy} pending={pending === 'verify'} onClick={() => verify(thread.ready!.commit)} />
          {verifyRun && !thread.ready.approve && <VerifyChips run={verifyRun} />}
        </div>
      )}
      {from > 0 && <EarlierTurns hidden={from} onMore={() => setTurns((t) => t + MORE_TURNS)} />}
      {thread.messages.map((m, i) => {
        if (i < from) return slots.get(i)?.some((c) => c.status === 'open') ? <React.Fragment key={m.id}>{cardsAt(i)}</React.Fragment> : null;
        const answered = m.card && m.role === 'user' ? CARD_MSG.exec(m.text ?? '') : null;
        return (
          <React.Fragment key={m.id}>
            {cardsAt(i)}
            {answered ? <CardMessage verb={answered[2]} title={titles.get(answered[1])} /> : m.role === 'system' && !m.agentId ? <div className="dp-thr-sys">{m.text}</div> : m.role === 'user' ? (
              <div className="dp-msg-u dp-cv-u">
                {(m.model || m.steer || m.turn === 'follow-up') && <div className="dp-cv-unote">{[m.model, m.steer ? 'while it worked' : m.turn === 'follow-up' ? 'new turn' : ''].filter(Boolean).join(' · ')}</div>}
                {m.files?.length ? <SentFiles files={m.files} /> : null}
                {m.blocks ? <Blocks blocks={m.blocks} /> : m.text && <Markdown text={m.text} />}
              </div>
            ) : (
              <div className="dp-msg-a" id={`thr-${m.id}`}>
                {m.role === 'system' ? <span className="dp-cocoav">c</span> : <span className="dp-bot dp-cv-av"><Icon name="bot" size={12} /></span>}
                <div className="dp-thr-body">
                  <div className="dp-who">{m.role === 'system' ? 'cocopilot' : `Agent ${String(m.agentId || '').slice(0, 8)}`}</div>
                  {m.files?.length ? <SentFiles files={m.files} /> : null}
                  {m.blocks ? <Blocks blocks={m.blocks} /> : m.text && <Markdown text={m.text} />}
                  {m.choices && <OldChoices m={m} />}
                  {m.suggestion && <Suggestion s={m.suggestion} verify={thread.verifies?.[m.suggestion.commit]} onVerify={() => verify(m.suggestion!.commit)} busy={busy} pending={pending?.startsWith(`${m.id}:`) ? pending.split(':')[1] : null} onDecide={(action) => act(`${m.id}:${action}`, () => api.suggestion(slug, key, m.id, action))} />}
                </div>
              </div>
            )}
            {(byMsg[m.id] || m.id === thread.waiting?.msgId) && <div className="dp-thr-acts"><Activity events={byMsg[m.id] || []} active={m.id === thread.waiting?.msgId} /></div>}
          </React.Fragment>
        );
      })}
      {cardsAt(thread.messages.length)}
      {sending.map((p) => <div key={p.nonce} className="dp-msg-u dp-cv-u dp-cv-sending"><div className="dp-cv-unote">sending…</div>{p.files.length > 0 && <SentFiles files={p.files} />}<Markdown text={p.text} /></div>)}
      <ThreadComposer
        busy={false}
        pending={pending}
        withModel={!group}
        sendLabel={!group ? 'Start agent' : waiting ? 'Send while it works' : 'Send'}
        verdicts={verdicts}
        autoFocus={autoFocus}
        persona={thread.persona}
        placeholder={waiting ? 'Write while it works: the message reaches the agent mid-turn (markdown, ↵)' : thread.messages.length ? 'Reply or ask for a change (markdown, ↵)' : plan ? 'Ask a scoped agent about the plan, or re-plan with this text as guidance (markdown, ↵)' : decision ? 'Ask about the card or for a card change (markdown, ↵)' : 'Ask the agent about it or for a fix (it suggests a commit you approve), or close it with this text as reason (markdown, ↵)'}
        onSend={send}
        onStop={thread.waiting?.agentId ? () => api.agentStop(thread.waiting?.agentId ?? '') : undefined}
      />
      {error && <div className="dp-thr-err">{error}</div>}
      {note && <div className="dp-thr-note">{note}</div>}
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
  onSend: (text: string, model?: string, files?: UploadRef[], thinking?: string) => SendResult | Promise<SendResult>;
  onStop?: () => Promise<unknown>;
  autoFocus?: boolean;
  // login of the reviewer mapped to the file: a chip prefills "What would <persona> do here?" (you still send it)
  persona?: string | null;
};
export function ThreadComposer({ busy, pending, withModel, sendLabel = 'Start agent', verdicts = [], placeholder = '', onSend, onStop, autoFocus = false, persona }: ComposerProps) {
  const model = useModelChoice('thread', { fast: true });
  return (
    <Composer
      className="dp-tcomp"
      placeholder={placeholder}
      sendLabel={sendLabel}
      autoFocus={autoFocus}
      busy={busy}
      sending={busy && (pending ?? 'send') === 'send'}
      tools={withModel && <ModelControls choice={model.choice} onPick={model.pick} hint="for the agent group this starts" />}
      actions={(text, clear, fill) => (
        <>
          {persona && <button type="button" className="dp-btn dp-sm dp-ghost" title={`Prefill the box with a question for ${persona}: a quick consult, not a persona review`} onClick={() => fill(`What would ${persona} do here?`)}><Avatar login={persona} />Ask <PersonaName login={persona} /></button>}
          {verdicts.map((v) => (
            <button key={v.label} type="button" className={`dp-btn dp-sm${pendingClass(v.pending || pending === v.label)}`} title={v.title} disabled={busy || (!v.allowEmpty && !text)} onClick={() => { v.on(text); clear(); }}>{v.label}</button>
          ))}
        </>
      )}
      onSend={async (text, files) => {
        const pick = withModel ? model.body() : {};
        return (await onSend(text, pick.provider, files, pick.thinking)) !== false;
      }}
      onStop={onStop}
    />
  );
}
