import { useState } from 'react';
import Markdown from '../components/Markdown.tsx';
import Blocks from '../components/Blocks.tsx';
import { PendingPermissions } from '../components/PermissionCard.tsx';
import Icon from './Icon.tsx';
import PrChip, { prLabel } from './PrChip.tsx';
import { SEVERITIES, ago, sevClass, sevTone, stamp } from './format.ts';
import { prKey, prState, prTitle } from './data.ts';
import type { PreviewData } from './data.ts';
import type { WhatsNextData, WorkPr } from '../workbench/types.ts';
import './overview.css';

const STATES = ['merged', 'approved', 'changes', 'review', 'draft', 'planned', 'closed'];
const STATE_WORD: Record<string, string> = { merged: 'merged', approved: 'approved', changes: 'changes requested', review: 'in review', draft: 'draft', planned: 'planned', closed: 'closed' };
const OPEN_STATES = ['draft', 'review', 'approved', 'changes'];
const CI_TONE: Record<string, string> = { success: 'dp-ok', failure: 'dp-bad', pending: 'dp-warn' };
const CI_WORD: Record<string, string> = { success: 'green', failure: 'failing', pending: 'running' };
const KIND_TONE: Record<string, string> = { github: 'dp-info', coco: 'dp-acc', review: 'dp-acc', decision: 'dp-ok' };

const isWhatsNext = (x: unknown): x is WhatsNextData => typeof x === 'object' && x !== null;

const actionFor = (pr: WorkPr) => {
  const s = prState(pr);
  if (s === 'changes') return `Address the requested changes${pr.reviewers?.length ? ` (${pr.reviewers.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.login).join(', ')})` : ''}`;
  if (s === 'draft') return 'Finish and mark ready for review';
  if (s === 'approved') return 'Merge it';
  if (s === 'review') return pr.ci === 'failure' ? 'Waiting for review, CI is red' : 'Waiting for review';
  return 'Open the PR';
};

function Next({ prs, onOpenPr }: { prs: WorkPr[]; onOpenPr: (key: string) => void }) {
  const first = prs.find((p) => !['merged', 'closed'].includes(prState(p)));
  if (!first) return <div className="dp-next"><span className="dp-nl">NEXT</span><div className="dp-grow">Stack complete.</div></div>;
  const planned = prState(first) === 'planned';
  return (
    <div className="dp-next">
      <span className="dp-nl">NEXT</span>
      <div className="dp-grow">
        {planned ? <>{prTitle(first)}: not opened yet.</> : <><PrChip pr={first} /> {actionFor(first)}. <span className="dp-t2">{prTitle(first)}</span></>}
      </div>
      {!planned && <button type="button" className="dp-btn dp-sm dp-primary" onClick={() => onOpenPr(prKey(first))}>Open</button>}
    </div>
  );
}

export default function OverviewView({ d, onOpenPr, onOpenTab }: { d: PreviewData; onOpenPr: (key: string) => void; onOpenTab: (tab: 'stack' | 'findings' | 'ask') => void }) {
  const [full, setFull] = useState(false);
  const w = d.work.w;
  if (!w) return <div className="dp-doc"><div className="dp-doc-in dp-t3">{d.work.err || 'Loading…'}</div></div>;

  const prs = d.prs;
  const counts = prs.reduce<Record<string, number>>((acc, p) => ((acc[prState(p)] = (acc[prState(p)] || 0) + 1), acc), {});
  const diff = prs.reduce((acc, p) => ({ add: acc.add + (p.additions || 0), del: acc.del + (p.deletions || 0), files: acc.files + (p.changedFiles || 0) }), { add: 0, del: 0, files: 0 });
  const restack = d.overview?.works.find((x) => x.slug === d.slug)?.progress.restack;
  const lead = w.summary || w.description;
  const next = isWhatsNext(w.next) && (w.next.summary || w.next.blocks?.length) ? w.next : null;

  const agentIds = Array.from(new Set(d.agents.map((a) => a.agentId)));
  const waiting = d.pending.filter((p) => agentIds.includes(p.agentId));

  const left = d.findings?.left || ['new', 'open', 'sent', 'outdated'];
  const openFindings = (d.findings?.rows || []).filter((r) => left.includes(r.status));
  const bySeverity = SEVERITIES.map((s) => [s, openFindings.filter((r) => r.severity === s).length] as const).filter(([, n]) => n);
  const unrated = openFindings.filter((r) => !SEVERITIES.includes(r.severity || '')).length;

  const openPrs = prs.filter((p) => OPEN_STATES.includes(prState(p)));
  const timeline = [...(w.timeline || [])].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 6);
  const decisions = (w.decisions || []).filter((x) => !x.decidedAt && !x.choice && !x.archivedAt);
  const links = w.links || [];
  const personas = w.personas || [];

  return (
    <div className="dp-doc">
      <div className="dp-doc-in">
        <div className="dp-row" style={{ alignItems: 'flex-start' }}>
          <div className="dp-grow">
            <div className="dp-row dp-g4 dp-xs dp-t3 dp-ov-meta">
              <Icon name="folder" size={12} />
              {w.projectName && <>{w.projectName}<span className="dp-t4">·</span></>}
              {w.tier && <>{w.tier} tier<span className="dp-t4">·</span></>}
              {w.updatedAt && <>updated {stamp(w.updatedAt)}</>}
            </div>
            <h1 className="dp-h1">{w.title}</h1>
          </div>
          <button type="button" className="dp-btn dp-sm" onClick={() => onOpenTab('stack')}><Icon name="layers" size={14} />Stack</button>
          <button type="button" className="dp-btn dp-sm" onClick={() => onOpenTab('ask')}><Icon name="message-square" size={14} />Ask coco{d.asks.length > 0 && <span className="dp-count">{d.asks.length}</span>}</button>
        </div>
        {lead && <div className="dp-lead"><Markdown text={lead} /></div>}
        {w.summary && w.description && w.description !== w.summary && (
          <div className="dp-row dp-xs dp-ov-more">
            <button type="button" className="dp-linkbtn" onClick={() => setFull(!full)}>{full ? 'Hide the full description' : 'Read the full description'}</button>
          </div>
        )}
        {full && <div className="dp-ov-desc"><Markdown text={w.description} /></div>}

        <div className="dp-cols" style={{ marginTop: 20 }}>
          <div>
            <div className="dp-block">
              <div className="dp-h2">Progress{diff.files > 0 && <span className="dp-meta dp-num">+{diff.add.toLocaleString()} −{diff.del.toLocaleString()} · {diff.files.toLocaleString()} files</span>}</div>
              {prs.length > 0 ? (
                <div className="dp-segs">{prs.map((p) => <i key={prKey(p)} className={`dp-st-${prState(p)}`} title={`${prLabel(p)} ${prTitle(p)}`} />)}</div>
              ) : <div className="dp-t3 dp-sm">No PR in this stack yet.</div>}
              <div className="dp-legend" style={{ marginTop: 8 }}>
                {STATES.filter((s) => counts[s]).map((s) => <span key={s}><i className={`dp-dot dp-st-${s}${s === 'planned' ? ' dp-hollow' : ''}`} />{counts[s]} {STATE_WORD[s]}</span>)}
                <span className="dp-sp" />
                {restack && <span className="dp-chip dp-warn"><Icon name="alert-triangle" size={12} />Restack needed</span>}
              </div>
            </div>
            <Next prs={prs} onOpenPr={onOpenPr} />

            {next && (
              <div className="dp-block" style={{ marginTop: 16 }}>
                <div className="dp-h2">What’s next for you<span className="dp-meta">{[next.by, next.at && stamp(next.at)].filter(Boolean).join(' · ')}</span></div>
                {next.summary && <div className="dp-ov-nextsum"><Markdown text={next.summary} /></div>}
                {next.blocks && next.blocks.length > 0 && <Blocks blocks={next.blocks} />}
              </div>
            )}

            {waiting.length > 0 && (
              <div className="dp-block">
                <div className="dp-h2">Waiting on you<span className="dp-count dp-acc">{waiting.length}</span></div>
                <div className="dp-ov-wait">
                  {agentIds.filter((id) => waiting.some((p) => p.agentId === id)).map((id) => <PendingPermissions key={id} agentId={id} withWhere />)}
                </div>
              </div>
            )}

            {openPrs.length > 0 && (
              <div className="dp-block">
                <div className="dp-h2">Open PRs<span className="dp-meta">{openPrs.length} waiting for your call</span></div>
                <div className="dp-box">
                  <table className="dp-tbl">
                    <thead><tr><th>PR</th><th>What it does</th><th>CI</th><th>Your action</th></tr></thead>
                    <tbody>
                      {openPrs.map((p) => (
                        <tr key={prKey(p)} className="dp-ov-row" onClick={() => onOpenPr(prKey(p))}>
                          <td><PrChip pr={p} /></td>
                          <td>{prTitle(p)}</td>
                          <td>{p.ci && CI_WORD[p.ci] ? <span className={`dp-chip ${CI_TONE[p.ci]}`}>{CI_WORD[p.ci]}</span> : <span className="dp-t4">–</span>}</td>
                          <td className="dp-t2">{actionFor(p)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="dp-block">
              <div className="dp-h2">Open findings<span className="dp-meta"><button type="button" className="dp-linkbtn" onClick={() => onOpenTab('findings')}>Open the board</button></span></div>
              {openFindings.length === 0 ? <div className="dp-t3 dp-sm">Nothing open.</div> : (
                <div className="dp-row dp-g4" style={{ flexWrap: 'wrap' }}>
                  {bySeverity.map(([s, n]) => <span key={s} className={`dp-chip ${sevTone(s)}`}><span className={`dp-sev ${sevClass(s)} dp-ov-sev`}><i /></span>{n} {s}</span>)}
                  {unrated > 0 && <span className="dp-chip">{unrated} unrated</span>}
                </div>
              )}
            </div>

            {decisions.length > 0 && (
              <div className="dp-block">
                <div className="dp-h2">Open decisions<span className="dp-meta dp-num">{decisions.length}</span></div>
                <ul className="dp-ov-list">
                  {decisions.map((x) => <li key={x.id}><Icon name="scale" size={14} /><span className="dp-grow dp-ell">{x.title}</span>{x.options.length > 0 && <span className="dp-xs dp-t3">{x.options.length} options</span>}</li>)}
                </ul>
              </div>
            )}

            {timeline.length > 0 && (
              <div className="dp-block">
                <div className="dp-h2">Recent activity</div>
                <ul className="dp-ov-list">
                  {timeline.map((t, i) => (
                    <li key={i}>
                      <span className={`dp-chip ${KIND_TONE[t.kind] || ''}`}>{t.kind}</span>
                      <span className="dp-grow dp-ell" title={t.text}>{t.text}</span>
                      <span className="dp-xs dp-t3 dp-num">{ago(t.ts)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <aside className="dp-ov-side">
            <div className="dp-side-sec">
              <div className="dp-sec-t">Links</div>
              {links.length === 0 && <div className="dp-t3 dp-sm">No link yet.</div>}
              {links.map((l) => <a key={l.url} className="dp-lnk" href={l.url} target="_blank" rel="noreferrer"><Icon name="external-link" size={14} /><span className="dp-ell">{l.label || l.url}</span></a>)}
            </div>
            {personas.length > 0 && (
              <div className="dp-side-sec">
                <div className="dp-sec-t">Reviewers</div>
                {personas.map((login) => (
                  <div key={login} className="dp-person">
                    <span className="dp-av dp-lg">{login.slice(0, 1).toUpperCase()}<img src={`/api/avatar/${login}`} alt="" onError={(e) => e.currentTarget.remove()} /></span>
                    <span className="dp-ell">{login}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="dp-side-sec">
              <div className="dp-sec-t">Facts</div>
              <dl className="dp-kv" style={{ margin: 0, gridTemplateColumns: '84px 1fr' }}>
                {w.createdAt && <><dt>Started</dt><dd>{stamp(w.createdAt)}</dd></>}
                <dt>PRs</dt><dd>{prs.length}</dd>
                <dt>Decisions</dt><dd>{(w.decisions || []).length - decisions.length} taken{decisions.length > 0 && `, ${decisions.length} open`}</dd>
                <dt>Agents</dt><dd>{d.agents.length ? `${d.agents.length} linked` : 'none linked'}</dd>
              </dl>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
