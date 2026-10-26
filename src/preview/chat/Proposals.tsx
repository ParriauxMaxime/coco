import React, { useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import Markdown from '../../components/Markdown.tsx';
import { toast } from '../../components/Toast.tsx';
import Icon from '../Icon.tsx';
import type { IconName } from '../Icon.tsx';
import type { Run } from './conversation.ts';
import type { AddRepoResult } from '../../types.ts';
import './chat.css';

type CardProps = { icon: IconName; kind: string; tone?: string; title: React.ReactNode; action: React.ReactNode; status: string; children?: React.ReactNode };
function Card({ icon, kind, tone = 'dp-acc', title, action, status, children }: CardProps) {
  return (
    <div className="dp-card-q dp-attn dp-prop">
      <div className="dp-cq-h">
        <span className="dp-ic"><Icon name={icon} size={14} /></span>
        <span className={`dp-chip ${tone}`}>{kind}</span>
        <span className="dp-prop-t">{title}</span>
        <span className="dp-prop-a">{status && <span className="dp-prop-s">{status}</span>}{action}</span>
      </div>
      {children && <div className="dp-cq-b dp-prop-b">{children}</div>}
    </div>
  );
}

const Fold = ({ label, children }: { label: string; children: React.ReactNode }) => <details className="dp-prop-fold"><summary><Icon name="chevron-right" size={12} />{label}</summary><div className="dp-prop-foldb">{children}</div></details>;

export function Proposal({ run, onApplied, label = 'Apply' }: { run: Run; onApplied?: (slug: string) => void; label?: string }) {
  const p = run.proposal;
  const [status, setStatus] = useState('');
  const [stackKept, setStackKept] = useState(false);
  if (!p) return null;
  const apply = async (replaceStack: boolean) => {
    setStatus('applying…');
    const r = await api.applyAsk(run.id, { replaceStack });
    setStackKept(Boolean(r.stackKept));
    setStatus(r.ok ? `${r.created ? 'created' : 'updated'} work ${r.slug}${r.stackKept ? ', stack kept' : ''}` : r.error ?? '');
    if (r.ok && r.slug && !r.stackKept) onApplied?.(r.slug);
  };
  const paseo = p.paseoProject?.existingProjectId ? `existing ${p.paseoProject.existingProjectId}` : p.paseoProject?.createNamed ? `create "${p.paseoProject.createNamed}"` : 'none';
  return (
    <Card
      icon="layers"
      kind="proposal"
      title={<><b>{p.title}</b><code>{p.slug}</code><span className="dp-chip">tier {p.tier}</span></>}
      status={status}
      action={stackKept
        ? <button type="button" className="dp-btn dp-primary dp-sm" onClick={() => apply(true)}>Replace the stack too</button>
        : <button type="button" className="dp-btn dp-primary dp-sm" onClick={() => apply(false)}><Icon name="check" size={12} />{label}</button>}
    >
      <p className="dp-prop-sum">{p.summary}</p>
      <div className="dp-prop-meta"><span>Paseo: {paseo}</span><span className="dp-t4">·</span><span>personas: {(p.personas || []).join(', ') || 'none'}</span></div>
      <div className="dp-prop-h">Planned stack</div>
      <div className="dp-rows dp-prop-stack">
        {(p.stack || []).map((s) => (
          <div key={s.order} className="dp-rowi">
            <span className="dp-prop-n">{s.order}</span>
            <span className="dp-rowi-b">
              <span><b>{s.title}</b> <span className="dp-t3">{s.scope}</span></span>
              <span className="dp-prop-line"><code>{s.branch}</code>{s.existingPr ? <span className="dp-t3">#{s.existingPr}</span> : null}{(s.personas || []).map((x) => <span key={x} className="dp-chip dp-acc">{x}</span>)}</span>
            </span>
          </div>
        ))}
      </div>
      {(p.surfaces?.length ?? 0) > 0 && (
        <>
          <div className="dp-prop-h">Surfaces</div>
          <div className="dp-box"><table className="dp-tbl"><tbody>{(p.surfaces || []).map((s, i) => <tr key={i}><td>{s.surface}</td><td><code>{s.entryPoint}</code></td><td className="dp-t2">{s.coverage}</td></tr>)}</tbody></table></div>
        </>
      )}
      {(p.openQuestions?.length ?? 0) > 0 && (
        <>
          <div className="dp-prop-h">Open questions</div>
          <ol className="dp-prop-qs">{(p.openQuestions || []).map((q, i) => <li key={i}>{q.question} <b>Recommended: {q.recommendation}.</b> <span className="dp-t3">{q.tradeoff}</span></li>)}</ol>
        </>
      )}
      <Fold label="Notes and next steps"><Markdown text={p.notes} /><ul className="dp-prop-next">{(p.nextSteps || []).map((s, i) => <li key={i}>{s}</li>)}</ul></Fold>
    </Card>
  );
}

export function AgentProposal({ run }: { run: Run }) {
  const p = run.agentProposal;
  const [status, setStatus] = useState('');
  if (!p) return null;
  const start = async () => {
    setStatus('starting…');
    const r = await api.startAskAgent(run.id);
    setStatus(r.ok ? `started ${r.agentId ? r.agentId.slice(0, 8) : ''}` : r.error ?? '');
  };
  return (
    <Card
      icon="bot"
      kind="paseo agent"
      title={<><b>{p.title}</b><span className="dp-chip">{p.provider} · {p.thinking}</span></>}
      status={status}
      action={<button type="button" className="dp-btn dp-primary dp-sm" onClick={start} disabled={status.startsWith('start')}><Icon name="play" size={12} />Start agent</button>}
    >
      <p className="dp-prop-sum">{p.why}</p>
      <div className="dp-prop-meta">{p.workspaceId ? <span>workspace <code>{p.workspaceId}</code></span> : <span>cwd <code>{p.cwd || 'the repo'}</code></span>}{p.workSlug ? <><span className="dp-t4">·</span><span>work <a href={`#/work/${p.workSlug}`}>{p.workSlug}</a></span></> : null}</div>
      <Fold label="Brief"><pre className="dp-cv-pre">{p.prompt}</pre></Fold>
    </Card>
  );
}

export function DispatchProposal({ run }: { run: Run }) {
  const p = run.dispatchProposal;
  const [status, setStatus] = useState('');
  if (!p) return null;
  const confirm = async () => {
    setStatus('dispatching…');
    const r = await api.askDispatch(run.id).catch((e) => ({ ok: false, error: errorMessage(e), out: '' }));
    setStatus(r.ok ? r.out || 'started' : r.error ?? '');
  };
  const pr = p.pr == null ? 'the whole work' : /^\d+$/.test(String(p.pr)) ? `#${p.pr}` : String(p.pr).slice(2).replaceAll(':', '/');
  return (
    <Card
      icon="send"
      kind="dispatch"
      title={<><b>{p.entry}</b><span>on {pr}</span>{p.persona ? <span>as <code>{p.persona}</code></span> : null}{p.edits ? <span className="dp-chip">on the branch</span> : null}</>}
      status={status}
      action={<button type="button" className="dp-btn dp-primary dp-sm" onClick={confirm} disabled={status === 'dispatching…' || status.startsWith('started')}>Confirm</button>}
    >
      {p.why && <p className="dp-prop-sum">{p.why}</p>}
      {p.prompt && <Fold label="Prompt"><pre className="dp-cv-pre">{p.prompt}</pre></Fold>}
    </Card>
  );
}

export const repoAdded = (r: AddRepoResult) => [
  `${r.repo?.name} ${r.how === 'cloned' ? 'cloned into' : r.how === 'found' ? 'found at' : 'at'} ${r.repo?.path}`,
  r.project?.error ? `no Paseo project: ${r.project.error}` : r.project ? `Paseo project ${r.project.name}` : null,
  r.setup?.error ? `setup run failed: ${r.setup.error}` : r.setup?.agentId ? `setup run ${r.setup.agentId.slice(0, 8)} proposes its config` : null,
].filter(Boolean).join(' · ');

// adds the repo, then opens its page: the overview reload that comes with the route shows its sidebar section
export async function addRepoAndOpen(add: () => Promise<AddRepoResult>) {
  const r = await add();
  toast.success(repoAdded(r));
  if (r.repo) location.hash = `#/repo/${r.repo.id}`;
  return r;
}

export function RepoProposal({ run }: { run: Run }) {
  const p = run.repoProposal;
  const [status, setStatus] = useState('');
  if (!p) return null;
  const confirm = async () => {
    setStatus('adding…');
    await addRepoAndOpen(() => api.askAddRepo(run.id)).then(() => setStatus('added'), (e) => setStatus(errorMessage(e)));
  };
  return (
    <Card
      icon="git-branch"
      kind="new repo"
      tone="dp-info"
      title={<code>{p.source}</code>}
      status={status}
      action={<button type="button" className="dp-btn dp-primary dp-sm" onClick={confirm} disabled={status === 'adding…' || status === 'added'}><Icon name="plus" size={12} />Add repo</button>}
    >
      {p.why && <p className="dp-prop-sum">{p.why}</p>}
      <div className="dp-prop-meta">coco reuses a clone already on disk or clones it, lists it in your config, adds its Paseo project and starts a setup run proposing its config.</div>
    </Card>
  );
}

// the cards a conversation may end on
export function Proposals({ run, onApplied, label }: { run: Run; onApplied?: (slug: string) => void; label?: string }) {
  return (
    <div className="dp-ag-cards">
      <Proposal run={run} onApplied={onApplied} label={label} />
      <AgentProposal run={run} />
      <DispatchProposal run={run} />
      <RepoProposal run={run} />
    </div>
  );
}
