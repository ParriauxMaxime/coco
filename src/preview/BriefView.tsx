import { useEffect, useState } from 'react';
import Markdown from '../components/Markdown.tsx';
import { api, errorMessage } from '../api.ts';
import { pendingClass, useAction } from '../components/action.ts';
import { useWork } from '../workbench/use-work.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import { keyLabel } from '../workbench/code/ids.ts';
import type { BriefResponse, LinkedAgent } from '../types.ts';
import type { PrKey } from '../workbench/types.ts';
import Icon from './Icon.tsx';
import Modal from './Modal.tsx';
import { ErrorNote, Loading } from './pages/Page.tsx';
import { stamp } from './format.ts';
import './run.css';

export const briefKeyOfTab = (id: string): PrKey => {
  const raw = id.slice('brief-'.length);
  return /^\d+$/.test(raw) ? Number(raw) : raw;
};

type Ask = { action: string; title: string; text: string; go: string };

// brief-<pr>: the agent sitting in the PR worktree, the brief rendered from the work, start or hand off in the same workspace
export default function BriefView({ tabId, group }: { tabId: string; group: number }) {
  const { slug, load } = useWork();
  const n = briefKeyOfTab(tabId);
  const open = useWorkbench((s) => s.open);
  const [data, setData] = useState<BriefResponse | null>(null);
  const [error, setError] = useState('');
  const { pending, busy, run } = useAction();
  const [handoff, setHandoff] = useState(false);
  const [linked, setLinked] = useState<LinkedAgent[]>([]);
  const [ask, setAsk] = useState<Ask | null>(null);
  const refresh = () => {
    api.linkedAgents(slug).then((all) => setLinked(all.filter((l) => String(l.key) === String(n))), () => setLinked([]));
    return api.brief(slug, n, handoff).then((d) => { setData(d); setError(''); }, (e) => setError(errorMessage(e)));
  };
  useEffect(() => { void refresh(); }, [slug, n, handoff]);

  const act = (action: string) => run(action, async () => {
    const r = await api.briefAction(slug, n, action);
    await refresh();
    load();
    if (r.name) open(`artifact-${r.name}`, { preview: true, group });
  });
  const view = (name: string) => open(`artifact-${name}`, { preview: true, group });
  const agent = data?.agent;

  return (
    <div className="dp-tabview">
      <div className="dp-vbar">
        <Icon name="bot" size={14} />
        <span className="dp-title">Agent · {keyLabel(n)}</span>
        <span className="dp-sp" />
        <button type="button" className="dp-btn dp-sm dp-ghost" title="Render the brief again" onClick={() => void refresh()}><Icon name="refresh" size={12} />Refresh</button>
      </div>
      <div className="dp-doc">
        <div className="dp-doc-in dp-bf">
          {error ? <ErrorNote>{error}</ErrorNote> : !data ? <Loading what="Rendering the brief…" /> : (
            <>
              <div className="dp-box dp-bf-card">
                <div className="dp-bf-line">
                  <Icon name="git-branch" size={14} />
                  {data.worktree ? <span className="dp-ell">Worktree <code title={data.worktree}>{data.worktree}</code></span> : <span className="dp-t3">Branch not checked out: Start lets Paseo check it out in a new worktree.</span>}
                </div>
                <div className="dp-bf-line">
                  <Icon name="bot" size={14} />
                  {agent ? (
                    <>
                      <span className={`dp-chip${agent.status === 'running' ? ' dp-info' : ''}`}>{agent.status}</span>
                      <b className="dp-ell">{agent.name || agent.shortId}</b>
                      <span className="dp-t3 dp-xs">{agent.shortId} · {agent.created}</span>
                      <span className="dp-sp" />
                      <button type="button" className="dp-btn dp-sm dp-ghost" title="Open its transcript in a tab" onClick={() => open(`ag-${agent.id}`, { group })}><Icon name="message-square" size={12} />Open</button>
                    </>
                  ) : <span className="dp-t3">No agent in this worktree.</span>}
                </div>
                <div className="dp-bf-acts">
                  <button type="button" className={`dp-btn dp-sm${pendingClass(pending === 'save')}`} disabled={busy} onClick={() => void act('save')}><Icon name="download" size={12} />Save brief</button>
                  <button
                    type="button"
                    className={`dp-btn dp-sm dp-primary${pendingClass(pending === 'start')}`}
                    disabled={busy}
                    onClick={() => (agent ? setAsk({ action: 'start', title: 'Start another agent?', text: `An agent already sits in this worktree (${agent.shortId}). Start another one with this brief?`, go: 'Start' }) : void act('start'))}
                  ><Icon name="play" size={12} />Start agent with this brief</button>
                  {agent && (
                    <button
                      type="button"
                      className={`dp-btn dp-sm${pendingClass(pending === 'handoff')}`}
                      disabled={busy || !data.worktree}
                      title="Brief + branch state (heads, base, what landed, what is open, rebase commands) for a fresh agent in the same worktree"
                      onClick={() => setAsk({ action: 'handoff', title: 'Hand off to a fresh agent?', text: `Start a fresh agent in ${data.worktree} with a handoff from ${agent.shortId}? The old agent keeps running until you archive it.`, go: 'Hand off' })}
                    ><Icon name="send" size={12} />Handoff</button>
                  )}
                </div>
              </div>

              {linked.length > 0 && (
                <section className="dp-bf-sec">
                  <div className="dp-bf-h">Started by hand in this PR's Paseo workspace<span className="dp-t3"> · their composer has an “add work brief” pill</span></div>
                  <div className="dp-rows">
                    {linked.map((l) => (
                      <div key={l.agentId} className="dp-rowi dp-bf-row">
                        <span className={`dp-chip${l.briefAt ? ' dp-ok' : ''}`}>{l.briefAt ? 'brief sent' : 'no brief'}</span>
                        <b className="dp-ell">{l.title || l.agentId.slice(0, 8)}</b>
                        <span className="dp-sp" />
                        <span className="dp-xs dp-t3 dp-num">{l.agentId.slice(0, 8)} · linked {stamp(l.linkedAt)}{l.briefAt ? ` · brief ${stamp(l.briefAt)}` : ''}</span>
                        <button type="button" className="dp-btn dp-sm dp-ghost" title="Open its transcript in a tab" onClick={() => open(`ag-${l.agentId}`, { group })}><Icon name="message-square" size={12} />Open</button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {data.stored.length > 0 && (
                <details className="dp-run-brief dp-bf-stored">
                  <summary><Icon name="chevron-right" size={12} className="dp-run-caret" />Stored briefs<span className="dp-count">{data.stored.length}</span></summary>
                  <div className="dp-bf-list">
                    {data.stored.map((name) => (
                      <div key={name} className="dp-bf-row">
                        <Icon name="file" size={12} />
                        <code className="dp-ell" title={name}>{name}</code>
                        <span className="dp-sp" />
                        <button type="button" className="dp-btn dp-sm dp-ghost" onClick={() => view(name)}><Icon name="eye" size={12} />View</button>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <div className="dp-box dp-bf-doc">
                <div className="dp-bf-bar">
                  {data.worktree ? (
                    <span className="dp-seg">
                      <button type="button" className={handoff ? 'dp-off' : 'dp-on'} onClick={() => setHandoff(false)}>Brief</button>
                      <button type="button" className={handoff ? 'dp-on' : 'dp-off'} onClick={() => setHandoff(true)}>Handoff preview</button>
                    </span>
                  ) : <span className="dp-xs dp-t3">Brief</span>}
                  <span className="dp-xs dp-t3">{handoff ? 'what a fresh agent in this worktree would get' : 'rendered from the work'}</span>
                </div>
                <div className="dp-bf-md"><Markdown text={data.text} /></div>
              </div>
            </>
          )}
        </div>
      </div>
      {ask && (
        <Modal
          title={ask.title}
          onClose={() => setAsk(null)}
          foot={<>
            <button type="button" className="dp-btn" onClick={() => setAsk(null)}>Cancel</button>
            <button type="button" className="dp-btn dp-primary" onClick={() => { setAsk(null); void act(ask.action); }}>{ask.go}</button>
          </>}
        >
          <p className="dp-bf-ask">{ask.text}</p>
        </Modal>
      )}
    </div>
  );
}
