import React from 'react';
import Markdown from '../../components/Markdown.tsx';
import Icon from '../Icon.tsx';
import { CocoAvatar } from '../parts.tsx';
import Activity from './Activity.tsx';
import CardView from './Card.tsx';
import type { Pending, Run } from './conversation.ts';
import type { ActivityEvent, Card, UploadRef } from '../../types.ts';
import { SentFiles } from './Attachments.tsx';
import './chat.css';

const LIVE = ['delta', 'think_delta'];
// a run logs no times: a folded turn says what it did, not for how long
const FOLD = {};

type Part = ActivityEvent[] | Card;
type CardProps = { onCard?: (c: Card) => void; newest?: string };

function AgentTurn({ parts, active, who, onCard, newest, compact }: { parts: Part[]; active: boolean; who: string; compact?: boolean } & CardProps) {
  return (
    <div className="dp-msg-a">
      {who === 'coco' ? <CocoAvatar /> : <span className="dp-bot dp-cv-av"><Icon name="bot" size={12} /></span>}
      <div className="dp-cv-body">
        <div className="dp-who">{who}</div>
        {parts.map((p, i) => (Array.isArray(p) ? <Activity key={i} events={p} active={active && i === parts.length - 1} issues={who === 'coco'} compact={compact} fold={FOLD} /> : <CardView key={p.id} card={p} onCard={onCard} focus={p.id === newest} />))}
      </div>
    </div>
  );
}

// held: written while its agent was starting and that agent is not there yet
function UserMessage({ e, sending, held }: { e: { text?: string; steer?: boolean; queued?: boolean; attachments?: UploadRef[] }; sending?: boolean; held?: boolean }) {
  const text = e.text ?? '';
  const [first, ...rest] = text.split('\n');
  const note = [e.steer && 'while it worked', e.queued && (held ? 'queued · reaches the agent once it is ready' : 'queued while the agent started'), sending && 'sending…'].filter(Boolean).join(' · ');
  return (
    <div className={`dp-msg-u dp-cv-u${sending || held ? ' dp-cv-sending' : ''}`}>
      {note && <div className="dp-cv-unote">{note}</div>}
      {e.attachments?.length ? <SentFiles files={e.attachments} /> : null}
      {rest.length && text.length > 400 ? <details className="dp-cv-long"><summary>{first}</summary><Markdown text={rest.join('\n')} /></details> : <Markdown text={text} />}
    </div>
  );
}

export const CARD_MSG = /^\[coco card (\S+) (\w+)\]/;
// the note coco logs once a conversation's new agent exists
const STARTED = /^Paseo agent \S+ in workspace /;

export function CardMessage({ verb, title }: { verb: string; title?: string }) {
  return <div className="dp-cd-sent"><Icon name="send" size={12} />{verb === 'answered' ? 'Answer sent' : `Card ${verb}`}{title ? `: ${title}` : ''}</div>;
}

type Turn = { key: string; user?: ActivityEvent; parts?: Part[] };

// where a card sits: after the tool call that posted it, else before the message that delivered its answer, else at the end
function anchors(all: ActivityEvent[], cards: Card[]) {
  const at = new Map<number, Card[]>();
  const tail: Card[] = [];
  const calls = new Set<string>();
  for (const c of cards) {
    let i = all.findIndex((e) => e.type === 'tool' && e.output?.includes(c.id));
    const call = all[i]?.id;
    if (i >= 0 && call) {
      i = all.findLastIndex((e) => e.type === 'tool' && e.id === call);
      calls.add(call);
    }
    if (i < 0) i = all.findIndex((e) => e.type === 'user' && e.text?.startsWith(`[coco card ${c.id} `)) - 1;
    if (i < -1) tail.push(c);
    else at.set(i, [...(at.get(i) ?? []), c]);
  }
  return { at, tail, calls };
}

type Props = { run: Run; events: ActivityEvent[]; pending?: Pending[]; working: boolean; who?: string; cards?: Card[]; onCard?: (c: Card) => void };

// a run's events as a chat: each message of the owner, then what the agent did and said until the next one, its cards in between
export default function Conversation({ run, events, pending = [], working, who = 'coco', cards = [], onCard }: Props) {
  const all: ActivityEvent[] = events[0]?.type === 'user' || !run.prompt ? events : [{ type: 'user', text: run.prompt }, ...events];
  const { at, tail, calls } = anchors(all, cards);
  // the last agent start the log records: a message queued after it still waits for that agent
  const started = all.findLastIndex((e) => e.type === 'meta' && STARTED.test(e.text ?? ''));
  const stepped = all.findLastIndex((e) => e.type === 'step');
  const booting = stepped > started && !all.slice(stepped).some((e) => e.type === 'end' || e.type === 'stderr');
  const titles = new Map(cards.map((c) => [c.id, c.title]));
  const newest = cards.findLast((c) => c.status === 'open' && c.kind !== 'post')?.id;
  const turns: Turn[] = [];
  const agentTurn = (key: string, first: ActivityEvent[] = []) => {
    const last = turns.at(-1);
    if (last?.parts) return last.parts;
    const parts: Part[] = [first];
    turns.push({ key, parts });
    return parts;
  };
  const addCards = (list: Card[] | undefined, key: string) => list?.length && agentTurn(key).push(...list);
  addCards(at.get(-1), 'a-start');
  // a message sent mid-stream: the text still streaming carries over to the agent's side after it
  let carry: ActivityEvent[] = [];
  all.forEach((e, i) => {
    if (e.type === 'user') {
      const tail = turns.at(-1)?.parts?.at(-1);
      while (Array.isArray(tail) && LIVE.includes(tail.at(-1)?.type ?? '')) {
        const streaming = tail.pop();
        if (streaming) carry.unshift(streaming);
      }
      turns.push({ key: `u${i}`, user: e });
    } else if (!(e.type === 'tool' && e.id && calls.has(e.id))) {
      const parts = agentTurn(`a${i}`, carry);
      const last = parts.at(-1);
      if (Array.isArray(last)) last.push(e);
      else parts.push([...carry, e]);
      carry = [];
    }
    addCards(at.get(i), `a${i}`);
  });
  addCards(tail, 'a-end');
  const end = turns.at(-1)?.parts;
  if (working && !end) turns.push({ key: 'working', parts: [carry] });
  else if (working && end && !Array.isArray(end.at(-1))) end.push([]);
  return (
    <div className="dp-chat-in dp-cv">
      {turns.map((t, i) => {
        if (t.user) {
          const m = CARD_MSG.exec(t.user.text ?? '');
          return m ? <CardMessage key={t.key} verb={m[2]} title={titles.get(m[1])} /> : <UserMessage key={t.key} e={t.user} held={booting && t.user.queued} />;
        }
        return <AgentTurn key={t.key} parts={t.parts ?? []} active={working && i === turns.length - 1} who={who} onCard={onCard} newest={newest} compact={i !== turns.length - 1} />;
      })}
      {pending.map((p) => <UserMessage key={p.nonce} e={p} sending />)}
    </div>
  );
}
