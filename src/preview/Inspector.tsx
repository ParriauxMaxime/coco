import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api.ts';
import DispatchMenu from '../components/DispatchMenu.tsx';
import Markdown from '../components/Markdown.tsx';
import { CodeRefRoot } from '../components/CodeRefs.tsx';
import { PendingPermissions, usePendingPermissions } from './chat/Permission.tsx';
import { focusOldestCard } from './chat/Card.tsx';
import { PersonaChip } from '../components/PersonaChip.tsx';
import GateRail from '../workbench/tabs/Gates.tsx';
import KitLine from '../workbench/tabs/KitLine.tsx';
import { briefKeyOfTab } from './BriefView.tsx';
import { openCodeAt } from '../workbench/tabs/Code.tsx';
import ReviewActivity from '../workbench/code/ReviewActivity.tsx';
import { useComments } from '../workbench/code/use-comments.ts';
import { findingsKeyOfTab, isLocalKey, keyLabel, prOfTab, reviewKeyOfTab } from '../workbench/code/ids.ts';
import type { PrKey, WorkPr } from '../workbench/types.ts';
import Icon from './Icon.tsx';
import PrChip from './PrChip.tsx';
import { AgentDot } from './AgentsSection.tsx';
import { newAgentPr } from './AgentTab.tsx';
import { STATE_LABEL, paseoLink, prLabel, stateOf, useServerId, useWorkAgent } from './agents.ts';
import { Avatar, num, stateLabel } from './parts.tsx';
import { DevServerPanel } from './widgets/DevServer.tsx';
import { agentsOf, devOf, findingsOf, pendingOf, prKey, prState, prTitle } from './data.ts';
import type { PreviewData } from './data.ts';
import { ago, sevClass, usageLine, usageTitle } from './format.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import { hostReview, requestJump, useInspector } from './inspector-state.ts';
import { isLive } from '../../server/decisions.ts';
import { openDecision, openDecisionsOf } from './DecisionsView.tsx';
import './stack.css';

const openTab = (id: string) => useWorkbench.getState().open(id);

const MAX_FINDINGS = 6;
const CI_CHIP: Record<string, { tone: string; label: string }> = { success: { tone: 'dp-ok', label: 'CI passing' }, failure: { tone: 'dp-bad', label: 'CI failing' }, pending: { tone: 'dp-warn', label: 'CI running' } };
const REVIEW_TONE: Record<string, string> = { APPROVED: 'dp-ok', CHANGES_REQUESTED: 'dp-bad' };

function userFacing(body = '') {
  const m = body.match(/## What changes for users\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (m) return m[1].trim();
  const paras = body.replace(/^>.*$/gm, '').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^PR \d+ of/.test(p) && !p.startsWith('#') && !p.startsWith('```'));
  return paras[0] || '';
}

function Sec({ title, aside, wide, children }: { title?: string; aside?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`dp-sec${wide ? ' dp-wide' : ''}`}>
      {title && <div className="dp-sec-t">{title}{aside !== undefined && <><span className="dp-sp" />{aside}</>}</div>}
      {children}
    </div>
  );
}

export function PrDetails({ d, prKey: key, asTab }: { d: PreviewData; prKey: string | null; asTab?: boolean }) {
  const [dispatching, setDispatching] = useState(false);
  const pr = key === null ? undefined : d.prs.find((p) => prKey(p) === key);
  if (!pr || key === null) return <div className="dp-ins-empty">Select a PR</div>;
  const state = prState(pr);
  const numbered = Boolean(pr.number);
  const ci = pr.ci ? CI_CHIP[pr.ci] : undefined;
  const summary = userFacing(pr.body) || pr.planned?.scope || (state === 'planned' ? 'Not opened yet. Start an agent to open it as a draft on top of the stack.' : '');
  const branch = pr.head || pr.planned?.branch;
  const agents = agentsOf(d, pr);
  const waiting = pendingOf(d, pr);
  const findings = findingsOf(d, pr);
  const dev = devOf(d, pr);
  const decisions = (d.work.w?.decisions || []).filter((x) => isLive(x) && x.pr != null && String(x.pr) === key);
  const reviewers = pr.reviewers || [];
  const owners = pr.personas || [];
  const agentStatus = (id: string) => d.overview?.agents.find((a) => a.id === id)?.status;
  return (
    <>
      <div className="dp-ins-head">
        <div className="dp-row dp-g4">
          <PrChip pr={pr} />
          <span className={`dp-chip dp-tone dp-st-${state}`}><span className="dp-d" />{stateLabel(pr)}</span>
          {ci && <span className={`dp-chip ${ci.tone}`}>{ci.label}</span>}
          <span className="dp-sp" />
          {pr.url && <a className="dp-ibtn" href={pr.url} target="_blank" rel="noreferrer" title="Open on GitHub"><Icon name="external-link" size={14} /></a>}
        </div>
        <h2>{prTitle(pr)}</h2>
        {branch && <div className="dp-row dp-g4 dp-xs dp-t3"><Icon name="git-branch" size={12} /><span className="dp-ell dp-mono">{branch}</span>{pr.base && <span>→ {pr.base}</span>}</div>}
        {numbered && (
          <div className="dp-row dp-g4" style={{ marginTop: 8 }}>
            <button type="button" className="dp-btn dp-sm dp-primary" onClick={() => openTab(`review-${pr.number}`)}><Icon name="file" size={14} />Review code</button>
            <button type="button" className="dp-btn dp-sm" onClick={() => openTab(`findings-${pr.number}`)}><Icon name="flag" size={14} />Findings</button>
            {!asTab && <button type="button" className="dp-btn dp-sm dp-ghost" title="Open as a tab  ⌘↵" onClick={() => openTab(`pr-${key}`)}>Open as tab</button>}
          </div>
        )}
      </div>
      <div className="dp-ins-scroll">
        {summary && <Sec title="Summary" wide><div className="dp-md"><Markdown text={summary} /></div></Sec>}
        {numbered && (
          <Sec>
            <dl className="dp-kv" style={{ margin: 0 }}>
              {pr.additions !== undefined && <><dt>Diff</dt><dd><span className="dp-add">+{num(pr.additions)}</span> <span className="dp-del">−{num(pr.deletions || 0)}</span>{pr.changedFiles !== undefined && ` · ${num(pr.changedFiles)} files`}</dd></>}
              {pr.sha && <><dt>Head</dt><dd><span className="dp-mono">{pr.sha.slice(0, 7)}</span>{pr.updatedAt && <span className="dp-t3"> · updated {ago(pr.updatedAt)}</span>}</dd></>}
              {pr.unresolvedThreads !== undefined && <><dt>Threads</dt><dd>{pr.unresolvedThreads ? `${pr.unresolvedThreads} unresolved` : 'none unresolved'}</dd></>}
            </dl>
          </Sec>
        )}
        {numbered && <Sec title="Review kit"><div className="dp-kit-box"><KitLine slug={d.slug} n={key} /></div></Sec>}
        {numbered && <Sec title="Gates"><div className="dp-gates-box"><GateRail slug={d.slug} n={key} onOpen={openTab} /></div></Sec>}
        {dev && <Sec title="Dev server"><DevServerPanel key={key} slug={d.slug} row={dev} onChange={d.dev.reload} /></Sec>}
        <Sec title="Owners" aside={owners.length + reviewers.length ? undefined : <span className="dp-t4" style={{ fontWeight: 400 }}>nobody yet</span>}>
          {owners.length > 0 && <div className="dp-row" style={{ flexWrap: 'wrap', marginBottom: reviewers.length ? 6 : 0 }}>{owners.map((p) => <PersonaChip key={p} login={p} href={null} />)}</div>}
          {reviewers.map((r) => (
            <div key={r.login} className="dp-person">
              <Avatar login={r.login} size="lg" />
              <span className="dp-ell">{r.login}</span>
              <span className="dp-role"><span className={`dp-chip ${REVIEW_TONE[r.state] || ''}`}>{r.state.toLowerCase().replace('_', ' ')}</span></span>
            </div>
          ))}
        </Sec>
        <Sec title="Agents" aside={agents.length ? undefined : <span className="dp-t4" style={{ fontWeight: 400 }}>none</span>}>
          {agents.map((a) => {
            const status = agentStatus(a.agentId);
            const mine = waiting.filter((w) => w.agentId === a.agentId);
            return (
              <div key={a.agentId} className="dp-agent-wrap">
                <div className="dp-agent">
                  <span className={`dp-bot${status === 'running' ? ' dp-run' : ''}`}><Icon name="bot" size={12} /></span>
                  <span className="dp-ell" title={a.title || a.label}>{a.title || a.label}</span>
                  <span className="dp-when">{[status, ago(a.linkedAt)].filter(Boolean).join(' · ')}</span>
                </div>
                {mine.length > 0 && <PendingPermissions agentId={a.agentId} />}
              </div>
            );
          })}
        </Sec>
        <Sec title="Findings" aside={findings.length ? <span className="dp-count">{findings.length}</span> : <span className="dp-t4" style={{ fontWeight: 400 }}>none open</span>}>
          {findings.slice(0, MAX_FINDINGS).map((f) => (
            <div key={f.key} className="dp-thread">
              <span className={`dp-sev ${sevClass(f.severity)}`} title={f.severity}><i /></span>
              <div>
                <div className="dp-row dp-g4"><b className="dp-sm">{f.by.name}</b>{f.path && <span className="dp-loc dp-ell">{f.path}{f.line ? `:${f.line}` : ''}</span>}</div>
                <div className="dp-t2">{f.claim || f.summary || f.body.split('\n')[0]}</div>
              </div>
            </div>
          ))}
          {findings.length > MAX_FINDINGS && <div className="dp-ins-more">+{findings.length - MAX_FINDINGS} more</div>}
        </Sec>
        {decisions.length > 0 && (
          <Sec title="Decisions" aside={<button type="button" className="dp-linkbtn" title="This PR's decisions in the Decisions view" onClick={() => openDecisionsOf(key)}>{decisions.filter((x) => x.status !== 'taken').length} open of {decisions.length}</button>}>
            {decisions.map((x) => (
              <button key={x.id} type="button" className="dp-ins-dec" title={x.question || x.title} onClick={() => openDecision(x.id)}>
                <span className={`dp-dc-dot dp-dc-${x.status === 'taken' ? 'taken' : 'open'}`} />
                <span className="dp-ell">{x.title}</span>
              </button>
            ))}
          </Sec>
        )}
      </div>
      <div className="dp-ins-actions">
        <button type="button" className="dp-btn dp-split" onClick={() => setDispatching(!dispatching)}><Icon name="bot" size={14} />Agent<Icon name="chevron-down" size={12} /></button>
        {dispatching && (
          <div className="dp-pop dp-on">
            <DispatchMenu slug={d.slug} prKey={key} personas={owners} onClose={() => setDispatching(false)} />
          </div>
        )}
      </div>
    </>
  );
}

function useGateCount(slug: string, n: PrKey) {
  const [count, setCount] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    setCount(null);
    api.gates(slug, n).then((r) => setCount({ done: r.gates.filter((g) => g.state === 'done' || g.state === 'skipped').length, total: r.gates.length }), () => {});
  }, [slug, n]);
  return count;
}

function PrLine({ d, n }: { d: PreviewData; n: PrKey }) {
  const pr = d.prs.find((p) => prKey(p) === String(n));
  const gates = useGateCount(d.slug, n);
  const ci = pr?.ci ? CI_CHIP[pr.ci] : undefined;
  const details = () => openTab(`pr-${n}`);
  return (
    <div className="dp-ins-prline">
      {pr ? <PrChip pr={pr} onOpen={details} /> : <span className="dp-prb">{keyLabel(n)}</span>}
      {pr && <span className={`dp-chip dp-tone dp-st-${prState(pr)}`}><span className="dp-d" />{stateLabel(pr)}</span>}
      {ci && <span className={`dp-chip ${ci.tone}`}>{ci.label}</span>}
      {gates && gates.total > 0 && <span className={`dp-chip${gates.done === gates.total ? ' dp-ok' : ''}`} title="Gates cleared: done or skipped">{gates.done}/{gates.total} gates</span>}
      <span className="dp-sp" />
      <button type="button" className="dp-linkbtn dp-ins-details" title="The PR's details in a tab" onClick={details}>Details</button>
    </div>
  );
}

function ReviewBody({ d, n, host }: { d: PreviewData; n: PrKey; host?: string }) {
  const rv = useComments(d.slug, n);
  const stacked = useMemo(() => d.prs.flatMap((p) => (typeof p.number === 'number' ? [p.number] : [])), [d.prs]);
  const openAt = useCallback((k: PrKey, path: string, line: number | null) => openCodeAt(d.slug, k, path, line, { group: useWorkbench.getState().otherGroup() }), [d.slug]);
  useEffect(() => {
    if (!host) return undefined;
    hostReview(host);
    return () => hostReview(null);
  }, [host]);
  return (
    <CodeRefRoot n={n} openAt={openAt} slug={d.slug} prs={stacked}>
      <PrLine d={d} n={n} />
      <div className="dp-ins-rv"><ReviewActivity slug={d.slug} n={n} rv={rv} onJump={(c) => requestJump(n, c)} /></div>
    </CodeRefRoot>
  );
}

function AgentBody({ d, tabId }: { d: PreviewData; tabId: string }) {
  const agent = useWorkAgent(d.slug, tabId);
  const serverId = useServerId(d.slug);
  const { pending } = usePendingPermissions();
  if (!agent) return <div className="dp-ins-empty">This agent is not listed in the work yet</div>;
  const state = stateOf(agent, pending);
  const paseo = d.overview?.agents.find((a) => a.id === agent.agentId);
  const model = paseo ? [paseo.provider, paseo.thinking].filter(Boolean).join(' · ') : '';
  const usage = usageLine(agent);
  const pr = agent.pr === null ? undefined : d.prs.find((p) => prKey(p) === agent.pr);
  const href = paseoLink(serverId, agent.agentId);
  return (
    <>
      <div className="dp-ins-head">
        <div className="dp-row dp-g4">
          <AgentDot state={state} />
          <span className="dp-chip">{agent.kind}</span>
        </div>
        <h2>{agent.title}</h2>
      </div>
      <div className="dp-ins-scroll">
        <Sec>
          <dl className="dp-kv" style={{ margin: 0 }}>
            <dt>Status</dt><dd>{STATE_LABEL[state]}{agent.updatedAt && <span className="dp-t3"> · {ago(agent.updatedAt)}</span>}</dd>
            {model && <><dt>Model</dt><dd className="dp-mono">{model}</dd></>}
            {usage && <><dt>Usage</dt><dd title={usageTitle(agent)}>{usage}</dd></>}
            <dt>Works on</dt>
            <dd className="dp-ins-on">
              {pr ? <><PrChip pr={pr} onOpen={(k) => openTab(`pr-${k}`)} /><span className="dp-ell">{prTitle(pr)}</span></>
                : agent.pr ? prLabel(agent.pr)
                  : <button type="button" className="dp-linkbtn dp-ins-work" onClick={() => openTab('plan')}>the whole work</button>}
            </dd>
          </dl>
        </Sec>
        <Sec title="Questions" aside={agent.openCards ? <span className="dp-count">{agent.openCards}</span> : <span className="dp-t4" style={{ fontWeight: 400 }}>none waiting</span>}>
          {agent.openCards > 0 && <button type="button" className="dp-btn dp-sm dp-ins-oldest" onClick={() => focusOldestCard(tabId)}><span className="dp-ag-dot dp-ag-waiting" />Jump to the oldest<Icon name="chevron-down" size={12} /></button>}
        </Sec>
      </div>
      {href && <div className="dp-ins-actions"><a className="dp-btn" href={href} title="Open this agent in the Paseo app"><Icon name="external-link" size={14} />Open in Paseo</a></div>}
    </>
  );
}

export type Subject = { title: string } & (
  | { kind: 'pr'; key: string | null }
  | { kind: 'review'; n: PrKey; host?: string }
  | { kind: 'agent'; tabId: string }
  | { kind: 'note'; text: string }
);

const isAgentTab = (id: string) => id.startsWith('ag-') || (id.startsWith('ask-') && !newAgentPr(id));

export function inspectorFor(tabId: string, prs: WorkPr[], selected: string | null, picked: Record<string, string | null>): Subject {
  const review = reviewKeyOfTab(tabId);
  if (review !== null) return { kind: 'review', title: 'Review activity', n: review, host: tabId };
  if (isAgentTab(tabId)) return { kind: 'agent', title: 'Agent', tabId };
  if (tabId.startsWith('pr-')) {
    const n = reviewKeyOfTab(`review-${tabId.slice(3)}`);
    const row = prs.find((p) => prKey(p) === tabId.slice(3));
    if (n !== null && (row?.number || isLocalKey(n))) return { kind: 'review', title: 'Review activity', n };
    return { kind: 'note', title: 'PR', text: 'Not opened yet: the tab holds all there is' };
  }
  const list = tabId === 'findings' || tabId === 'decisions' ? picked[tabId] : null;
  if (list) return { kind: 'pr', title: tabId === 'findings' ? 'PR of the selected finding' : 'PR of the selected decision', key: list };
  const own = prOfTab(tabId) ?? findingsKeyOfTab(tabId) ?? newAgentPr(tabId) ?? (tabId.startsWith('brief-') ? briefKeyOfTab(tabId) : null);
  if (own !== null) return { kind: 'pr', title: 'PR of this tab', key: String(own) };
  return { kind: 'pr', title: 'Selected in the stack', key: selected };
}

function Body({ d, s }: { d: PreviewData; s: Subject }) {
  if (s.kind === 'review') return <ReviewBody d={d} n={s.n} host={s.host} />;
  if (s.kind === 'agent') return <AgentBody d={d} tabId={s.tabId} />;
  if (s.kind === 'note') return <div className="dp-ins-empty">{s.text}</div>;
  return <PrDetails d={d} prKey={s.key} />;
}

export default function Inspector({ d, tabId, selected, onClose }: { d: PreviewData; tabId: string; selected: string | null; onClose: () => void }) {
  const picked = useInspector((s) => s.pickedPr);
  const subject = inspectorFor(tabId, d.prs, selected, picked);
  const key = subject.kind === 'pr' ? `pr:${subject.key}` : subject.kind === 'review' ? `rv:${subject.n}:${subject.host}` : tabId;
  return (
    <aside className="dp-inspector">
      <div className="dp-ins-bar">
        <span className="dp-ell">{subject.title}</span>
        <span className="dp-sp" />
        <button type="button" className="dp-ibtn dp-ins-close" title="Hide inspector  ⌘I" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <Body key={key} d={d} s={subject} />
    </aside>
  );
}
