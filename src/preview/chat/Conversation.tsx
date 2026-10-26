import React from 'react';
import Markdown from '../../components/Markdown.tsx';
import Icon from '../Icon.tsx';
import Activity from './Activity.tsx';
import type { Pending, Run } from './conversation.ts';
import type { ActivityEvent } from '../../types.ts';
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

function UserMessage({ e, sending }: { e: { text?: string; steer?: boolean }; sending?: boolean }) {
  const text = e.text ?? '';
  const [first, ...rest] = text.split('\n');
  const note = [e.steer && 'while it worked', sending && 'sending…'].filter(Boolean).join(' · ');
  return (
    <div className={`dp-msg-u dp-cv-u${sending ? ' dp-cv-sending' : ''}`}>
      {note && <div className="dp-cv-unote">{note}</div>}
      {rest.length && text.length > 400 ? <details className="dp-cv-long"><summary>{first}</summary><Markdown text={rest.join('\n')} /></details> : <Markdown text={text} />}
    </div>
  );
}

type Turn = { user?: ActivityEvent; agent?: ActivityEvent[] };

// a run's events as a chat: each message of the owner, then what the agent did and said until the next one
export default function Conversation({ run, events, pending = [], working, who = 'coco' }: { run: Run; events: ActivityEvent[]; pending?: Pending[]; working: boolean; who?: string }) {
  const all: ActivityEvent[] = events[0]?.type === 'user' || !run.prompt ? events : [{ type: 'user', text: run.prompt }, ...events];
  const turns: Turn[] = [];
  // a message sent mid-stream: the text still streaming carries over to the agent's side after it
  let carry: ActivityEvent[] = [];
  for (const e of all) {
    if (e.type === 'user') {
      const agent = turns.at(-1)?.agent;
      while (agent && LIVE.includes(agent.at(-1)?.type ?? '')) {
        const streaming = agent.pop();
        if (streaming) carry.unshift(streaming);
      }
      turns.push({ user: e });
    } else {
      if (!turns.length || turns.at(-1)?.user) turns.push({ agent: carry });
      carry = [];
      turns.at(-1)?.agent?.push(e);
    }
  }
  if (working && (!turns.length || turns.at(-1)?.user)) turns.push({ agent: carry });
  return (
    <div className="dp-chat-in dp-cv">
      {turns.map((t, i) => (t.user ? <UserMessage key={i} e={t.user} /> : <AgentTurn key={i} events={t.agent ?? []} active={working && i === turns.length - 1} who={who} />))}
      {pending.map((p) => <UserMessage key={p.nonce} e={p} sending />)}
    </div>
  );
}
