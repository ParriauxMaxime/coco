import React, { useState } from 'react';
import Markdown from '../components/Markdown.tsx';
import Blocks from '../components/Blocks.tsx';
import WaitingList from './WaitingList.tsx';
import Icon from './Icon.tsx';
import NewAgentMenu from './NewAgentMenu.tsx';
import PrChip, { prLabel } from './PrChip.tsx';
import { SEVERITIES, ago, sevClass, sevTone, stamp } from './format.ts';
import { isDone, prKey, prState, prTitle } from './data.ts';
import DriftPanel from '../workbench/tabs/DriftPanel.tsx';
import { DevServersLine, DevServersList } from './widgets/DevServer.tsx';
import { openDecision } from './DecisionsView.tsx';
import { PrDetails } from './Inspector.tsx';
import { stateLabel } from './parts.tsx';
import { workHref } from './prefs.ts';
import NavLevels, { NavRow } from './nav/NavLevels.tsx';
import type { Level } from './nav/NavLevels.tsx';
import { useNav } from './nav/use-nav.ts';
import type { PreviewData } from './data.ts';
import type { WhatsNextData, WorkPr } from '../workbench/types.ts';
import type { SpunOffWork, WorkSummary } from '../types.ts';
import './overview.css';

const STATES = ['merged', 'landed', 'approved', 'changes', 'review', 'draft', 'planned', 'closed'];
const STATE_WORD: Record<string, string> = { merged: 'merged', landed: 'landed', approved: 'approved', changes: 'changes requested', review: 'in review', draft: 'draft', planned: 'planned', closed: 'closed' };
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
  const first = prs.find((p) => !isDone(prState(p)));
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

const stackWord = (s?: WorkSummary) => {
  if (!s?.stack) return 'no PR yet';
  const p = s.progress;
  return p.merged + p.landed ? `${p.merged + p.landed}/${s.stack - p.closed} ${p.merged ? 'merged' : 'landed'}` : p.ready + p.draft ? `${p.ready + p.draft} open` : `${p.planned} planned`;
};

// works an agent of this one created: their state and What's next, read live from each
function SpunOff({ list, summaries }: { list: SpunOffWork[]; summaries: WorkSummary[] }) {
  return (
    <div className="dp-block">
      <div className="dp-h2">Spun-off works<span className="dp-count">{list.length}</span></div>
      <ul className="dp-ov-spun">
        {list.map((c) => (
          <li key={c.slug}>
            <div className="dp-row dp-g6">
              <Icon name="git-fork" size={14} />
              <a className="dp-grow dp-ell" href={workHref(c.slug)}>{c.title}</a>
              <span className={`dp-chip${c.archived ? '' : ' dp-info'}`}>{c.archived ? 'archived' : stackWord(summaries.find((s) => s.slug === c.slug))}</span>
            </div>
            <div className="dp-ov-spun-next">{c.next ? <><span className="dp-t3">Next{c.nextAt && ` · ${ago(c.nextAt)}`}: </span><Markdown text={c.next} /></> : <span className="dp-t3">No What’s next yet.</span>}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Section = { key: string; label: string; icon: React.ComponentProps<typeof Icon>['name']; sub: string; count?: number; tone?: string; body: React.ReactNode };

export default function OverviewView({ d, onOpenPr, onOpenTab }: { d: PreviewData; onOpenPr: (key: string) => void; onOpenTab: (tab: 'stack' | 'findings' | 'decisions' | 'ask') => void }) {
  const [full, setFull] = useState(false);
  const nav = useNav();
  const w = d.work.w;
  if (!w) return <div className="dp-doc"><div className="dp-doc-in dp-t3">{d.work.err || 'Loading…'}</div></div>;

  const prs = d.prs;
  const counts = prs.reduce<Record<string, number>>((acc, p) => ((acc[prState(p)] = (acc[prState(p)] || 0) + 1), acc), {});
  const diff = prs.reduce((acc, p) => ({ add: acc.add + (p.additions || 0), del: acc.del + (p.deletions || 0), files: acc.files + (p.changedFiles || 0) }), { add: 0, del: 0, files: 0 });
  const restack = d.overview?.works.find((x) => x.slug === d.slug)?.progress.restack;
  const lead = w.summary || w.description;
  const next = isWhatsNext(w.next) && (w.next.summary || w.next.blocks?.length) ? w.next : null;

  const waiting = d.waiting;

  const left = d.findings?.left || ['new', 'open', 'sent', 'outdated'];
  const openFindings = (d.findings?.rows || []).filter((r) => left.includes(r.status));
  const bySeverity = SEVERITIES.map((s) => [s, openFindings.filter((r) => r.severity === s).length] as const).filter(([, n]) => n);
  const unrated = openFindings.filter((r) => !SEVERITIES.includes(r.severity || '')).length;

  const openPrs = prs.filter((p) => OPEN_STATES.includes(prState(p)));
  const timeline = [...(w.timeline || [])].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 6);
  const decisions = (w.decisions || []).filter((x) => !x.decidedAt && !x.choice && !x.archivedAt);
  const links = w.links || [];
  const personas = w.personas || [];

  const head = (
    <>
      <div className="dp-row" style={{ alignItems: 'flex-start' }}>
        <div className="dp-grow">
          <div className="dp-row dp-g4 dp-xs dp-t3 dp-ov-meta">
            <Icon name="folder" size={12} />
            {w.projectName && <>{w.projectName}<span className="dp-t4">·</span></>}
            {w.parentWork && <>from <a href={workHref(w.parentWork.slug)} title="The work whose agent created this one">{w.parentWork.title}</a><span className="dp-t4">·</span></>}
            {w.tier && <>{w.tier} tier<span className="dp-t4">·</span></>}
            {w.updatedAt && <>updated {stamp(w.updatedAt)}</>}
          </div>
          <h1 className="dp-h1">{w.title}</h1>
        </div>
        <button type="button" className="dp-btn dp-sm" onClick={() => onOpenTab('stack')}><Icon name="layers" size={14} />Stack</button>
        <NewAgentMenu onAsk={() => onOpenTab('ask')} place={`work:${w.slug}`} />
      </div>
      {lead && <div className="dp-lead"><Markdown text={lead} /></div>}
      {w.summary && w.description && w.description !== w.summary && (
        <div className="dp-row dp-xs dp-ov-more">
          <button type="button" className="dp-linkbtn" onClick={() => setFull(!full)}>{full ? 'Hide the full description' : 'Read the full description'}</button>
        </div>
      )}
      {full && <div className="dp-ov-desc"><Markdown text={w.description} /></div>}
    </>
  );
  const progress = (
    <div className="dp-block">
      <div className="dp-h2">Progress{diff.files > 0 && <span className="dp-meta dp-num">+{diff.add.toLocaleString()} −{diff.del.toLocaleString()} · {diff.files.toLocaleString()} files</span>}</div>
      {prs.length > 0 ? (
        <div className="dp-segs">{prs.map((p) => <i key={prKey(p)} className={`dp-st-${prState(p)}`} title={`${prLabel(p)} ${prTitle(p)}`} />)}</div>
      ) : <div className="dp-t3 dp-sm">No PR in this stack yet.</div>}
      <div className="dp-legend" style={{ marginTop: 8 }}>
        {STATES.filter((s) => counts[s]).map((s) => <span key={s}><i className={`dp-dot dp-st-${s}${s === 'planned' ? ' dp-hollow' : ''}`} />{counts[s]} {STATE_WORD[s]}</span>)}
        <span className="dp-sp" />
        {restack && <button type="button" className="dp-chip dp-warn dp-chip-btn" title="Open the stack to restack" onClick={() => onOpenTab('stack')}><Icon name="alert-triangle" size={12} />Restack needed</button>}
      </div>
    </div>
  );
  const whatsNext = next && (
    <div className="dp-block" style={{ marginTop: 16 }}>
      <div className="dp-h2">What’s next for you<span className="dp-meta">{[next.by, next.at && stamp(next.at)].filter(Boolean).join(' · ')}</span></div>
      {next.summary && <div className="dp-ov-nextsum"><Markdown text={next.summary} /></div>}
      {next.blocks && next.blocks.length > 0 && <Blocks blocks={next.blocks} />}
    </div>
  );
  const waitingBlock = waiting.length > 0 && (
    <div className="dp-block">
      <div className="dp-h2">Waiting on you<span className="dp-count dp-acc">{waiting.length}</span></div>
      <div className="dp-ov-wait"><WaitingList items={waiting} /></div>
    </div>
  );
  const openPrsBlock = openPrs.length > 0 && (
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
  );
  const findingsBlock = (
    <div className="dp-block">
      <div className="dp-h2">Open findings<span className="dp-meta"><button type="button" className="dp-linkbtn" onClick={() => onOpenTab('findings')}>Open the board</button></span></div>
      {openFindings.length === 0 ? <div className="dp-t3 dp-sm">Nothing open.</div> : (
        <div className="dp-row dp-g4" style={{ flexWrap: 'wrap' }}>
          {bySeverity.map(([s, n]) => <span key={s} className={`dp-chip ${sevTone(s)}`}><span className={`dp-sev ${sevClass(s)} dp-ov-sev`}><i /></span>{n} {s}</span>)}
          {unrated > 0 && <span className="dp-chip">{unrated} unrated</span>}
        </div>
      )}
    </div>
  );
  const decisionsBlock = decisions.length > 0 && (
    <div className="dp-block">
      <div className="dp-h2">Open decisions<span className="dp-meta dp-num">{decisions.length} · <button type="button" className="dp-linkbtn" onClick={() => onOpenTab('decisions')}>Open the board</button></span></div>
      <ul className="dp-ov-list">
        {decisions.map((x) => (
          <li key={x.id}>
            <button type="button" className="dp-ov-decb" title="Open this decision" onClick={() => openDecision(x.id)}>
              <Icon name="scale" size={14} /><span className="dp-grow dp-ell">{x.title}</span>{x.options.length > 0 && <span className="dp-xs dp-t3">{x.rows ? `${x.rows.length} rows` : `${x.options.length} options`}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
  const activityBlock = timeline.length > 0 && (
    <div className="dp-block">
      <div className="dp-h2">Recent activity</div>
      <ul className="dp-ov-list">
        {timeline.map((t, i) => (
          <li key={i}>
            <span className={`dp-chip ${KIND_TONE[t.kind] || ''}`}>{t.kind}</span>
            {t.link ? <a className="dp-grow dp-ell" href={t.link} title={t.text}>{t.text}</a> : <span className="dp-grow dp-ell" title={t.text}>{t.text}</span>}
            <span className="dp-xs dp-t3 dp-num">{ago(t.ts)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
  const side = (
    <>
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
          {w.lessons && <><dt>Lessons</dt><dd><a href={`#/repo/${w.lessons.repo}/lessons`} title="The repo's brief lessons: what agent briefs learned from your follow-ups">{w.lessons.count}</a></dd></>}
          <dt>Dev servers</dt><dd><DevServersLine data={d.dev.data} /></dd>
        </dl>
      </div>
      {d.dev.data?.on && (
        <div className="dp-side-sec">
          <div className="dp-sec-t" title="What an agent of this work gets when it needs a dev server: a running one it reuses, a warm build, or a cold start">Dev servers for agents</div>
          <DevServersList data={d.dev.data} slug={d.slug} onChange={d.dev.reload} />
        </div>
      )}
    </>
  );

  const classic = (
    <div className="dp-doc">
      <div className="dp-doc-in">
        {head}

        <div className="dp-cols" style={{ marginTop: 20 }}>
          <div>
            {progress}
            <Next prs={prs} onOpenPr={onOpenPr} />
            <DriftPanel slug={d.slug} />

            {whatsNext}

            {w.spunOff && w.spunOff.length > 0 && <SpunOff list={w.spunOff} summaries={d.overview?.works || []} />}

            {waitingBlock}

            {openPrsBlock}

            {findingsBlock}

            {decisionsBlock}

            {activityBlock}
          </div>

          <aside className="dp-ov-side">
            {side}
          </aside>
        </div>
      </div>
    </div>
  );

  // a beta navigation mode: the work's head, then one summary row per part of the page; open PRs go one level further, to the PR's details
  const sections: Section[] = [
    { key: 'progress', label: 'Progress', icon: 'layers', sub: STATES.filter((s) => counts[s]).map((s) => `${counts[s]} ${STATE_WORD[s]}`).join(' · ') || 'No PR yet', tone: restack ? 'restack needed' : undefined, body: <>{progress}<Next prs={prs} onOpenPr={onOpenPr} /><DriftPanel slug={d.slug} /></> },
    ...(next ? [{ key: 'next', label: 'What’s next for you', icon: 'sparkles' as const, sub: next.summary?.split('\n')[0] || [next.by, next.at && stamp(next.at)].filter(Boolean).join(' · '), body: whatsNext }] : []),
    ...(waiting.length ? [{ key: 'waiting', label: 'Waiting on you', icon: 'clock' as const, sub: waiting.slice(0, 2).map((x) => x.title).join(' · '), count: waiting.length, tone: 'acc', body: waitingBlock }] : []),
    ...(openPrs.length ? [{ key: 'prs', label: 'Open PRs', icon: 'git-pull-request' as const, sub: `${openPrs.length} waiting for your call`, count: openPrs.length, body: null }] : []),
    { key: 'findings', label: 'Open findings', icon: 'flag', sub: openFindings.length ? [...bySeverity.map(([s, n]) => `${n} ${s}`), ...(unrated ? [`${unrated} unrated`] : [])].join(' · ') : 'Nothing open', count: openFindings.length || undefined, body: findingsBlock },
    ...(decisions.length ? [{ key: 'decisions', label: 'Open decisions', icon: 'scale' as const, sub: decisions.slice(0, 2).map((x) => x.title).join(' · '), count: decisions.length, body: decisionsBlock }] : []),
    ...(w.spunOff?.length ? [{ key: 'spun', label: 'Spun-off works', icon: 'git-fork' as const, sub: w.spunOff.map((c) => c.title).join(' · '), count: w.spunOff.length, body: <SpunOff list={w.spunOff} summaries={d.overview?.works || []} /> }] : []),
    ...(timeline.length ? [{ key: 'activity', label: 'Recent activity', icon: 'history' as const, sub: timeline[0].text, body: activityBlock }] : []),
    { key: 'about', label: 'Links and facts', icon: 'folder', sub: [`${links.length} link${links.length === 1 ? '' : 's'}`, personas.length && `${personas.length} reviewer${personas.length === 1 ? '' : 's'}`, d.agents.length && `${d.agents.length} agents`].filter(Boolean).join(' · '), body: <div className="dp-ov-side">{side}</div> },
  ];
  const section = sections.find((s) => s.key === nav.path[0]);
  const pr = section?.key === 'prs' ? openPrs.find((p) => prKey(p) === nav.path[1]) : undefined;
  const prRows = (child: (key: string) => React.ReactNode) => openPrs.map((p) => (
    <React.Fragment key={prKey(p)}>
      <NavRow on={nav.path[1] === prKey(p)} onOpen={() => nav.open(1, prKey(p), true)} className={`dp-st-${prState(p)}`} icon={<span className="dp-dot" />} title={prTitle(p)} sub={[prLabel(p), stateLabel(p), actionFor(p)].join(' · ')} meta={p.ci && CI_WORD[p.ci] ? <span className={`dp-chip ${CI_TONE[p.ci]}`}>{CI_WORD[p.ci]}</span> : null} />
      {child(prKey(p))}
    </React.Fragment>
  ));
  const levels: Level[] = [
    {
      key: 'plan',
      label: 'Overview',
      render: (child) => (
        <div className="dp-ov-nav">
          <div className="dp-ov-navhead">{head}</div>
          <div className="dp-nlist">
            {sections.map((s) => (
              <React.Fragment key={s.key}>
                <NavRow
                  on={nav.path[0] === s.key}
                  onOpen={() => nav.open(0, s.key, true)}
                  icon={<Icon name={s.icon} size={16} />}
                  title={s.label}
                  sub={s.sub}
                  meta={<>{s.tone && s.tone !== 'acc' && <span className="dp-chip dp-warn">{s.tone}</span>}{s.count !== undefined && <span className={`dp-count${s.tone === 'acc' ? ' dp-acc' : ''}`}>{s.count}</span>}</>}
                />
                {child(s.key)}
              </React.Fragment>
            ))}
          </div>
        </div>
      ),
    },
    ...(section ? [{ key: section.key, label: section.label, render: (child: (key: string) => React.ReactNode) => (section.key === 'prs' ? <div className="dp-nlist">{prRows(child)}</div> : <div className="dp-ndetail dp-ov-navsec">{section.body}</div>) }] : []),
    ...(pr ? [{ key: prKey(pr), label: `${prLabel(pr)} ${prTitle(pr)}`, render: () => <aside className="dp-inspector dp-as-tab dp-nav-pr"><PrDetails d={d} prKey={prKey(pr)} asTab /></aside> }] : []),
  ];
  return <NavLevels classic={classic} levels={levels} />;
}
