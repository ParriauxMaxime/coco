import React, { useContext, useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { toast } from '../components/Toast.tsx';
import { CardsWaiting } from './chat/Card.tsx';
import { cardEvents, useCardList } from './chat/cards.ts';
import { subscribe, topic } from '../live.ts';
import { Composer, Log } from './chat/Composer.tsx';
import Conversation from './chat/Conversation.tsx';
import { PendingPermissions } from './chat/Permission.tsx';
import { useSeen, useWaitingByAgent } from './waiting.ts';
import { nonceOf, useAskConversation } from './chat/conversation.ts';
import { WorkContext, useWork } from '../workbench/use-work.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import Icon from './Icon.tsx';
import { AgentDot } from './AgentsSection.tsx';
import { STATE_LABEL, paseoLink, prLabel, stateOf, useServerId, useWorkAgent } from './agents.ts';
import type { AgentState } from './agents.ts';
import { usageLine, usageTitle } from './format.ts';
import { ContextRing } from './Ring.tsx';
import { HandoffControls } from './Handoff.tsx';
import Thread, { refreshThreads, threadLabel, useThreadsOf } from '../components/Thread.tsx';
import { confirmDialog } from '../components/Dialogs.tsx';
import { pendingClass, useAction } from '../components/action.ts';
import type { ActivityEvent, AgentMetrics, ModelChoice, ThreadGroup, ThreadSummary, UploadRef } from '../types.ts';
import { ModelControls, useAskModel, useLiveMode, useModelChoice } from './chat/ModelPicker.tsx';
import { AgentTitle } from './AgentTitle.tsx';
import type { Choice } from './chat/ModelPicker.tsx';
import { useOverview } from './overview.ts';
import { SubagentBar } from './Subagents.tsx';
import { SubagentParent } from './subagents.ts';
import { GitPanel, openWorkspaceCommit, useAgentWorkspace } from './GitPanel.tsx';
import { FilesPanel, openWorkspaceFile } from './FilesPanel.tsx';
import { TerminalPanel } from './TerminalPanel.tsx';
import { BrowserPanel, useAgentBrowser } from './BrowserPanel.tsx';
import { ArchiveCountdown, RestoreButton } from './AutoArchive.tsx';

const NEW = 'ask-new-';
export const newAgentPr = (tabId: string) => (tabId.startsWith(NEW) ? tabId.slice(NEW.length) : null);

// serverId: given outside a work, where no work agent list carries it; handoff: its Hand off button and where it was handed from or to
// onRenamed: after the title was edited in place (a live agent's title is a click to rename)
type HeaderProps = { title: string; kind: string; pr: string | null; state: AgentState; agentId: string | null; metrics?: AgentMetrics | null; chips?: React.ReactNode; actions?: React.ReactNode; serverId?: string | null; handoff?: boolean; onRenamed?: (title: string) => void };
export function Header({ title, kind, pr, state, agentId, metrics, chips, actions, serverId, handoff = false, onRenamed }: HeaderProps) {
  const listedServer = useServerId(useContext(WorkContext)?.slug ?? '');
  const href = paseoLink(serverId ?? listedServer, agentId);
  const usage = metrics ? usageLine(metrics) : '';
  return (
    <div className="dp-vbar dp-ag-bar">
      <AgentDot state={state} />
      <AgentTitle title={title} agentId={state === 'archived' ? null : agentId} onRenamed={onRenamed} />
      <span className="dp-chip">{kind}</span>
      {pr && <span className="dp-chip">{prLabel(pr)}</span>}
      {chips}
      <span className="dp-xs dp-t3">{STATE_LABEL[state]}</span>
      <span className="dp-sp" />
      {usage && metrics && <span className="dp-xs dp-t3 dp-ag-usage" title={usageTitle(metrics)}>{usage}</span>}
      <span className="dp-xs dp-t3"><ContextRing used={metrics?.contextTokens} max={metrics?.contextMax} label /></span>
      {actions}
      {handoff && agentId && <HandoffControls agentId={agentId} metrics={metrics} archived={state === 'archived'} />}
      {href && <a className="dp-btn dp-sm" href={href} title="Open this agent in the Paseo app"><Icon name="external-link" size={14} /><span className="dp-ag-lbl">Open in Paseo</span></a>}
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
      <Composer draft={`${slug}:${tabId}`} placeholder={`Ask about or extend ${pr ? prLabel(pr) : 'this work'}… (↵)`} tools={model.tools} onSend={start} />
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
  const asked = useWaitingByAgent();
  const seen = useSeen(`ask:${id}`);
  useEffect(() => {
    api.askConversation(id).then(convo.open, (e) => toast.error(errorMessage(e)));
  }, [id]);
  const base = listed ? stateOf(listed, asked) : 'done';
  const state = working && base !== 'waiting' ? 'running' : base;
  return (
    <div ref={seen} className="dp-tabview dp-agtab">
      <Header title={listed?.title || run?.title || run?.prompt?.split('\n')[0] || 'Ask coco'} kind="ask" pr={run?.pr == null ? null : String(run.pr)} state={state} agentId={run?.agentId ?? listed?.agentId ?? null} metrics={listed} />
      <SubagentParent.Provider value={run?.agentId ?? listed?.agentId ?? null}>
        <Log size={events.length + pending.length + cards.length}>
          {run && <Conversation run={run} events={events} pending={pending} working={working} cards={cards} onCard={mergeCard} />}
        </Log>
      </SubagentParent.Provider>
      <CardsWaiting cards={cards} />
      <SubagentBar agentId={run?.agentId ?? listed?.agentId} />
      <Composer
        draft={`ask:${id}`}
        agentId={model.agentId}
        placeholder="Follow up, correct or narrow it down (↵, ⇧↵ new line)"
        note={state === 'archived' ? 'Its agent is archived: a message starts a new one with the conversation so far' : working ? 'Sends while it works' : ''}
        tools={model.tools}
        onSend={(text, files) => convo.send(text, undefined, files, model.body())}
        onStop={working && run?.agentId ? () => api.agentStop(run.agentId ?? '') : undefined}
      />
    </div>
  );
}

// any Paseo agent of the work: its timeline as one history (sent again when the server read newer entries) then followed, the owner's messages included
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
      history: (evs: ActivityEvent[]) => {
        setEvents(evs);
        const said = new Set(evs.flatMap((e) => (e.type === 'user' ? [e.text] : [])));
        setPending((p) => p.filter((x) => !said.has(x.text)));
      },
      message: (ev: ActivityEvent) => {
        setEvents((prev) => [...prev, ev]);
        // the agent may get lines coco adds after the owner's text (a readied worktree)
        if (ev.type === 'user') setPending((p) => p.filter((x) => !(ev.text ?? '').startsWith(x.text)));
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
// fallback follows when Paseo has no timeline for it (only notes came back); inline: outside a work, subagents open in a dialog
// current: its model and thinking when the caller knows them, else the overview's; pinned: what waits on you, kept over the composer
type TranscriptProps = { agentId: string; state: AgentState; who: string; lead?: React.ReactNode; fallback?: React.ReactNode; inline?: boolean; current?: Choice | null; onSent?: () => void; pinned?: React.ReactNode };
export function AgentTranscript({ agentId, state, who, lead, fallback, inline = false, current, onSent, pinned }: TranscriptProps) {
  const { events, pending, send, cards, merge } = useAgentChat(agentId);
  const gone = events.length > 0 && events.every((e) => NOTE_ONLY.includes(e.type));
  const archived = state === 'archived';
  const listed = useOverview().ov?.agents.find((a) => a.id === agentId);
  const model = useModelChoice(null, { live: true, current: current ?? (listed?.provider ? { provider: listed.provider, thinking: listed.thinking || null } : null) });
  const live = archived || gone ? null : agentId;
  const mode = useLiveMode(live);
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
      <SubagentBar agentId={agentId} inline={inline} />
      {pinned}
      <Composer
        draft={`agent:${agentId}`}
        placeholder={archived ? 'This agent is archived' : gone ? 'Paseo no longer knows this agent' : 'Message this agent (↵, ⇧↵ new line)'}
        note={archived ? (inline ? 'Archived' : 'Archived: + in Agents starts a new one') : state === 'running' ? 'Sends while it works' : cards.some((c) => c.status === 'open' && c.kind !== 'post') ? 'A message answers its open cards' : ''}
        disabled={archived || gone}
        agentId={live}
        tools={<ModelControls choice={model.choice} onPick={model.pick} hint="switches this agent from your next message" disabled={archived || gone} mode={mode} lock />}
        onSend={async (text, files) => {
          const ok = await send(text, files, model.body());
          if (ok) onSent?.();
          return ok;
        }}
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
  const asked = useWaitingByAgent();
  const state = listed ? stateOf(listed, asked) : 'done';
  const seen = useSeen(`agent:${agentId}`);
  const { summaries, groups } = useThreadsOf(slug);
  const group = groups.find((g) => g.agentId === agentId);
  const keys = group ? Object.keys(summaries).filter((k) => summaries[k].groupId === group.id).sort((a, b) => (summaries[b].lastTs ?? '').localeCompare(summaries[a].lastTs ?? '')) : [];
  const wsId = useAgentWorkspace(agentId);
  const browserTabs = useAgentBrowser(agentId);
  const [picked, setPicked] = useState<AgentView>(null);
  const shown = picked && ((picked !== 'changes' && picked !== 'files' && picked !== 'terminal') || wsId) && (picked !== 'thread' || keys.length) && (picked !== 'browser' || browserTabs.length);
  const view: AgentView = shown ? picked : keys.length ? 'thread' : 'transcript';
  const views: ViewDef[] = [
    ...(keys.length ? [{ id: 'thread' as const, label: keys.length > 1 ? <>Threads<span className="dp-t3">{keys.length}</span></> : 'Thread', title: 'Each item this agent works on, as its thread: blocks, suggestions, Approve' }] : []),
    { id: 'transcript', label: 'Transcript', title: "The agent's raw Paseo transcript: coco's prompts, thinking, tool calls" },
    ...(wsId ? [CHANGES, FILES, TERMINAL] : []),
    ...(browserTabs.length ? [BROWSER] : []),
  ];
  const toApprove = keys.reduce((n, k) => n + (summaries[k].open ?? 0), 0);
  const pinned = toApprove > 0 ? (
    <div className="dp-thr-pend dp-ag-pend">
      <button type="button" className="dp-chip dp-info" title="Its threads hold each suggested commit with Review commit, Verify, Approve and Dismiss" onClick={() => setPicked('thread')}>
        <Icon name="eye" size={12} />{toApprove === 1 ? 'a suggested commit' : `${toApprove} suggested commits`} to approve · Thread
      </button>
    </div>
  ) : listed?.autoArchive && state !== 'archived' && <ArchiveCountdown agentId={agentId} turn={listed.updatedAt} />;
  const actions = <>{group?.status === 'active' && <GroupActions slug={slug} group={group} keys={keys} summaries={summaries} />}{state === 'archived' && !group && <RestoreButton agentId={agentId} />}</>;
  return (
    <div ref={seen} className="dp-tabview dp-agtab">
      <Header title={listed?.title || `Agent ${agentId.slice(0, 8)}`} kind={listed?.kind || 'agent'} pr={listed?.pr ?? null} state={state} agentId={agentId} metrics={listed} chips={<ViewSeg views={views} value={view} onPick={setPicked} />} actions={actions} handoff />
      {view === 'changes' && wsId ? <GitPanel wsId={wsId} onOpenCommit={openWorkspaceCommit(wsId)} />
        : view === 'files' && wsId ? <FilesPanel key={wsId} wsId={wsId} onOpenTab={openWorkspaceFile(wsId)} />
        : view === 'terminal' && wsId ? <TerminalPanel wsId={wsId} />
        : view === 'browser' ? <BrowserPanel tabs={browserTabs} />
        : view === 'thread' ? <GroupThreads slug={slug} keys={keys} summaries={summaries} /> : <AgentTranscript agentId={agentId} state={state} who={listed?.kind || 'agent'} pinned={pinned} />}
    </div>
  );
}

// the views of an agent under its header: its threads, its transcript, its workspace's Changes
export type AgentView = 'thread' | 'transcript' | 'changes' | 'files' | 'terminal' | 'browser' | null;
type ViewDef = { id: Exclude<AgentView, null>; label: React.ReactNode; title: string };
export const CHANGES: ViewDef = { id: 'changes', label: 'Changes', title: "Its workspace's git: uncommitted changes, unpushed commits; commit, pull, push, create a PR" };
export const FILES: ViewDef = { id: 'files', label: 'Files', title: "Its workspace's files: browse, read, edit and save; ⌘P goes to a file" };
export const TERMINAL: ViewDef = { id: 'terminal', label: 'Terminal', title: "Its workspace's terminals and scripts, live: a new shell, Kill, Start / Stop" };
export const BROWSER: ViewDef = { id: 'browser', label: 'Browser', title: "What its browser tab shows in coco's headless Chrome (coco hosts the browser while the Paseo app is closed), read-only" };
export function ViewSeg({ views, value, onPick }: { views: ViewDef[]; value: AgentView; onPick: (v: AgentView) => void }) {
  if (views.length < 2) return null;
  return (
    <span className="dp-seg" role="tablist">
      {views.map((v) => <button key={v.id} type="button" role="tab" aria-selected={value === v.id} className={value === v.id ? 'dp-on' : ''} title={v.title} onClick={() => onPick(v.id)}>{v.label}</button>)}
    </span>
  );
}

// the group's actions the threads show under a comment: rules from its corrections, prune its agent
function GroupActions({ slug, group, keys, summaries }: { slug: string; group: ThreadGroup; keys: string[]; summaries: Record<string, ThreadSummary> }) {
  const { pending, busy, run } = useAction();
  const talked = keys.filter((k) => summaries[k].count > 1);
  const waiting = keys.some((k) => summaries[k].waiting);
  return (
    <>
      {talked.length > 0 && <button type="button" className={`dp-btn dp-sm dp-ghost${pendingClass(pending === 'rules')}`} disabled={busy} title="coco distills the corrections of this agent's threads into proposed work rules" onClick={() => run('rules', async () => {
        await Promise.all(talked.map((threadKey) => api.proposeRules(slug, { scope: 'work', threadKey })));
        toast.success('coco is proposing rules: keep or drop them in the Rules tab');
      })}><Icon name="book" size={12} /><span className="dp-ag-lbl">Rules</span></button>}
      {!waiting && <button type="button" className={`dp-btn dp-sm dp-ghost${pendingClass(pending === 'prune')}`} disabled={busy} title="Archive the group's agent and worktree, delete its branch" onClick={async () => (await confirmDialog({ title: `Prune the agent of group ${group.id}?`, body: `${group.items.length} item(s): archive its agent and worktree, delete its branch.`, ok: 'Prune', danger: true })) && run('prune', async () => {
        await api.closeGroup(slug, group.id);
        await refreshThreads(slug);
      })}><Icon name="archive" size={12} /><span className="dp-ag-lbl">Prune agent</span></button>}
    </>
  );
}

// a group agent seen as the items it works on: the same threads as under the comments, the most recent open
function GroupThreads({ slug, keys, summaries }: { slug: string; keys: string[]; summaries: Record<string, ThreadSummary> }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(keys.filter((k, i) => i === 0 || summaries[k].waiting || summaries[k].open || summaries[k].asks)));
  const flip = (k: string) => setOpen((s) => {
    const next = new Set(s);
    next[next.has(k) ? 'delete' : 'add'](k);
    return next;
  });
  if (keys.length === 1) {
    return (
      <Log size={summaries[keys[0]].count} className="dp-ag-threads">
        <div className="dp-ag-thread dp-ag-one">
          <div className="dp-ag-thread-h dp-open"><span className="dp-ell">{summaries[keys[0]].label || keys[0]}</span></div>
          <Thread slug={slug} threadKey={keys[0]} bare />
        </div>
      </Log>
    );
  }
  return (
    <div className="dp-ag-threads">
      {keys.map((k) => (
        <section key={k} className="dp-ag-thread">
          <button type="button" className={`dp-ag-thread-h${open.has(k) ? ' dp-open' : ''}`} aria-expanded={open.has(k)} onClick={() => flip(k)}>
            <span className={`dp-caret${open.has(k) ? ' dp-open' : ''}`}><Icon name="chevron-right" size={12} /></span>
            <span className="dp-ell">{summaries[k].label || k}</span>
            <span className="dp-sp" />
            <span className="dp-xs dp-t3">{threadLabel(summaries[k], '')}</span>
          </button>
          {open.has(k) && <Thread slug={slug} threadKey={k} bare />}
        </section>
      ))}
    </div>
  );
}
