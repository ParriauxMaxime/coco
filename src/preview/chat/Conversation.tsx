import React, { useRef } from 'react';
import Markdown from '../../components/Markdown.tsx';
import Icon from '../Icon.tsx';
import Activity from './Activity.tsx';
import CardView from './Card.tsx';
import type { Pending, Run } from './conversation.ts';
import type { ActivityEvent, Card, UploadRef } from '../../types.ts';
import { SentFiles } from './Attachments.tsx';
import './chat.css';

const LIVE = ['delta', 'think_delta'];

function AgentTurn({ events, active, who }: { events: ActivityEvent[]; active: boolean; who: string }) {
  return (
    <div className="dp-msg-a">
      {who === 'coco' ? <span className="dp-cocoav">c</span> : <span className="dp-bot dp-cv-av"><Icon name="bot" size={12} /></span>}
      <div className="dp-cv-body">
        <div className="dp-who">{who}</div>
        <Activity events={events} active={active} />
      </div>
    </div>
  );
}

function UserMessage({ e, sending }: { e: { text?: string; steer?: boolean; attachments?: UploadRef[] }; sending?: boolean }) {
  const text = e.text ?? '';
  const [first, ...rest] = text.split('\n');
  const note = [e.steer && 'while it worked', sending && 'sending…'].filter(Boolean).join(' · ');
  return (
    <div className={`dp-msg-u dp-cv-u${sending ? ' dp-cv-sending' : ''}`}>
      {note && <div className="dp-cv-unote">{note}</div>}
      {e.attachments?.length ? <SentFiles files={e.attachments} /> : null}
      {rest.length && text.length > 400 ? <details className="dp-cv-long"><summary>{first}</summary><Markdown text={rest.join('\n')} /></details> : <Markdown text={text} />}
    </div>
  );
}

const CARD_MSG = /^\[coco card (\S+) (\w+)\]/;

function CardMessage({ verb, title }: { verb: string; title?: string }) {
  return <div className="dp-cd-sent"><Icon name="send" size={12} />{verb === 'answered' ? 'Answer sent' : `Card ${verb}`}{title ? `: ${title}` : ''}</div>;
}

type Turn = { key: string; user?: ActivityEvent; agent?: ActivityEvent[]; card?: Card };

// where a card sits: after the tool call that posted it, else before the message that delivered its answer, else where it was first seen live
function useAnchors(all: ActivityEvent[], cards: Card[]) {
  const born = useRef(Date.now());
  const seen = useRef(new Map<string, number>());
  const at = new Map<number, Card[]>();
  const tail: Card[] = [];
  for (const c of cards) {
    let i = all.findIndex((e) => e.type === 'tool' && e.output?.includes(c.id));
    const call = all[i]?.id;
    if (i >= 0 && call) i = all.findLastIndex((e) => e.type === 'tool' && e.id === call);
    if (i < 0) i = all.findIndex((e) => e.type === 'user' && e.text?.startsWith(`[coco card ${c.id} `)) - 1;
    if (i < -1 && Date.parse(c.createdAt) >= born.current) {
      if (!seen.current.has(c.id)) seen.current.set(c.id, all.length - 1);
      i = seen.current.get(c.id) ?? -2;
    }
    if (i < -1) tail.push(c);
    else at.set(i, [...(at.get(i) ?? []), c]);
  }
  return { at, tail };
}

type Props = { run: Run; events: ActivityEvent[]; pending?: Pending[]; working: boolean; who?: string; cards?: Card[]; onCard?: (c: Card) => void };

// a run's events as a chat: each message of the owner, then what the agent did and said until the next one, its cards in between
export default function Conversation({ run, events, pending = [], working, who = 'coco', cards = [], onCard }: Props) {
  const all: ActivityEvent[] = events[0]?.type === 'user' || !run.prompt ? events : [{ type: 'user', text: run.prompt }, ...events];
  const { at, tail } = useAnchors(all, cards);
  const titles = new Map(cards.map((c) => [c.id, c.title]));
  const newest = cards.findLast((c) => c.status === 'open' && c.kind !== 'post')?.id;
  const turns: Turn[] = (at.get(-1) ?? []).map((c) => ({ key: c.id, card: c }));
  // a message sent mid-stream: the text still streaming carries over to the agent's side after it
  let carry: ActivityEvent[] = [];
  all.forEach((e, i) => {
    if (e.type === 'user') {
      const agent = turns.at(-1)?.agent;
      while (agent && LIVE.includes(agent.at(-1)?.type ?? '')) {
        const streaming = agent.pop();
        if (streaming) carry.unshift(streaming);
      }
      turns.push({ key: `u${i}`, user: e });
    } else {
      if (!turns.at(-1)?.agent) turns.push({ key: `a${i}`, agent: carry });
      carry = [];
      turns.at(-1)?.agent?.push(e);
    }
    for (const c of at.get(i) ?? []) turns.push({ key: c.id, card: c });
  });
  for (const c of tail) turns.push({ key: c.id, card: c });
  if (working && !turns.at(-1)?.agent) turns.push({ key: 'working', agent: carry });
  return (
    <div className="dp-chat-in dp-cv">
      {turns.map((t, i) => {
        if (t.card) return <div key={t.key} className="dp-msg-a dp-cd-row"><span /><CardView card={t.card} onCard={onCard} focus={t.card.id === newest} /></div>;
        if (t.user) {
          const m = CARD_MSG.exec(t.user.text ?? '');
          return m ? <CardMessage key={t.key} verb={m[2]} title={titles.get(m[1])} /> : <UserMessage key={t.key} e={t.user} />;
        }
        return <AgentTurn key={t.key} events={t.agent ?? []} active={working && i === turns.length - 1} who={who} />;
      })}
      {pending.map((p) => <UserMessage key={p.nonce} e={p} sending />)}
    </div>
  );
}
