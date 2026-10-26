import React, { useState } from 'react';
import { PersonaChip } from '../../components/PersonaChip.tsx';
import { api } from '../../api.ts';
import { useAction, pendingClass } from '../../components/action.ts';
import { toast } from '../../components/Toast.tsx';
import Markdown from '../../components/Markdown.tsx';
import Blocks from '../../components/Blocks.tsx';
import Collapsible from '../../components/Collapsible.tsx';
import { useWork } from '../use-work.ts';
import { useWorkbench } from '../workbench-store.ts';
import { StackFixCard } from '../code/StackFix.tsx';
import GateRail from './Gates.tsx';
import StackKeeper from './StackKeeper.tsx';
import KitLine from './KitLine.tsx';
import { DevServerRow, DevServersSummary, useDevServers } from './DevServers.tsx';
import type { DevServerRowData, DevServersResponse, PersonaSuggestion, StackRow, WorkDetail } from '../../types.ts';
import type { NotionState, PrKey, WhatsNextData, WorkPr } from '../types.ts';

const STATE_LABELS: Record<string, string> = { merged: 'merged', closed: 'closed', draft: 'draft', approved: 'approved', changes: 'changes requested', ready: 'in review', planned: 'planned' };
const isWhatsNext = (x: unknown): x is WhatsNextData => typeof x === 'object' && x !== null;

const CI_CHIPS: Record<string, string> = { success: 'c-green', failure: 'c-red', pending: 'c-orange', none: 'c-grey' };
const ciChip = (ci?: string) => (ci && CI_CHIPS[ci]) || 'c-grey';
const stateKey = (pr: WorkPr) => (pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : !pr.number ? 'planned' : pr.isDraft ? 'draft' : pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'ready');
const FOLDED_STATES = ['merged', 'closed', 'planned'];
export const stateChip = (pr: WorkPr) => `st-chip st-${stateKey(pr)}`;
export const stateLabel = (pr: WorkPr) => STATE_LABELS[stateKey(pr)];

function userFacing(body = '') {
  const m = body.match(/## What changes for users\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (m) return m[1].trim();
  const paras = body.replace(/^>.*$/gm, '').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^PR \d+ of/.test(p) && !p.startsWith('#') && !p.startsWith('```'));
  return paras[0] || '';
}
function nextAction(prs: WorkPr[]) {
  const first = prs.find((p) => !['merged', 'closed'].includes(stateKey(p)));
  if (!first) return 'Stack complete.';
  const k = stateKey(first);
  if (k === 'changes') return `#${first.number}: address the requested changes (${(first.reviewers || []).filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.login).join(', ')}).`;
  if (k === 'draft') return `#${first.number}: finish and mark ready for review.`;
  if (k === 'approved') return `#${first.number}: approved, merge it (CI ${first.ci}).`;
  if (k === 'ready') return `#${first.number}: waiting for review${first.ci === 'failure' ? ', CI red' : ''}.`;
  return `${first.planned?.title || 'next PR'}: not opened yet.`;
}
const favicon = (url: string) => { try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`; } catch { return ''; } };

function PersonaChips({ work, pr, index, onChange }: { work: WorkDetail; pr: WorkPr; index: number; onChange: (stack: StackRow[]) => void }) {
  const [suggest, setSuggest] = useState<PersonaSuggestion | '…' | null>(null);
  const stack = work.stack || [];
  const list = stack[index]?.personas || [];
  const update = (personas: string[]) => onChange(stack.map((s, i) => (i === index ? { ...s, personas } : s)));
  const run = async () => { setSuggest('…'); setSuggest(await api.suggestPersonas(work.slug, pr.number)); };
  return (
    <div className="row">
      <span className="status">owner review:</span>
      {list.map((p) => <PersonaChip key={p} login={p} onRemove={() => update(list.filter((x) => x !== p))} />)}
      {list.length === 0 && <span className="chip c-grey">nobody yet</span>}
      {pr.number && <button className="sm" onClick={run}>suggest</button>}
      {suggest && suggest !== '…' && suggest.personas.filter((s) => !list.includes(s.login)).map((s) => <button key={s.login} className="sm suggest" onClick={() => update([...list, s.login])}>+ <PersonaChip login={s.login} label={`${s.login} (${s.hits})`} href={null} /></button>)}
      {suggest && suggest !== '…' && suggest.personas.length === 0 && <span className="status">no persona covers these {suggest.files} files · <a href="#/rituals/map">map one</a></span>}
      {suggest === '…' && <span className="status">…</span>}
    </div>
  );
}

type PrCardProps = {
  work: WorkDetail;
  pr: WorkPr;
  index: number;
  onStack: (stack: StackRow[]) => void;
  onDetails: (n: number) => void;
  onReview: (key: PrKey, kind?: string) => void;
  dev: DevServerRowData | null | undefined;
  onDevChange: () => unknown;
};

function PrCard({ work, pr, index, onStack, onDetails, onReview, dev, onDevChange }: PrCardProps) {
  const planned = work.stack?.[index]?.planned;
  const { key, number } = pr;
  const title = pr.title || planned?.title || `PR ${index + 1}`;
  const what = userFacing(pr.body) || planned?.scope || '';
  const [open, setOpen] = useState(!FOLDED_STATES.includes(stateKey(pr)));
  return (
    <section id={`pr-${pr.number || index}`} className={`card pr-card plan-pr st-${stateKey(pr)}${open ? '' : ' folded'}`}>
      <div className="headline" onClick={() => setOpen(!open)}>
        <span className="step">{index + 1}</span>
        <div>
          {pr.number ? <a className="pr-num" href={pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>#{pr.number}</a> : <span className="status">planned</span>} <b>{title}</b>
          {open && planned?.branch && !pr.number && <div className="status"><code>{planned.branch}</code></div>}
        </div>
        <span className="row" style={{ justifyContent: 'flex-end' }}>
          <span className={`chip ${stateChip(pr)}`}>{stateLabel(pr)}</span>
          {pr.number && pr.ci !== 'none' && <span className={`chip ${ciChip(pr.ci)}`}>CI {pr.ci}</span>}
          <span className="caret">{open ? '▾' : '▸'}</span>
        </span>
      </div>
      {open && <>
        {what && <div className="what"><Markdown text={what} /></div>}
        {key && <KitLine slug={work.slug} n={key} />}
        {dev && <DevServerRow slug={work.slug} row={dev} onChange={onDevChange} />}
        {key && <GateRail slug={work.slug} n={key} onOpen={(kind) => onReview(key, kind)} />}
        <div className="owners row"><PersonaChips work={work} pr={pr} index={index} onChange={onStack} />{key && <span className="row open-side"><button className="sm" onClick={() => onReview(key)}>review ▸</button><button className="sm" onClick={() => onReview(key, 'findings')}>findings ▸</button><button className="sm" onClick={() => onReview(key, 'brief')}>agent ▸</button>{number && <button className="sm" onClick={() => onDetails(number)}>details ▸</button>}</span>}</div>
      </>}
    </section>
  );
}

function NotionLine({ w, onChange }: { w: WorkDetail; onChange: () => void }) {
  const s: NotionState = w.notionStatus || {};
  const notionLinks = (w.links || []).filter((l) => /notion\.(so|site|com)/.test(l.url));
  const { busy, run } = useAction();
  const act = (body: Record<string, unknown>) => run(String(body.action || body.mode || 'create'), async () => { const r = await api.notionAction(w.slug, body); if (r.error) toast.error(r.error); onChange(); });
  const link = () => { const url = prompt('Notion page URL'); if (url) act({ action: 'link', url }); };
  const create = () => {
    if (!notionLinks.length) return toast.error('Add a Notion link to the work first: the new page is created under it.');
    const pick = notionLinks.length === 1 ? notionLinks[0] : notionLinks[Number(prompt(notionLinks.map((l, i) => `${i}: ${l.label}`).join('\n') + '\nParent page number')) || 0];
    const parentPageId = pick && pick.url.replace(/-/g, '').match(/([0-9a-f]{32})(?:[?#]|$)/i)?.[1];
    if (parentPageId && confirm(`Create a Notion sub-page "${w.title}" under "${pick.label}"?`)) act({ parentPageId });
  };
  const sync = () => act({ mode: 'preview' });
  if (s.running || busy) return <span className="chip c-blue">{s.running === 'preview' ? 'coco previews the sync…' : 'Notion syncing…'}</span>;
  if (!s.linked) return <><button className="sm" onClick={link}>Link a Notion page</button><button className="sm" onClick={create}>Create sub-page</button></>;
  const chip = s.lastError ? ['c-red', `sync failed · retry`] : s.preview ? ['c-orange', 'preview ready below'] : s.editedInNotion ? ['c-red', 'edited in Notion · preview'] : s.outOfSync ? ['c-orange', 'out of sync · preview'] : ['c-green', `synced ${(s.syncedAt || '').slice(0, 16).replace('T', ' ')}`];
  return <>
    <a href={s.url} target="_blank" rel="noreferrer"><img className="fav" src={favicon(s.url ?? '')} alt="" loading="lazy" />page</a>
    <span className={`chip ${chip[0]}`} onClick={sync} style={{ cursor: 'pointer' }} title={s.lastError || 'click to sync'}>{chip[1]}</span>
    <button className="sm" onClick={() => confirm('Unlink the Notion page? Nothing is deleted in Notion.') && act({ action: 'unlink' })} style={{ background: 'transparent', border: 0, color: 'var(--mute)' }}>×</button>
  </>;
}

function NotionPreview({ w, onChange }: { w: WorkDetail; onChange: () => void }) {
  const status: NotionState = w.notionStatus;
  const p = status.preview;
  const { pending, busy, run } = useAction();
  if (!p) return null;
  const act = (body: Record<string, unknown>) => run(String(body.action || body.mode), async () => { const r = await api.notionAction(w.slug, body); if (r.error) toast.error(r.error); onChange(); });
  const crit: Record<string, string> = { high: 'c-red', medium: 'c-orange', low: 'c-grey' };
  const high = p.changes.filter((c) => c.severity === 'high').length;
  return (
    <div className="card" style={{ marginTop: 8, borderLeft: '3px solid var(--brand)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>Notion sync preview</b>
        <span className="status">coco, {p.at.slice(11, 16)} · page edited {p.lastEditedTime ? p.lastEditedTime.slice(0, 16).replace('T', ' ') : 'unknown'}</span>
      </div>
      <p className="sub" style={{ margin: '4px 0 8px' }}>{p.summary}</p>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {p.changes.map((c, i) => <li key={i}><span className={`chip ${crit[c.severity] || 'c-grey'}`}>{c.severity}</span> <b>{c.section}</b> · {c.what}</li>)}
      </ul>
      {p.lostText && p.lostText.length > 0 && <div className="card danger" style={{ marginTop: 8 }}><b>Text on the page that would be erased</b><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{p.lostText.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className={`primary sm${pendingClass(pending === 'apply')}`} disabled={busy} onClick={() => (high === 0 || confirm(`${high} high-severity change(s). Overwrite the Notion page?`)) && act({ mode: 'apply', force: true })}>Apply sync</button>
        <button className={`sm${pendingClass(pending === 'preview')}`} disabled={busy} onClick={() => act({ mode: 'preview' })}>Refresh preview</button>
        <button className={`sm${pendingClass(pending === 'discard-preview')}`} disabled={busy} onClick={() => act({ action: 'discard-preview' })}>Discard</button>
      </div>
    </div>
  );
}

type HeroProps = { w: WorkDetail; prs: WorkPr[]; refreshing: boolean; onRefresh: () => void; onAddLink: () => void; onChange: () => void; devServers: DevServersResponse | null };

function Hero({ w, prs, refreshing, onRefresh, onAddLink, onChange, devServers }: HeroProps) {
  const { busy: archiving, run } = useAction();
  const merged = prs.filter((p) => stateKey(p) === 'merged').length;
  const total = prs.reduce((a, p) => ({ add: a.add + (p.additions || 0), del: a.del + (p.deletions || 0), files: a.files + (p.changedFiles || 0) }), { add: 0, del: 0, files: 0 });
  const summary = w.summary || (w.notes || '').split('\n').find((l) => /^\d+\. /.test(l))?.replace(/^\d+\. /, '') || '';
  const owners = [...new Set((w.stack || []).flatMap((s) => s.personas || []).concat(w.personas || []))];
  const [lead, ...more] = (w.description || '').split(/\n\s*\n/);
  const planned = prs.filter((p) => stateKey(p) === 'planned').length;
  return (
    <div className="card hero" style={{ marginTop: 12 }}>
      {w.description ? <div className="lead md-lead"><Markdown text={lead} /></div> : summary ? <p className="lead">{summary}</p> : null}
      {more.length > 0 && <div className="about"><Collapsible title="About this work" level="pm"><div className="md-lead"><Markdown text={more.join('\n\n')} /></div></Collapsible></div>}
      <div className="progress">{prs.map((p, i) => <i key={i} className={`st-${stateKey(p)}`} title={`${p.number ? `#${p.number}` : `PR ${i + 1}`} ${stateLabel(p)}`} />)}</div>
      <div className="rail">
        {prs.map((pr, i) => stateKey(pr) !== 'planned' && (
          <React.Fragment key={pr.number || i}>
            {i > 0 && <span style={{ color: 'var(--line)' }}>→</span>}
            <a href="#" onClick={(e) => { e.preventDefault(); document.getElementById(`pr-${pr.number || i}`)?.scrollIntoView({ behavior: 'smooth' }); }} className={`pill st-${stateKey(pr)}`}>{pr.number ? `#${pr.number}` : `PR ${i + 1}`} <small>{stateLabel(pr)}</small></a>
          </React.Fragment>
        ))}
        {planned > 0 && <><span style={{ color: 'var(--line)' }}>→</span><span className="pill st-planned">+{planned} <small>planned</small></span></>}
      </div>
      <div className="next"><b>Next</b> · {nextAction(prs)}</div>
      <dl className="meta">
        <dt>Progress</dt><dd>{merged}/{prs.length} merged · {total.files} files, +{total.add} −{total.del}</dd>
        <dt>Reviewers</dt><dd>{owners.length ? owners.map((p) => <PersonaChip key={p} login={p} />) : 'none yet'}</dd>
        <dt>Notion</dt><dd><NotionLine w={w} onChange={onChange} /></dd>
        {devServers && <><dt>Dev servers</dt><dd><DevServersSummary data={devServers} /></dd></>}
        <dt>Links</dt><dd>{(w.links || []).map((l, i) => <a key={i} href={l.url} target="_blank" rel="noreferrer"><img className="fav" src={favicon(l.url)} alt="" loading="lazy" />{l.label}</a>)}<button className="sm" onClick={onAddLink} style={{ background: 'transparent', border: 0, padding: '0 4px', color: 'var(--mute)' }}>+</button></dd>
      </dl>
      <div className="foot">
        <span>Paseo {w.projectName}{w.tier ? ` · ${w.tier} tier` : ''} · GitHub state {(w.fetchedAt || '').slice(11, 19)}, auto every 30 s</span>
        <span className="row">{w.archived && <span className="chip c-grey">archived {w.archived.reason === 'auto' ? 'automatically' : 'by hand'} {w.archived.at.slice(0, 10)}</span>}<button className={`sm${pendingClass(archiving)}`} disabled={archiving} onClick={() => run('archive', () => api.archiveWork(w.slug, !w.archived).then(onChange))}>{w.archived ? 'Unarchive' : 'Archive'}</button><button className={`sm${pendingClass(refreshing)}`} onClick={onRefresh} disabled={refreshing}>↻</button></span>
      </div>
    </div>
  );
}

// the owner's to-do, written by the orchestrating agent (PUT { next }); the stack's own "Next" line stays in the hero
function WhatsNext({ next }: { next: unknown }) {
  if (!isWhatsNext(next)) return null;
  return (
    <section className="card whats-next">
      <div className="headline">
        <b>What's next for you</b>
        <span className="status">{next.by ? `${next.by} · ` : ''}{(next.at || '').slice(0, 16).replace('T', ' ')}</span>
      </div>
      {next.summary && <p className="lead">{next.summary}</p>}
      {next.blocks && <Blocks blocks={next.blocks} />}
    </section>
  );
}

const SIDE: [string, string][] = [['ask', '🦜 Ask coco'], ['decisions', 'Decisions'], ['findings', 'Findings'], ['rules', 'Rules'], ['artifacts', 'Artifacts'], ['timeline', 'Timeline'], ['notes', 'Notes']];

export default function Plan({ group }: { group: number }) {
  const { w, prs, refreshing, load, saveStack, addLink } = useWork();
  const dev = useDevServers(w.slug);
  const open = useWorkbench((s) => s.open);
  const opened = useWorkbench((s) => s.groups).flatMap((g) => g.tabs);
  const other = group === 1 ? 2 : 1;
  return (
    <div className="wb-plan">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{w.title}</h1>
        <div className="row">
          <span className="status">open beside:</span>
          {SIDE.map(([id, label]) => <button key={id} className={`sm ${opened.includes(id) ? 'on' : ''}`} onClick={() => open(id, { group: other })}>{label}</button>)}
        </div>
      </div>
      <Hero w={w} prs={prs} refreshing={refreshing} onRefresh={() => load(true)} onAddLink={addLink} onChange={() => load()} devServers={dev.data} />
      <WhatsNext next={w.next} />
      <NotionPreview w={w} onChange={() => load()} />
      <StackKeeper slug={w.slug} onChange={() => load()} />
      {prs.some((p) => p.key) && <StackFixCard group={group} />}
      {w.notes && <Collapsible title="Rules and decisions" level="pm" badge="do not revisit"><Markdown text={w.notes} /></Collapsible>}
      {prs.length === 0 && <div className="card"><span className="sub">No PR yet.</span></div>}
      {prs.map((pr, i) => <PrCard key={pr.number || i} work={w} pr={pr} index={i} onStack={saveStack} onDetails={(n) => open(`pr-${n}`, { preview: true, group: other })} onReview={(n, kind = 'review') => open(`${kind}-${n}`, { group: other })} dev={dev.data?.on && pr.key ? dev.rows[String(pr.key)] : null} onDevChange={dev.reload} />)}
    </div>
  );
}
