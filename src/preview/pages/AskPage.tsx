import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { toast } from '../../components/Toast.tsx';
import Icon from '../Icon.tsx';
import { CocoAvatar } from '../parts.tsx';
import { CardsWaiting } from '../chat/Card.tsx';
import { Composer, Log } from '../chat/Composer.tsx';
import Conversation from '../chat/Conversation.tsx';
import { askState, useAskConversation } from '../chat/conversation.ts';
import { Empty, Loading, PageHead } from './Page.tsx';
import type { AskRun, UploadRef } from '../../types.ts';
import { useAskModel } from '../chat/ModelPicker.tsx';
import { SubagentBar } from '../Subagents.tsx';
import { useSeen } from '../waiting.ts';
import './ask-page.css';

const EXAMPLES = [
  'Which works across my repos are blocked, and on what?',
  'Which repo does a CSV export of invoices belong in, and is there a precedent work for it?',
  'Add the acme/widgets repo to coco.',
];
const toneOf = (s?: string | null) => { const st = askState(s); return [st.dot, st.short]; };
const firstLine = (s?: string) => (s || '').split('\n')[0];
const when = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
function ConvRow({ h, on, live }: { h: AskRun; on: boolean; live?: string | null }) {
  const [dot, label] = toneOf(on && live ? live : h.status);
  const kind = h.proposed?.kind;
  return (
    <a className={`dp-askp-conv${on ? ' dp-on' : ''}`} href={`#/ask/${h.id}`} title={h.prompt}>
      <span className={`dp-ag-dot ${dot}`} title={label} />
      <span className="dp-rowi-b">
        <span className="dp-ell">{h.title || firstLine(h.prompt)}</span>
        <span className="dp-askp-cm">
          {when(h.lastActivity || h.startedAt)}
          {(h.turns ?? 0) > 1 && <><span className="dp-t4">·</span>{h.turns} turns</>}
          {h.cost != null && <><span className="dp-t4">·</span>${Number(h.cost).toFixed(2)}</>}
          {kind && <span className="dp-chip dp-acc" title={`Proposes a ${kind}: ${h.proposed?.title}`}>{kind}</span>}
        </span>
      </span>
    </a>
  );
}

export default function AskPage({ convId }: { convId?: string }) {
  const convo = useAskConversation('ask', { kind: 'global' });
  const { run, events, pending, working, state, history: past, open, reset, send, cards, mergeCard } = convo;
  const seen = useSeen(convId ? `ask:${convId}` : null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (convId && run?.id !== convId) api.askConversation(convId).then(open, (e) => toast.error(errorMessage(e)));
  }, [convId]);
  useEffect(() => {
    if (!run?.id || convId) return;
    history.replaceState(null, '', `#/ask/${run.id}`);
    dispatchEvent(new HashChangeEvent('hashchange'));
  }, [run?.id]);

  const model = useAskModel(run);
  const start = (text: string, files: UploadRef[] = []) => send(text, (nonce) => api.ask({ prompt: text, nonce, attachments: files.map((f) => f.id), ...model.body() }), files);
  const fresh = () => {
    if (run && state === 'idle') api.closeAsk(run.id).catch(() => {});
    reset();
    if (location.hash !== '#/ask') location.hash = '#/ask';
  };
  const close = async () => {
    if (!run) return;
    setClosing(true);
    await api.closeAsk(run.id).catch((e) => toast.error(errorMessage(e)));
    setClosing(false);
  };
  const [dot, label] = toneOf(state);
  const ended = state === 'parked' || state === 'closed' || state === 'done';
  const list: AskRun[] = run && !past.some((h) => h.id === run.id) ? [{ ...run, prompt: run.prompt ?? '', startedAt: run.startedAt ?? '', status: state ?? 'running' }, ...past] : past;

  return (
    <div ref={seen} className="dp-page dp-askp" role="main">
      <PageHead
        icon="message-square"
        title="Ask coco"
        sub="The global coco, on its own folder with its MCP server (works, personas, Paseo, gh): questions across your repos, and new repos. A new work starts from its repo's page."
        actions={(run || convId) && <button type="button" className="dp-btn dp-primary" onClick={fresh}><Icon name="plus" size={14} />New conversation</button>}
      />
      <div className="dp-askp-body">
        <aside className="dp-askp-side">
          <h2 className="dp-h2 dp-askp-sh">Conversations<span className="dp-count">{list.length}</span></h2>
          <div className="dp-askp-list">
            {list.map((h) => <ConvRow key={h.id} h={h} on={h.id === (run?.id ?? convId)} live={state} />)}
            {!list.length && <Empty icon="message-square">No conversation yet.</Empty>}
          </div>
        </aside>
        <section className="dp-askp-chat">
          {run ? (
            <>
              <div className="dp-vbar dp-askp-bar">
                <span className={`dp-ag-dot ${dot}`} title={label} />
                <span className="dp-title dp-ell">{run.title || firstLine(run.prompt) || 'Ask coco'}</span>
                <span className="dp-chip">{label}</span>
                {run.agentId && <code className="dp-xs" title="coco's Paseo agent">{run.agentId.slice(0, 8)}</code>}
                <span className="dp-sp" />
                {(state === 'idle' || state === 'running') && <button type="button" className="dp-btn dp-sm" disabled={closing} title="Archive coco's agent; a new message starts a new one with the conversation so far" onClick={() => void close()}><Icon name="archive" size={12} />Close</button>}
              </div>
              <Log size={events.length + pending.length + cards.length}>
                <Conversation run={run} events={events} pending={pending} working={working} cards={cards} onCard={mergeCard} />
              </Log>
              <CardsWaiting cards={cards} />
              <SubagentBar agentId={run.agentId} inline />
              <Composer
                draft={`ask:${run.id}`}
                agentId={model.agentId}
                placeholder="Follow up, correct or narrow it down (↵, ⇧↵ new line)"
                note={ended ? 'Its agent is archived: a message starts a new one with the conversation so far' : working ? 'Sends while it works' : 'It reads and proposes; you apply. Nothing is pushed, posted or sent.'}
                tools={model.tools}
                onSend={(text, files) => send(text, undefined, files, model.body())}
                onStop={working && run.agentId ? () => api.agentStop(run.agentId ?? '') : undefined}
              />
            </>
          ) : convId ? (
            <div className="dp-agent-log"><Loading what="Opening the conversation…" /></div>
          ) : (
            <>
              <div className="dp-agent-log dp-ag-start">
                <div className="dp-ag-hello">
                  <CocoAvatar />
                  <div className="dp-ag-h">What should coco look into?</div>
                  <p className="dp-t3">Follow up as long as you like, even while it works. It reads and proposes; you apply. Nothing is pushed, posted or sent.</p>
                  <div className="dp-ag-ex">{EXAMPLES.map((e) => <button key={e} type="button" className="dp-btn dp-sm" onClick={() => void start(e)}>{e}</button>)}</div>
                </div>
              </div>
              <Composer draft="ask:new" placeholder="What is blocked across my repos … / Where does … belong (↵)" tools={model.tools} onSend={start} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
