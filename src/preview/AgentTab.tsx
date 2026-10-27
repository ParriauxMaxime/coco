import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { toast } from '../components/Toast.tsx';
import { CardsWaiting } from './chat/Card.tsx';
import { cardEvents, useCardList } from './chat/cards.ts';
import { subscribe, topic } from '../live.ts';
import { Composer, Log } from './chat/Composer.tsx';
import Conversation from './chat/Conversation.tsx';
import { PendingPermissions, usePendingPermissions } from './chat/Permission.tsx';
import { nonceOf, useAskConversation } from './chat/conversation.ts';
import { useWork } from '../workbench/use-work.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import Icon from './Icon.tsx';
import { AgentDot } from './AgentsSection.tsx';
import { STATE_LABEL, paseoLink, prLabel, stateOf, useServerId, useWorkAgent } from './agents.ts';
import type { AgentState } from './agents.ts';
import { usageLine, usageTitle } from './format.ts';
import type { ActivityEvent, AgentMetrics, ModelChoice, UploadRef } from '../types.ts';
import { ModelControls, useAskModel, useModelChoice } from './chat/ModelPicker.tsx';
import { useOverview } from './overview.ts';
import { SubagentBar } from './Subagents.tsx';
import { SubagentParent } from './subagents.ts';

const NEW = 'ask-new-';
export const newAgentPr = (tabId: string) => (tabId.startsWith(NEW) ? tabId.slice(NEW.length) : null);

type HeaderProps = { title: string; kind: string; pr: string | null; state: AgentState; agentId: string | null; metrics?: AgentMetrics | null; chips?: React.ReactNode };
export function Header({ title, kind, pr, state, agentId, metrics, chips }: HeaderProps) {
  const href = paseoLink(useServerId(useWork().slug), agentId);
  const usage = metrics ? usageLine(metrics) : '';
  return (
    <div className="dp-vbar dp-ag-bar">
      <AgentDot state={state} />
      <span className="dp-title dp-ell">{title}</span>
      <span className="dp-chip">{kind}</span>
      {pr && <span className="dp-chip">{prLabel(pr)}</span>}
      {chips}
      <span className="dp-xs dp-t3">{STATE_LABEL[state]}</span>
      <span className="dp-sp" />
      {usage && metrics && <span className="dp-xs dp-t3 dp-ag-usage" title={usageTitle(metrics)}>{usage}</span>}
      {href && <a className="dp-btn dp-sm" href={href} title="Open this agent in the Paseo app"><Icon name="external-link" size={14} />Open in Paseo</a>}
    </div>
  );
}

const EXAMPLES = ['Summarise this work: what is blocked, what is next.', 'Who should review each PR, and has anyone yet?'];
const PR_EXAMPLES = ['What does this PR change, and what is left before review?', 'Which review comments on this PR are still open?'];

// 'ask' or ask-new-<pr>: the first message starts an Ask agent on the work or that PR, and the tab becomes it
export function NewAgentTab({ tabId }: { tabId: string }) {
  const { slug, w } = useWork();
  const pr = newAgentPr(tabId);
  const convo = useAskConversation('ask', { kind: 'work', slug });
  const started = convo.run?.id;
  useEffect(() => {
    if (started) useWorkbench.getState().rename(tabId, `ask-${started}`);
  }, [started]);
  const model = useAskModel(null);
  const start = (text: string, files: UploadRef[] = []) => convo.send(text, (nonce) => api.ask({ prompt: text, workSlug: slug, pr, nonce, attachments: files.map((f) => f.id), ...model.body() }), files);
  return (
    <div className="dp-tabview dp-agtab">
      <div className="dp-vbar"><Icon name="bot" size={14} /><span className="dp-title">New agent</span><span className="dp-chip">{pr ? prLabel(pr) : 'work'}</span></div>
      <div className="dp-agent-log dp-ag-start">
        <div className="dp-ag-hello">
          <span className="dp-cocoav">c</span>
          <div className="dp-ag-h">Ask coco about {pr ? prLabel(pr) : w.title}</div>
          <p className="dp-t3">It reads the work, its PRs and the code{pr ? ' in that PR\'s worktree' : ''}, answers and proposes; you apply. Nothing is pushed, posted or sent.</p>
          <div className="dp-ag-ex">{(pr ? PR_EXAMPLES : EXAMPLES).map((e) => <button key={e} type="button" className="dp-btn dp-sm" onClick={() => void start(e)}>{e}</button>)}</div>
        </div>
      </div>
      <Composer placeholder={`Ask about or extend ${pr ? prLabel(pr) : 'this work'}… (↵)`} tools={model.tools} onSend={start} />
    </div>
  );
}

// ask-<conversation>: an Ask conversation; once its agent is archived, a message starts a new one with the conversation so far
export function AskAgentTab({ tabId }: { tabId: string }) {
  const { slug } = useWork();
  const id = tabId.slice(4);
  const convo = useAskConversation('ask', { kind: 'work', slug });
  const { run, events, pending, working, cards, mergeCard } = convo;
  const model = useAskModel(run);
  const listed = useWorkAgent(slug, tabId);
  const { pending: asked } = usePendingPermissions();
  useEffect(() => {
    api.askConversation(id).then(convo.open, (e) => toast.error(errorMessage(e)));
  }, [id]);
  const base = listed ? stateOf(listed, asked) : 'done';
  const state = working && base !== 'waiting' ? 'running' : base;
  return (
    <div className="dp-tabview dp-agtab">
      <Header title={listed?.title || run?.prompt?.split('\n')[0] || 'Ask coco'} kind="ask" pr={run?.pr == null ? null : String(run.pr)} state={state} agentId={run?.agentId ?? listed?.agentId ?? null} metrics={listed} />
      <SubagentParent.Provider value={run?.agentId ?? listed?.agentId ?? null}>
        <Log size={events.length + pending.length + cards.length}>
          {run && <Conversation run={run} events={events} pending={pending} working={working} cards={cards} onCard={mergeCard} />}
        </Log>
      </SubagentParent.Provider>
      <CardsWaiting cards={cards} />
      <SubagentBar agentId={run?.agentId ?? listed?.agentId} />
      <Composer
        placeholder="Follow up, correct or narrow it down (↵, ⇧↵ new line)"
        note={state === 'archived' ? 'Its agent is archived: a message starts a new one with the conversation so far' : working ? 'Sends while it works' : ''}
        tools={model.tools}
        onSend={(text, files) => convo.send(text, undefined, files, model.body())}
        onStop={working && run?.agentId ? () => api.agentStop(run.agentId ?? '') : undefined}
      />
    </div>
  );
}

// any Paseo agent of the work: its timeline replayed then followed, the owner's messages included
function useAgentChat(agentId: string) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [pending, setPending] = useState<{ nonce: string; text: string; attachments?: UploadRef[] }[]>([]);
  const { cards, merge, setCards } = useCardList();
  useEffect(() => {
    setCards([]);
    const card = cardEvents(agentId, merge);
    return subscribe(topic('agent-chat', agentId), {
      ...card,
      open: () => {
        setEvents([]);
        card.open();
      },
      message: (ev: ActivityEvent) => {
        setEvents((prev) => [...prev, ev]);
        if (ev.type === 'user') setPending((p) => p.filter((x) => x.text !== ev.text));
      },
    });
  }, [agentId]);
  const send = async (text: string, files: UploadRef[] = [], pick: ModelChoice = {}) => {
    const nonce = nonceOf();
    setPending((p) => [...p, { nonce, text, ...(files.length ? { attachments: files } : {}) }]);
    try {
      await api.agentSay(agentId, text, files.map((f) => f.id), pick);
      return true;
    } catch (e) {
      setPending((p) => p.filter((x) => x.nonce !== nonce));
      toast.error(errorMessage(e));
      return false;
    }
  };
  return { events, pending, send, cards, merge };
}

const NOTE_ONLY = ['meta', 'stderr'];

// an agent's chat under any header: lead on top, its timeline, permissions, open cards and composer;
// fallback follows when Paseo has no timeline for it (only notes came back)
type TranscriptProps = { agentId: string; state: AgentState; who: string; lead?: React.ReactNode; fallback?: React.ReactNode };
export function AgentTranscript({ agentId, state, who, lead, fallback }: TranscriptProps) {
  const { events, pending, send, cards, merge } = useAgentChat(agentId);
  const gone = events.length > 0 && events.every((e) => NOTE_ONLY.includes(e.type));
  const archived = state === 'archived';
  const listed = useOverview().ov?.agents.find((a) => a.id === agentId);
  const model = useModelChoice(null, { live: true, current: listed?.provider ? { provider: listed.provider, thinking: listed.thinking || null } : null });
  return (
    <>
      <SubagentParent.Provider value={agentId}>
        <Log size={events.length + pending.length + cards.length}>
          {lead}
          <Conversation run={{ id: agentId, prompt: '' }} events={events} pending={pending} working={state === 'running' && !gone} who={who} cards={cards} onCard={merge} />
          {gone && fallback}
          <PendingPermissions agentId={agentId} />
        </Log>
      </SubagentParent.Provider>
      <CardsWaiting cards={cards} />
      <SubagentBar agentId={agentId} />
      <Composer
        placeholder={archived ? 'This agent is archived' : gone ? 'Paseo no longer knows this agent' : 'Message this agent (↵, ⇧↵ new line)'}
        note={archived ? 'Archived: + in Agents starts a new one' : state === 'running' ? 'Sends while it works' : ''}
        disabled={archived || gone}
        tools={<ModelControls choice={model.choice} onPick={model.pick} hint="switches this agent from your next message" disabled={archived || gone} />}
        onSend={(text, files) => send(text, files, model.body())}
        onStop={state === 'running' ? () => api.agentStop(agentId) : undefined}
      />
    </>
  );
}

// ag-<agent>: a review, fix, gate, brief or linked agent
export function PaseoAgentTab({ tabId }: { tabId: string }) {
  const { slug } = useWork();
  const agentId = tabId.slice(3);
  const listed = useWorkAgent(slug, tabId);
  const { pending: asked } = usePendingPermissions();
  const state = listed ? stateOf(listed, asked) : 'done';
  return (
    <div className="dp-tabview dp-agtab">
      <Header title={listed?.title || `Agent ${agentId.slice(0, 8)}`} kind={listed?.kind || 'agent'} pr={listed?.pr ?? null} state={state} agentId={agentId} metrics={listed} />
      <AgentTranscript agentId={agentId} state={state} who={listed?.kind || 'agent'} />
    </div>
  );
}
