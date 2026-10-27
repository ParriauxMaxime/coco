import { useState } from 'react';
import type { ReactNode } from 'react';
import DispatchMenu from '../components/DispatchMenu.tsx';
import Markdown from '../components/Markdown.tsx';
import { PendingPermissions } from './chat/Permission.tsx';
import { PersonaChip } from '../components/PersonaChip.tsx';
import GateRail from '../workbench/tabs/Gates.tsx';
import KitLine from '../workbench/tabs/KitLine.tsx';
import Icon from './Icon.tsx';
import PrChip from './PrChip.tsx';
import { Avatar, num, stateLabel } from './parts.tsx';
import { DevServerPanel } from './widgets/DevServer.tsx';
import { agentsOf, devOf, findingsOf, pendingOf, prKey, prState, prTitle } from './data.ts';
import type { PreviewData } from './data.ts';
import { ago, sevClass } from './format.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
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

export default function Inspector({ d, prKey: key, onClose, asTab }: { d: PreviewData; prKey: string | null; onClose?: () => void; asTab?: boolean }) {
  const [dispatching, setDispatching] = useState(false);
  const pr = key === null ? undefined : d.prs.find((p) => prKey(p) === key);
  const cls = `dp-inspector${asTab ? ' dp-as-tab' : ''}`;
  if (!pr || key === null) {
    return (
      <aside className={cls}>
        {onClose && <div className="dp-ins-head"><div className="dp-row dp-g4"><span className="dp-sp" /><button type="button" className="dp-ibtn" title="Hide inspector" onClick={onClose}><Icon name="x" size={14} /></button></div></div>}
        <div className="dp-ins-empty">Select a PR</div>
      </aside>
    );
  }
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
    <aside className={cls}>
      <div className="dp-ins-head">
        <div className="dp-row dp-g4">
          <PrChip pr={pr} />
          <span className={`dp-chip dp-tone dp-st-${state}`}><span className="dp-d" />{stateLabel(pr)}</span>
          {ci && <span className={`dp-chip ${ci.tone}`}>{ci.label}</span>}
          <span className="dp-sp" />
          {pr.url && <a className="dp-ibtn" href={pr.url} target="_blank" rel="noreferrer" title="Open on GitHub"><Icon name="external-link" size={14} /></a>}
          {onClose && <button type="button" className="dp-ibtn" title="Hide inspector" onClick={onClose}><Icon name="x" size={14} /></button>}
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
    </aside>
  );
}
