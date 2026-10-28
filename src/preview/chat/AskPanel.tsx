import React, { useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { toast } from '../../components/Toast.tsx';
import { pendingClass } from '../../components/action.ts';
import Icon from '../Icon.tsx';
import { CardsWaiting } from './Card.tsx';
import { Composer, Log } from './Composer.tsx';
import Conversation from './Conversation.tsx';
import { askState, useAskConversation } from './conversation.ts';
import type { AskConvo } from './conversation.ts';
import type { AskRun, ModelChoice, UploadRef } from '../../types.ts';
import { useAskModel } from './ModelPicker.tsx';
import { SubagentBar } from '../Subagents.tsx';
import './chat.css';

type StartFn = (prompt: string, nonce: string, files: UploadRef[], pick: ModelChoice) => Promise<{ id: string }>;

// a conversation in a box: its header, messages, then the composer that stays open while coco works
// draft: where a new conversation's unsent text is kept; a running one keeps it under its own id
export function AskPanel({ convo, start, placeholder, examples = [], draft }: { convo: AskConvo; start?: StartFn; placeholder: string; examples?: string[]; draft?: string }) {
  const { run, events, pending, working, state, send, reset, cards, mergeCard } = convo;
  const [closing, setClosing] = useState(false);
  const st = askState(state);
  const close = async () => {
    if (!run) return;
    setClosing(true);
    try {
      await api.closeAsk(run.id);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setClosing(false);
    }
  };
  // a new conversation hands the current agent back unless it is mid-turn
  const fresh = () => {
    if (run && state === 'idle') api.closeAsk(run.id).catch(() => {});
    reset();
  };
  const model = useAskModel(run);
  const ask = (text: string, files: UploadRef[] = []) => {
    const pick = model.body();
    return send(text, start && ((nonce) => start(text, nonce, files, pick)), files, pick);
  };
  return (
    <div className="dp-box dp-askpanel">
      {run && (
        <>
          <div className="dp-askpanel-h">
            <span className={`dp-ag-dot ${st.dot}`} title={st.label} />
            <span className="dp-t3">Conversation</span><code>{run.id.slice(0, 8)}</code>
            <span className={`dp-chip ${st.tone}`}>{st.label}</span>
            {run.agentId && <span className="dp-t3 dp-ell">agent <code>{run.agentId.slice(0, 8)}</code></span>}
            <span className="dp-sp" />
            {(state === 'idle' || state === 'running') && <button type="button" className={`dp-btn dp-ghost dp-sm${pendingClass(closing)}`} disabled={closing} title="Archive coco's agent; a new message starts a new one with the conversation so far" onClick={close}><Icon name="archive" size={12} />Close</button>}
            <button type="button" className="dp-btn dp-sm" onClick={fresh}><Icon name="plus" size={12} />New conversation</button>
          </div>
          <Log size={events.length + pending.length + cards.length} className="dp-askpanel-log"><Conversation run={run} events={events} pending={pending} working={working} cards={cards} onCard={mergeCard} /></Log>
          <CardsWaiting cards={cards} />
          <SubagentBar agentId={run.agentId} inline />
        </>
      )}
      {!run && examples.length > 0 && (
        <div className="dp-askpanel-ex">
          <span className="dp-t3 dp-xs">Try</span>
          {examples.map((e) => <button key={e} type="button" className="dp-btn dp-sm" title={e} onClick={() => void ask(e)}>{e.slice(0, 48)}…</button>)}
        </div>
      )}
      <Composer draft={run ? `ask:${run.id}` : draft} agentId={model.agentId} placeholder={placeholder} sendLabel={!run ? 'Ask' : working ? 'Send while it works' : 'Send'} tools={model.tools} onSend={ask} onStop={working && run?.agentId ? () => api.agentStop(run.agentId ?? '') : undefined} />
    </div>
  );
}

const SAFE = 'Follow up as long as you like, even while it works. It reads and proposes; you apply. Nothing is pushed, posted or sent.';
// generic asks, then one about each of the repo's latest works
const repoExamples = (works: string[]) => [
  'Scaffold a work from a Notion spec: paste its link, I list what is not built yet and propose the stack.',
  'Which open PRs have no persona self-review at their head yet?',
  ...works.slice(0, 2).map((t) => `Summarise ${t}: what is blocked, what is next.`),
];
const stamp = (iso: string) => iso.slice(0, 16).replace('T', ' ');

// a repo's coco: scaffolds new works in it and answers about its code and PRs; earlier conversations below
export function RepoAsk({ repoId, repoName, works = [] }: { repoId: string; repoName?: string; works?: string[] }) {
  const convo = useAskConversation('ask', { kind: 'repo', repoId });
  const { run, history, open } = convo;
  const repo = repoName || repoId;
  return (
    <div className="dp-repoask">
      <p className="dp-repoask-lead">Coco for {repo}, on its main checkout: scaffolds new works in this repo and answers about its code and PRs. {SAFE}</p>
      <AskPanel
        convo={convo}
        draft={`repo:${repoId}`}
        start={(prompt, nonce, files, pick) => api.ask({ prompt, repoId, nonce, attachments: files.map((f) => f.id), ...pick })}
        examples={repoExamples(works)}
        placeholder={run ? 'Follow up, correct or narrow it down (markdown, ↵)' : `Scaffold a work in ${repo} for … / Who reviews … (↵)`}
      />
      {history.length > 0 && (
        <>
          <div className="dp-repoask-h">Earlier conversations on {repo}<span className="dp-count">{history.length}</span></div>
          <div className="dp-rows">
            {history.map((h: AskRun) => {
              const st = askState(h.status);
              return (
                <div key={h.id} className={`dp-rowi dp-click${run?.id === h.id ? ' dp-repoask-on' : ''}`} role="button" tabIndex={0} onClick={() => open(h)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(h); } }}>
                  <span className={`dp-ag-dot ${st.dot}`} title={st.label} />
                  <span className="dp-ell dp-grow">{h.prompt.slice(0, 110)}</span>
                  {h.proposed && <span className="dp-chip dp-acc" title={`Proposes a ${h.proposed.kind}`}>{h.proposed.title}</span>}
                  <span className="dp-rowi-m dp-num">{stamp(h.startedAt)}{(h.turns ?? 0) > 1 ? ` · ${h.turns} turns` : ''}{h.cost != null ? ` · $${Number(h.cost).toFixed(3)}` : ''}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
