import React, { useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { toast } from '../../components/Toast.tsx';
import { pendingClass } from '../../components/action.ts';
import Icon from '../Icon.tsx';
import { CardsWaiting } from './Card.tsx';
import { Composer, Log } from './Composer.tsx';
import Conversation from './Conversation.tsx';
import { Proposals } from './Proposals.tsx';
import { askState, useAskConversation } from './conversation.ts';
import type { AskConvo } from './conversation.ts';
import type { AskRun, UploadRef } from '../../types.ts';
import './chat.css';

type StartFn = (prompt: string, nonce: string, files: UploadRef[]) => Promise<{ id: string }>;

// a conversation in a box: its header, messages, then the composer that stays open while coco works
export function AskPanel({ convo, start, placeholder, examples = [] }: { convo: AskConvo; start?: StartFn; placeholder: string; examples?: string[] }) {
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
  const ask = (text: string, files: UploadRef[] = []) => send(text, start && ((nonce) => start(text, nonce, files)), files);
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
        </>
      )}
      {!run && examples.length > 0 && (
        <div className="dp-askpanel-ex">
          <span className="dp-t3 dp-xs">Try</span>
          {examples.map((e) => <button key={e} type="button" className="dp-btn dp-sm" title={e} onClick={() => void ask(e)}>{e.slice(0, 48)}…</button>)}
        </div>
      )}
      <Composer placeholder={placeholder} sendLabel={!run ? 'Ask' : working ? 'Send while it works' : 'Send'} onSend={ask} />
    </div>
  );
}

const SAFE = 'Follow up as long as you like, even while it works. It reads and proposes; you apply. Nothing is pushed, posted or sent.';
const REPO_EXAMPLES = [
  'Scaffold a work for adding CSV export to the invoices page, mirroring the PDF export stack. Who reviews each PR?',
  'Which open PRs touch alice\'s surfaces this week and have no persona self-review yet?',
  'From Notion page https://www.notion.so/acme/Spec-00000000000000000000000000000000, list what is not built yet and propose a work for the next piece.',
  'Summarise the csv-export work: what is blocked, what is next.',
];
const stamp = (iso: string) => iso.slice(0, 16).replace('T', ' ');

// a repo's coco: scaffolds new works in it and answers about its code and PRs; earlier conversations below
export function RepoAsk({ repoId, repoName }: { repoId: string; repoName?: string }) {
  const convo = useAskConversation('ask', { kind: 'repo', repoId });
  const { run, history, open } = convo;
  const repo = repoName || repoId;
  return (
    <div className="dp-repoask">
      <p className="dp-repoask-lead">Coco for {repo}, on its main checkout: scaffolds new works in this repo and answers about its code and PRs. {SAFE}</p>
      <AskPanel
        convo={convo}
        start={(prompt, nonce, files) => api.ask({ prompt, repoId, nonce, attachments: files.map((f) => f.id) })}
        examples={REPO_EXAMPLES}
        placeholder={run ? 'Follow up, correct or narrow it down (markdown, ⌘↵)' : `Scaffold a work in ${repo} for … / Who reviews … (⌘↵)`}
      />
      {run && <Proposals run={run} onApplied={(slug) => { location.hash = `#/work/${slug}`; }} />}
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
                  {h.proposal && <span className="dp-chip dp-acc" title="Proposes a work">{h.proposal.title || 'proposal'}</span>}
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
