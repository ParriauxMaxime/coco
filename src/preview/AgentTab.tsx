import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { AgentProposal, Conversation, DispatchProposal, Proposal, RepoProposal, useAskConversation } from '../pages/Ask.tsx';
import { PendingPermissions, usePendingPermissions } from '../components/PermissionCard.tsx';
import { toast } from '../components/Toast.tsx';
import { useWork } from '../workbench/use-work.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import Icon from './Icon.tsx';
import { AgentDot } from './AgentsSection.tsx';
import { STATE_LABEL, paseoLink, prLabel, stateOf, useServerId, useWorkAgent } from './agents.ts';
import type { AgentState } from './agents.ts';
import type { ActivityEvent } from '../types.ts';

const NEW = 'ask-new-';
export const newAgentPr = (tabId: string) => (tabId.startsWith(NEW) ? tabId.slice(NEW.length) : null);

const nonceOf = () => Math.random().toString(36).slice(2, 12);

// follows the bottom while new steps arrive, unless the owner scrolled up to read
function Log({ size, children }: { size: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [size]);
  return <div ref={ref} className="dp-agent-log" onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>{children}</div>;
}

function Composer({ placeholder, note, disabled = false, onSend }: { placeholder: string; note?: string; disabled?: boolean; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const send = async () => {
    const t = text.trim();
    if (t && !disabled && (await onSend(t))) setText('');
  };
  return (
    <div className="dp-composer">
      <div className="dp-composer-in">
        <textarea rows={2} value={text} disabled={disabled} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
        <div className="dp-comp-f">
          <span className="dp-xs dp-t3 dp-grow dp-ell">{note}</span>
          <button type="button" className="dp-btn dp-primary dp-sm" disabled={disabled || !text.trim()} onClick={() => void send()}>Send<kbd>⌘</kbd><kbd>↵</kbd></button>
        </div>
      </div>
    </div>
  );
}

function Header({ title, kind, pr, state, agentId }: { title: string; kind: string; pr: string | null; state: AgentState; agentId: string | null }) {
  const href = paseoLink(useServerId(useWork().slug), agentId);
  return (
    <div className="dp-vbar dp-ag-bar">
      <AgentDot state={state} />
      <span className="dp-title dp-ell">{title}</span>
      <span className="dp-chip">{kind}</span>
      {pr && <span className="dp-chip">{prLabel(pr)}</span>}
      <span className="dp-xs dp-t3">{STATE_LABEL[state]}</span>
      <span className="dp-sp" />
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
  const start = (text: string) => convo.send(text, (nonce) => api.ask({ prompt: text, workSlug: slug, pr, nonce }));
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
      <Composer placeholder={`Ask about or extend ${pr ? prLabel(pr) : 'this work'}… (⌘↵)`} onSend={start} />
    </div>
  );
}

// ask-<conversation>: an Ask conversation; once its agent is archived, a message starts a new one with the conversation so far
export function AskAgentTab({ tabId }: { tabId: string }) {
  const { slug } = useWork();
  const id = tabId.slice(4);
  const convo = useAskConversation('ask', { kind: 'work', slug });
  const { run, events, pending, working } = convo;
  const listed = useWorkAgent(slug, tabId);
  const { pending: asked } = usePendingPermissions();
  useEffect(() => {
    api.askConversation(id).then(convo.open, (e) => toast.error(errorMessage(e)));
  }, [id]);
  const base = listed ? stateOf(listed, asked) : 'done';
  const state = working && base !== 'waiting' ? 'running' : base;
  return (
    <div className="dp-tabview dp-agtab">
      <Header title={listed?.title || run?.prompt?.split('\n')[0] || 'Ask coco'} kind="ask" pr={run?.pr == null ? null : String(run.pr)} state={state} agentId={run?.agentId ?? listed?.agentId ?? null} />
      <Log size={events.length + pending.length}>
        {run && <Conversation run={run} events={events} pending={pending} working={working} />}
        {run && (
          <div className="dp-ag-cards">
            <Proposal run={run} onApplied={(s) => { location.hash = `#/work/${s}`; }} />
            <AgentProposal run={run} />
            <DispatchProposal run={run} />
            <RepoProposal run={run} />
          </div>
        )}
      </Log>
      <Composer
        placeholder="Follow up, correct or narrow it down (⌘↵)"
        note={state === 'archived' ? 'Its agent is archived: a message starts a new one with the conversation so far' : working ? 'Sends while it works' : ''}
        onSend={(text) => convo.send(text)}
      />
    </div>
  );
}

// any Paseo agent of the work: its timeline replayed then followed, the owner's messages included
function useAgentChat(agentId: string) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [pending, setPending] = useState<{ nonce: string; text: string }[]>([]);
  useEffect(() => {
    const es = new EventSource(`/api/agent-chat/${encodeURIComponent(agentId)}/events`);
    es.onopen = () => setEvents([]);
    es.onmessage = (m) => {
      const ev: ActivityEvent = JSON.parse(m.data);
      setEvents((prev) => [...prev, ev]);
      if (ev.type === 'user') setPending((p) => p.filter((x) => x.text !== ev.text));
    };
    return () => es.close();
  }, [agentId]);
  const send = async (text: string) => {
    const nonce = nonceOf();
    setPending((p) => [...p, { nonce, text }]);
    try {
      await api.agentSay(agentId, text);
      return true;
    } catch (e) {
      setPending((p) => p.filter((x) => x.nonce !== nonce));
      toast.error(errorMessage(e));
      return false;
    }
  };
  return { events, pending, send };
}

// ag-<agent>: a review, fix, gate, brief or linked agent
export function PaseoAgentTab({ tabId }: { tabId: string }) {
  const { slug } = useWork();
  const agentId = tabId.slice(3);
  const { events, pending, send } = useAgentChat(agentId);
  const listed = useWorkAgent(slug, tabId);
  const { pending: asked } = usePendingPermissions();
  const state = listed ? stateOf(listed, asked) : 'done';
  const archived = state === 'archived';
  return (
    <div className="dp-tabview dp-agtab">
      <Header title={listed?.title || `Agent ${agentId.slice(0, 8)}`} kind={listed?.kind || 'agent'} pr={listed?.pr ?? null} state={state} agentId={agentId} />
      <Log size={events.length + pending.length}>
        <Conversation run={{ id: agentId, prompt: '' }} events={events} pending={pending} working={state === 'running'} />
        <PendingPermissions agentId={agentId} />
      </Log>
      <Composer
        placeholder={archived ? 'This agent is archived' : 'Message this agent (⌘↵)'}
        note={archived ? 'Archived: + in Agents starts a new one' : state === 'running' ? 'Sends while it works' : ''}
        disabled={archived}
        onSend={send}
      />
    </div>
  );
}
