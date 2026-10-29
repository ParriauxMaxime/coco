import React, { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import Markdown from './Markdown.tsx';
import Blocks from './Blocks.tsx';
import Checks, { VerifyChips } from './Checks.tsx';
import { api, errorMessage } from '../api.ts';
import { subscribe, topic } from '../live.ts';
import { toast } from './Toast.tsx';
import { confirmDialog } from './Dialogs.tsx';
import { pendingClass } from './action.ts';
import { useSeen } from '../preview/waiting.ts';
import Icon from '../preview/Icon.tsx';
import { Avatar, PersonaName } from '../preview/parts.tsx';
import Activity from '../preview/chat/Activity.tsx';
import CardView from '../preview/chat/Card.tsx';
import { mergeCards } from '../preview/chat/cards.ts';
import { Composer, refillDraft } from '../preview/chat/Composer.tsx';
import { ModelControls, useModelChoice } from '../preview/chat/ModelPicker.tsx';
import { SentFiles } from '../preview/chat/Attachments.tsx';
import { useNow } from '../preview/subagents.ts';
import { CARD_MSG, CardMessage } from '../preview/chat/Conversation.tsx';
import { useWorkbench } from '../workbench/workbench-store.ts';
import { commitTabId } from '../workbench/code/ids.ts';
import type { ActivityEvent, Block, Card, Suggestion as SuggestionData, SuggestionAction, Thread as ThreadData, ThreadGroup, ThreadInbound, ThreadMessage, ThreadStep, ThreadSummary, UploadRef, VerifyRun } from '../types.ts';
import './thread.css';

const POLL_MS = 10000;
// a long thread shows its last turns (a turn starts at one of your messages), those already read one line each; earlier ones load when scrolled to
const SHOWN_TURNS = 8;
const MORE_TURNS = 8;
const OPEN = ['pending', 'queued', 'conflict'];
const STATE_CHIP: Record<string, string> = { pending: 'dp-info', queued: 'dp-warn', conflict: 'dp-bad', applied: 'dp-ok', dismissed: '' };
const STATE_NOTE: Record<string, string> = { queued: 'approved while the PR worktree was busy: Approve again', conflict: 'does not apply on the PR branch', superseded: 'the agent rewrote this commit: approve the newer one' };

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
export const openCommitTab = (key: string, msgId: string) => {
  const s = useWorkbench.getState();
  s.open(commitTabId(key, msgId), { group: s.otherGroup() });
};
const groupLabel =(g: ThreadGroup) => `${g.id} · ${g.model.split('/').pop()}${g.files ? ` · ${g.files.map((f) => f.split('/').pop()).join(', ')}` : ''}`;

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

// pending: 'approve' | 'dismiss' | 'verify' while that action is in flight
type SuggestionActionsProps = { s: SuggestionData; onDecide: (action: SuggestionAction) => void; busy: boolean; pending: string | null; verify?: VerifyRun; onVerify: () => void };
const VERIFIED_TAG: Record<string, string> = { pass: ' · verified ✓', fail: ' · checks failed' };
function VerifyButton({ run, busy, pending, onClick }: { run?: VerifyRun; busy: boolean; pending: boolean; onClick: () => void }) {
  return <button type="button" className={`dp-btn dp-sm${pendingClass(pending)}`} disabled={busy || run?.status === 'running'} title="Run the repo's lint, format, type check and nearby tests on this commit before you approve" onClick={onClick}><Icon name="check" size={12} />{run?.status === 'running' ? 'Verifying…' : run ? 'Verify again' : 'Verify'}</button>;
}
export const isOpenSuggestion = (s: SuggestionData) => OPEN.includes(s.state);
export function SuggestionState({ s }: { s: SuggestionData }) {
  return (
    <>
      <span className={`dp-chip ${STATE_CHIP[s.state] ?? ''}`}>{s.state}</span>
      {s.appliedCommit && <span>→ <code>{s.appliedCommit.slice(0, 7)}</code></span>}
      {STATE_NOTE[s.state] && <span>{STATE_NOTE[s.state]}</span>}
    </>
  );
}
// checks, then Verify / Approve / Dismiss while the suggestion is open
export function SuggestionActions({ s, onDecide, busy, pending, verify, onVerify }: SuggestionActionsProps) {
  const red = s.checks?.state === 'failed';
  return (
    <>
      {s.checks && <Checks run={s.checks} />}
      {verify && <VerifyChips run={verify} />}
      {s.error && <div className="dp-thr-err">{s.error}</div>}
      {isOpenSuggestion(s) && (
        <div className="dp-thr-sugg-f">
          {s.kind === 'commit' && <VerifyButton run={verify} busy={busy} pending={pending === 'verify'} onClick={onVerify} />}
          {s.state === 'conflict' && <button type="button" className={`dp-btn dp-sm${pendingClass(pending === 'rebase')}`} disabled={busy} title="Send the commit back to its agent to rebase on the PR branch" onClick={() => onDecide('rebase')}><Icon name="bot" size={12} />Ask agent</button>}
          <button type="button" className={`dp-btn dp-sm dp-primary${pendingClass(pending === 'approve')}`} disabled={busy} title={red ? "coco's checks fail on this commit" : undefined} onClick={async () => (!red || (await confirmDialog({ title: "coco's checks fail on this commit. Approve anyway?", ok: 'Approve anyway', danger: true }))) && onDecide('approve')}><Icon name={s.state === 'conflict' ? 'refresh' : 'check'} size={12} />{s.state === 'conflict' ? 'Retry' : red ? 'Approve anyway' : 'Approve'}{s.kind === 'commit' && VERIFIED_TAG[verify?.status ?? ''] || ''}</button>
          <button type="button" className={`dp-btn dp-sm${pendingClass(pending === 'dismiss')}`} disabled={busy} onClick={() => onDecide('dismiss')}><Icon name="x" size={12} />Dismiss</button>
        </div>
      )}
    </>
  );
}
// a commit is read in its own tab (onReview), where line comments go back to this thread's agent; a card change shows its fields here
function Suggestion({ onReview, ...props }: SuggestionActionsProps & { onReview: () => void }) {
  const { s } = props;
  return (
    <div className="dp-thr-sugg">
      <div className="dp-thr-sugg-h">
        <SuggestionState s={s} />
        {s.kind === 'commit' ? <code>{s.commit.slice(0, 7)}</code> : <span>card change</span>}
        {s.kind === 'commit' && s.checks?.state === 'running' && <span>commit seen · checks running</span>}
        {s.kind === 'commit' && <span className="dp-ell" title={s.files.join('\n')}>{s.files.map((f) => f.split('/').pop()).join(', ')}</span>}
        {s.kind === 'commit' && <><span className="dp-sp" /><button type="button" className="dp-btn dp-sm" title="Read the commit's diff in a tab and comment its lines for the agent" onClick={onReview}><Icon name="eye" size={12} />Review commit</button></>}
      </div>
      {s.kind === 'card' && (
        <details open={isOpenSuggestion(s)}>
          <summary>Fields</summary>
          <Markdown text={`\`\`\`json\n${JSON.stringify(s.fields, null, 1)}\n\`\`\``} />
        </details>
      )}
      <SuggestionActions {...props} />
    </div>
  );
}

// the commits waiting on your Approve, kept by the composer however far up (or in a hidden turn) their message is
function PendingCommits({ threadKey: key, messages }: { threadKey: string; messages: ThreadMessage[] }) {
  const open = messages.filter((m) => m.suggestion?.kind === 'commit' && isOpenSuggestion(m.suggestion));
  if (!open.length) return null;
  return (
    <div className="dp-thr-pend">
      {open.map((m) => (
        <button key={m.id} type="button" className={`dp-chip ${STATE_CHIP[m.suggestion!.state]}`} title="Read the suggested commit's diff in a tab, then Approve or Dismiss it" onClick={() => openCommitTab(key, m.id)}>
          <Icon name="eye" size={12} />suggested commit <code>{m.suggestion!.commit.slice(0, 7)}</code> · {m.suggestion!.state}
        </button>
      ))}
    </div>
  );
}

const nonceOf = () => Math.random().toString(36).slice(2, 12);

// messages posted and not confirmed yet, by thread: a first message can leave before its thread is mounted (a new comment's Start agent)
type Sent = { nonce: string; text: string; files: UploadRef[] };
const NONE: Sent[] = [];
const usePosting = create<Record<string, Sent[]>>(() => ({}));
export function postToThread(slug: string, key: string, { text, model, thinking, files = [] }: { text: string; model?: string; thinking?: string; files?: UploadRef[] }) {
  const nonce = nonceOf();
  usePosting.setState((s) => ({ [key]: [...(s[key] ?? NONE), { nonce, text, files }] }));
  return api.postThread(slug, key, { text, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(files.length ? { attachments: files.map((f) => f.id) } : {}) })
    .finally(() => {
      usePosting.setState((s) => ({ [key]: (s[key] ?? NONE).filter((x) => x.nonce !== nonce) }));
      refreshThreads(slug);
    });
}
// a message that did not leave (the server away included) goes back into the thread's box, and says so
export function notSent(slug: string, key: string, text: string, files: UploadRef[], e: unknown) {
  refillDraft(`thread:${slug}:${key}`, text, files);
  toast.error(`Not sent, the message is back in its box: ${errorMessage(e)}`, { always: true });
}
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

// the agent's reply to message i, before the next message of yours
function replyOf(messages: ThreadMessage[], i: number) {
  for (const m of messages.slice(i + 1)) {
    if (m.role === 'user') return undefined;
    if (m.role === 'agent') return m;
  }
}

const lineOf = (text?: string) => (text || '').replace(/[#*`>_|]/g, '').split('\n').map((l) => l.trim()).find(Boolean) || '';
const blocksLine = (blocks?: Block[]) => lineOf(blocks?.map((b) => ('text' in b ? b.text : 'caption' in b ? b.caption : '')).find(Boolean));

// your turns already read, one line each (from your message to the next one): none waits on you, its agent or your Approve
type ReadTurn = { end: number; reply: string; commit?: SuggestionData };
function readTurns(messages: ThreadMessage[], asks: number[], waitingMsg: string | undefined, seenAt: string | null) {
  const out = new Map<number, ReadTurn>();
  asks.slice(0, -1).forEach((start, k) => {
    const turn = messages.slice(start, asks[k + 1]);
    if (turn.some((m) => m.id === waitingMsg || (m.suggestion && isOpenSuggestion(m.suggestion)) || (seenAt && (m.ts ?? '') > seenAt))) return;
    const reply = turn.find((m) => m.role === 'agent');
    out.set(start, { end: asks[k + 1], reply: reply ? lineOf(reply.text) || blocksLine(reply.blocks) : '', commit: turn.findLast((m) => m.suggestion?.kind === 'commit')?.suggestion });
  });
  return out;
}

function TurnLine({ you, turn, open, onClick }: { you: string; turn: ReadTurn; open: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`dp-thr-turn${open ? ' dp-open' : ''}`} aria-expanded={open} title={open ? 'Fold this turn back to one line' : 'Show this turn'} onClick={onClick}>
      <Icon name="chevron-right" size={12} className="dp-cv-caret" />
      <span className="dp-thr-turn-you dp-ell">{you}</span>
      {turn.reply && <span className="dp-ell">→ {turn.reply}</span>}
      {turn.commit && <span className={`dp-chip ${STATE_CHIP[turn.commit.state] ?? ''}`}><code>{turn.commit.commit.slice(0, 7)}</code>{turn.commit.state}</span>}
    </button>
  );
}

// what came in since you last read the thread: replies, commits, questions
function NewSince({ messages, cards, seenAt }: { messages: ThreadMessage[]; cards: Card[]; seenAt: string }) {
  const replies = messages.filter((m) => m.role === 'agent').length;
  const commits = messages.flatMap((m) => (m.suggestion?.kind === 'commit' ? [m.suggestion.commit.slice(0, 7)] : []));
  const asks = cards.filter((c) => c.status === 'open' && c.kind !== 'post' && c.createdAt > seenAt).length;
  const parts = [replies && `${replies} repl${replies > 1 ? 'ies' : 'y'}`, commits.length && `commit ${commits.join(', ')}`, asks && `${asks} question${asks > 1 ? 's' : ''} for you`].filter(Boolean);
  return <div className="dp-thr-new" role="separator"><span>New since you last looked{parts.length ? ` · ${parts.join(' · ')}` : ''}</span></div>;
}

// the thread's agent activity over SSE (stored, then live), and a fresh thread on every change the server reports
type Live = { starting?: ThreadStep | null; inbound?: ThreadInbound[] };
function useThreadStream(slug: string, key: string, onChange: () => void, onLive: (live: Live) => void) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const changed = useRef(onChange);
  changed.current = onChange;
  const lived = useRef(onLive);
  lived.current = onLive;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(topic('thread', slug, key), {
      open: () => setEvents([]),
      message: (ev: ActivityEvent & { step?: ThreadStep | null; inbound?: ThreadInbound[] }) => {
        if (ev.type === 'step') return lived.current({ starting: ev.step ?? null });
        if (ev.type === 'inbound') return lived.current({ inbound: ev.inbound ?? [] });
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
// bare: inside its group agent's tab, whose header carries the group's actions; the thread keeps only what a message waits on
// discuss: a finding not accepted yet, its agent answers without changing code
type ThreadProps = { slug: string; threadKey: string; onSettled?: () => void; verdicts?: Verdict[]; autoFocus?: boolean; bare?: boolean; discuss?: boolean };
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

// what a message waits on before its agent exists, step by step: the done ones ticked with their time, the current one live
function StartSteps({ step, now }: { step: ThreadStep; now: number }) {
  const steps = step.steps?.length ? step.steps : [step];
  const secs = (from: string, to: number) => Math.max(0, Math.round((to - Date.parse(from)) / 1000));
  return (
    <ol className="dp-thr-steps" aria-label="Starting the agent">
      {steps.map((s, i) => {
        const next = steps[i + 1];
        return (
          <li key={`${s.at}-${i}`} className={next ? '' : 'dp-on'}>
            {next ? <Icon name="check" size={12} /> : <span className="dp-ag-dot dp-ag-running dp-thr-spin" aria-hidden />}
            <span className="dp-ell">{s.text}</span>
            <span className="dp-num">{secs(s.at, next ? Date.parse(next.at) : now)} s</span>
          </li>
        );
      })}
    </ol>
  );
}

// what was posted and is not stored yet: the server's list (other tabs and a reload included), then this tab's posts it has not heard of yet
function inboundOf(server: ThreadInbound[], local: Sent[]) {
  const left = [...server];
  const mine = local.filter((p) => {
    const i = left.findIndex((s) => s.text === p.text);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
  return [...server.map((s) => ({ key: s.id, text: s.text, files: s.files ?? [] })), ...mine.map((p) => ({ key: p.nonce, text: p.text, files: p.files }))];
}

// threads asked into view (a finding picked in the inspector), by key: once shown, the question waiting on you, else your last message
const useFocusAsked = create<Record<string, number>>(() => ({}));
export const focusThread = (key: string) => useFocusAsked.setState({ [key]: Date.now() });
// an ask goes stale if its thread does not show by then
const FOCUS_MS = 10000;
const PIN_MS = 1500;
const USER_INPUTS = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
const scrollerOf = (el: HTMLElement) => {
  for (let p = el.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p;
  return null;
};
// held there while the diff and the thread lay out around it, until you scroll, click or type
function pinInView(el: HTMLElement, center: boolean) {
  const box = scrollerOf(el);
  if (!box) return () => {};
  const until = Date.now() + PIN_MS;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    USER_INPUTS.forEach((t) => box.removeEventListener(t, stop));
  };
  const pin = () => {
    if (Date.now() > until) return stop();
    const gap = center && el.offsetHeight < box.clientHeight ? (box.clientHeight - el.offsetHeight) / 2 : 16;
    const top = Math.max(0, box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - gap);
    if (Math.abs(box.scrollTop - top) > 1) box.scrollTop = top;
    frame = requestAnimationFrame(pin);
  };
  USER_INPUTS.forEach((t) => box.addEventListener(t, stop, { passive: true }));
  pin();
  return stop;
}

export default function Thread({ slug, threadKey: key, onSettled, verdicts = [], autoFocus = false, bare = false, discuss = false }: ThreadProps) {
  const { groups, summaries } = useThreadsOf(slug);
  const seen = useSeen(`thread:${slug}:${key}`);
  const root = useRef<HTMLDivElement | null>(null);
  const rootRef = useCallback((el: HTMLDivElement | null) => {
    root.current = el;
    seen(el);
  }, [seen]);
  const [thread, setThread] = useState<ThreadData | null>(null);
  const focusAsked = useFocusAsked((s) => s[key]);
  const unpin = useRef<() => void>(undefined);
  useEffect(() => () => unpin.current?.(), []);
  useEffect(() => {
    const el = root.current;
    if (!focusAsked || Date.now() - focusAsked > FOCUS_MS || !thread || !el) return;
    useFocusAsked.setState({ [key]: 0 });
    const card = el.querySelector<HTMLElement>('.dp-cd.dp-attn');
    const mine = [...el.querySelectorAll<HTMLElement>('.dp-msg-u')].at(-1);
    const target = card ?? mine ?? el;
    unpin.current?.();
    unpin.current = pinInView(target, target === card);
  }, [focusAsked, Boolean(thread)]);
  const [error, setError] = useState('');
  // which action is in flight: 'approve', 'dismiss', 'regroup', 'prune', 'rules' or a verdict label
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;
  const sending = usePosting((s) => s[key] ?? NONE);
  const [note, setNote] = useState('');
  const [turns, setTurns] = useState(SHOWN_TURNS);
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  // the newest message you had read when the thread opened; what came after stays unfolded under a "new" line
  const seenKey = `cc.thr.seen:${slug}:${key}`;
  const [seenAt] = useState(() => { try { return localStorage.getItem(seenKey); } catch { return null; } });
  const lastTs = thread?.messages.at(-1)?.ts;
  useEffect(() => { if (lastTs) try { localStorage.setItem(seenKey, lastTs); } catch {} }, [seenKey, lastTs]);
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
  const activity = useThreadStream(slug, key, reload, (live) => setThread((prev) => prev && { ...prev, ...live }));
  const now = useNow(1000, Boolean(thread?.starting || thread?.waiting?.deps));
  const secs = (since: string) => Math.max(0, Math.round((now - Date.parse(since)) / 1000));
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
  // shown at once, confirmed by the server (a start can take a while); while the agent works the message steers its turn
  const send = (text: string, model?: string, files: UploadRef[] = [], thinking?: string) => {
    postToThread(slug, key, { text, model, thinking, files })
      .then((next) => {
        wasWaiting.current = Boolean(next.waiting);
        setThread((prev) => keep(prev, next));
        settled.current?.();
      }, (e) => notSent(slug, key, text, files, e));
    return true;
  };

  if (!thread) return <div ref={rootRef} className={`dp-thr ${error ? 'dp-thr-err' : 'dp-thr-load'}`}>{error || 'Loading thread…'}</div>;
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
  const posted = inboundOf(thread.inbound ?? [], sending);
  // no live agent yet: the first message starts one, the others wait for it
  const booting = posted.length > 0 && !thread.agent?.live && (Boolean(thread.starting) || !group);
  const from = asks.length > turns ? asks[asks.length - turns] : 0;
  const read = readTurns(thread.messages, asks, thread.waiting?.msgId, seenAt);
  const folded = new Set<number>();
  for (const [start, t] of read) if (!unfolded.has(thread.messages[start].id)) for (let j = start; j < t.end; j++) folded.add(j);
  const fresh = seenAt ? thread.messages.findIndex((m) => (m.ts ?? '') > seenAt) : -1;
  const openCardsAt = (i: number) => slots.get(i)?.some((c) => c.status === 'open') && cardsAt(i);
  const youOf = (m: ThreadMessage) => {
    const answered = m.card ? CARD_MSG.exec(m.text ?? '') : null;
    return answered ? `${answered[2] === 'answered' ? 'Answered' : `Card ${answered[2]}`}: ${titles.get(answered[1]) ?? 'a question'}` : lineOf(m.text) || blocksLine(m.blocks) || 'Files';
  };
  const unfold = (id: string) => setUnfolded((s) => {
    const next = new Set(s);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  return (
    <div ref={rootRef} className="dp-thr">
      {(!bare || thread.starting || thread.waiting?.deps || thread.agent?.deps === 'installing') && <div className="dp-thr-h">
        {(!bare || thread.starting) && <span className="dp-ell">{thread.starting ? `${thread.starting.text}… ${secs(thread.starting.at)} s` : group ? `Group ${groupLabel(group)}` : posted.length ? 'Starting an agent…' : thread.newGroup ? 'A new agent group on the next message' : decision || plan ? 'No agent yet: the first message starts one' : 'No group yet: joins the one on the same file, or starts one'}</span>}
        {group?.status === 'active' && thread.agent && (!bare || thread.waiting?.deps) && (
          <span className={`dp-chip${thread.agent.live ? ' dp-ok' : ''}`} title={thread.agent.live ? 'The agent keeps this thread in context: the next message is sent as a new turn' : 'The agent is gone: the next message starts a new one with the whole thread'}>
            <span className="dp-d" />{thread.waiting?.deps ? `waiting for deps (${secs(thread.waiting.deps.since)} s)` : thread.agent.live ? `agent live${thread.agent.status === 'running' ? ' · working' : ''}` : 'agent gone'}
          </span>
        )}
        {thread.agent?.live && thread.agent.deps === 'installing' && <span className="dp-chip dp-warn" title="coco installs this worktree's dependencies: the agent reads and changes the code meanwhile and hears when its checks work">installing deps</span>}
        {!bare && <span className="dp-thr-hx">
        {!waiting && (group || others.length > 0) && (
          <select className="dp-inp" value="" disabled={busy} aria-label="Regroup" onChange={(e) => act('regroup', () => api.regroup(slug, key, e.target.value))}>
            <option value="" disabled>Regroup…</option>
            {others.map((g) => <option key={g.id} value={g.id}>{groupLabel(g)}</option>)}
            <option value="new">A new group</option>
          </select>
        )}
        {thread.messages.length > 1 && <button type="button" className={`dp-btn dp-sm dp-ghost${pendingClass(pending === 'rules')}`} disabled={busy} title="coco distills the corrections of this thread into proposed work rules" onClick={() => act('rules', async () => { await api.proposeRules(slug, { scope: 'work', threadKey: key }); setNote('coco is proposing rules: keep or drop them in the Rules tab'); return thread; })}><Icon name="book" size={12} />Rules</button>}
        {!waiting && group?.status === 'active' && <button type="button" className={`dp-btn dp-sm dp-ghost${pendingClass(pending === 'prune')}`} disabled={busy} title="Archive the group's agent and worktree, delete its branch" onClick={async () => (await confirmDialog({ title: `Prune the agent of group ${group.id}?`, body: `${group.items.length} item(s): archive its agent and worktree, delete its branch.`, ok: 'Prune', danger: true })) && act('prune', async () => { await api.closeGroup(slug, group.id); return api.thread(slug, key); })}><Icon name="archive" size={12} />Prune agent</button>}
        </span>}
      </div>}
      {group?.unlinked?.map((u) => (
        <div key={u.commit} className="dp-thr-sys dp-thr-ready">
          commit <code>{u.commit.slice(0, 7)}</code> not linked to a comment · {u.subject}
          <select className="dp-inp" value="" disabled={busy} aria-label="Link the commit to an item" title="Make it the suggestion of one of this agent's items, or drop it" onChange={(e) => act('link', async () => { await api.linkCommit(slug, group.id, u.commit, e.target.value === 'drop' ? null : e.target.value); return api.thread(slug, key); })}>
            <option value="" disabled>Link to…</option>
            {group.items.map(String).map((k) => <option key={k} value={k}>{k === key ? 'this comment' : summaries[k]?.label ?? k}</option>)}
            <option value="drop">Drop it</option>
          </select>
        </div>
      ))}
      {thread.ready && (
        <div className="dp-thr-sys dp-thr-ready">
          commit <code>{thread.ready.commit.slice(0, 7)}</code> ready{thread.ready.approve ? <>: <button type="button" className="dp-btn dp-sm dp-ghost" onClick={() => { const el = document.getElementById(`thr-${thread.ready?.approve}`); if (el) pinInView(el, true); }}>Approve</button></> : ', no Approve offered yet'} · {thread.ready.subject}{thread.ready.stat && <span className="dp-thr-stat"> · {thread.ready.stat}</span>}
          <VerifyButton run={verifyRun} busy={busy} pending={pending === 'verify'} onClick={() => verify(thread.ready!.commit)} />
          {verifyRun && !thread.ready.approve && <VerifyChips run={verifyRun} />}
        </div>
      )}
      {from > 0 && <EarlierTurns hidden={from} onMore={() => setTurns((t) => t + MORE_TURNS)} />}
      {thread.messages.map((m, i) => {
        if (i < from) return slots.get(i)?.some((c) => c.status === 'open') ? <React.Fragment key={m.id}>{cardsAt(i)}</React.Fragment> : null;
        const turn = read.get(i);
        const line = turn && <TurnLine you={youOf(m)} turn={turn} open={!folded.has(i)} onClick={() => unfold(m.id)} />;
        if (folded.has(i)) return <React.Fragment key={m.id}>{openCardsAt(i)}{line}</React.Fragment>;
        const answered = m.card && m.role === 'user' ? CARD_MSG.exec(m.text ?? '') : null;
        return (
          <React.Fragment key={m.id}>
            {i === fresh && i > 0 && seenAt &&<NewSince messages={thread.messages.slice(i)} cards={cards} seenAt={seenAt} />}
            {cardsAt(i)}
            {line}
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
                  {m.suggestion && <Suggestion s={m.suggestion} onReview={() => openCommitTab(key, m.id)}verify={thread.verifies?.[m.suggestion.commit]} onVerify={() => verify(m.suggestion!.commit)} busy={busy} pending={pending?.startsWith(`${m.id}:`) ? pending.split(':')[1] : null} onDecide={(action) => act(`${m.id}:${action}`, () => api.suggestion(slug, key, m.id, action))} />}
                </div>
              </div>
            )}
            {(byMsg[m.id] || m.id === thread.waiting?.msgId) && <div className="dp-thr-acts"><Activity events={byMsg[m.id] || []} active={m.id === thread.waiting?.msgId} fold={{ from: m.ts, to: replyOf(thread.messages, i)?.ts }} /></div>}
          </React.Fragment>
        );
      })}
      {cardsAt(thread.messages.length)}
      {thread.starting && <StartSteps step={thread.starting} now={now} />}
      {posted.map((p, i) => (
        <div key={p.key} className={`dp-msg-u dp-cv-u dp-cv-sending${booting && i > 0 ? ' dp-cv-queued' : ''}`}>
          <div className="dp-cv-unote">{!booting ? 'sending…' : i === 0 ? 'sending · starts the agent' : 'queued · reaches the agent once it is ready'}</div>
          {p.files.length > 0 && <SentFiles files={p.files} />}
          <Markdown text={p.text} />
        </div>
      ))}
      <PendingCommits threadKey={key} messages={thread.messages} />
      <ThreadComposer
        draft={`thread:${slug}:${key}`}
        busy={false}
        pending={pending}
        withModel={!group}
        sendLabel={!group ? (discuss ? 'Ask agent' : 'Start agent') : waiting ? 'Send while it works' : 'Send'}
        verdicts={verdicts}
        autoFocus={autoFocus}
        persona={thread.persona}
        placeholder={waiting ? 'Write while it works: the message reaches the agent mid-turn (markdown, ↵)' : discuss ? 'Ask the agent about it: it changes no code until you accept, or accept or dismiss with this text as note (markdown, ↵)' : thread.messages.length ? 'Reply or ask for a change (markdown, ↵)' : plan ? 'Ask a scoped agent about the plan, or re-plan with this text as guidance (markdown, ↵)' : decision ? 'Ask about the card or for a card change (markdown, ↵)' : 'Ask the agent about it or for a fix (it suggests a commit you approve), or close it with this text as reason (markdown, ↵)'}
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
  onCancel?: () => void;
  draft?: string;
};
export function ThreadComposer({ busy, pending, withModel, sendLabel = 'Start agent', verdicts = [], placeholder = '', onSend, onStop, autoFocus = false, persona, onCancel, draft }: ComposerProps) {
  const model = useModelChoice('thread', { fast: true });
  return (
    <Composer
      className="dp-tcomp"
      draft={draft}
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
      onCancel={onCancel}
    />
  );
}
