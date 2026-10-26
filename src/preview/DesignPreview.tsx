import React, { useEffect, useMemo, useState } from 'react';
import { PendingPermissions } from '../components/PermissionCard.tsx';
import { WorkbenchView } from '../workbench/Workbench.tsx';
import { useWorkbench } from '../workbench/workbench-store.ts';
import { WorkContext } from '../workbench/use-work.ts';
import { setThemeMode, useTheme } from '../theme.ts';
import { api } from '../api.ts';
import Icon from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import Inspector from './Inspector.tsx';
import BetaPanel from './BetaPanel.tsx';
import { PreviewContext, previewTabDef } from './tabs.tsx';
import LayoutMenu, { useWorkLayouts } from './LayoutMenu.tsx';
import { applyLayout } from './layouts.ts';
import { CHOICES, useBetaPanel, usePrefs, workHref } from './prefs.ts';
import type { PrefKey } from './prefs.ts';
import { prKey, prState, prTitle, usePreviewData } from './data.ts';
import AgentsSection from './AgentsSection.tsx';
import { prLabel, useAgentList } from './agents.ts';
import type { PreviewData } from './data.ts';
import type { Overview, WorkSummary } from '../types.ts';
import './preview.css';

type Command = { id: string; label: string; hint?: string; icon: IconName; run: () => void };

const VIEWS: { id: string; label: string; icon: IconName }[] = [
  { id: 'plan', label: 'Overview', icon: 'home' },
  { id: 'stack', label: 'Stack', icon: 'list' },
  { id: 'findings', label: 'Findings', icon: 'flag' },
  { id: 'decisions', label: 'Decisions', icon: 'scale' },
  { id: 'timeline', label: 'Timeline', icon: 'history' },
  { id: 'notes', label: 'Notes', icon: 'notebook' },
  { id: 'artifacts', label: 'Artifacts', icon: 'folder' },
];
const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: '#/', label: 'Dashboard', icon: 'home' },
  { href: '#/inbox', label: 'Inbox', icon: 'inbox' },
  { href: '#/agents', label: 'Agents', icon: 'bot' },
  { href: '#/projects', label: 'Projects', icon: 'layers' },
  { href: '#/rituals', label: 'Rituals', icon: 'sparkles' },
  { href: '#/rules', label: 'Rules', icon: 'scale' },
];

const open = (id: string) => useWorkbench.getState().open(id);

const NARROW = '(max-width: 900px)';
const useNarrow = () => {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
};

const SEGMENTS: [keyof WorkSummary['progress'], string][] = [['merged', 'merged'], ['ready', 'review'], ['draft', 'draft'], ['planned', 'planned'], ['closed', 'closed']];

const EXPANDED = 'cc.dp.expanded';
const readExpanded = (): string[] => { try { const v: unknown = JSON.parse(localStorage.getItem(EXPANDED) || '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
const useExpanded = (slug: string) => {
  const [list, setList] = useState(() => { const l = readExpanded(); return l.includes(slug) ? l : [...l, slug]; });
  useEffect(() => { try { localStorage.setItem(EXPANDED, JSON.stringify(list)); } catch {} }, [list]);
  const toggle = (s: string) => setList((l) => (l.includes(s) ? l.filter((x) => x !== s) : [...l, s]));
  return { expanded: list, toggle };
};

function WorkRow({ w, on, expanded, onToggle, views }: { w: WorkSummary; on: boolean; expanded: boolean; onToggle: () => void; views: React.ReactNode }) {
  const p = w.progress;
  const st = p.attention ? 'dp-st-changes' : p.ready + p.draft ? 'dp-st-draft' : 'dp-st-planned dp-hollow';
  const segs = SEGMENTS.flatMap(([k, state]) => Array.from({ length: Number(p[k]) || 0 }, (_, i) => <i key={`${state}-${i}`} className={`dp-st-${state}`} />));
  return (
    <>
      <a className={`dp-work dp-work2${on ? ' dp-on' : ''}`} href={workHref(w.slug)} title={w.title} onClick={() => { if (!expanded) onToggle(); }}>
        <span className="dp-work-top">
          <button type="button" className={`dp-caret${expanded ? ' dp-open' : ''}`} aria-label={expanded ? 'Collapse' : 'Expand'} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}><Icon name="chevron-right" size={12} /></button>
          <span className={`dp-dot dp-lg ${st}`} />
          <span className="dp-grow dp-ell">{w.title}</span>
          {p.restack && <span className="dp-chip dp-warn" title="A parent PR merged: its children still sit on the old base">restack</span>}
        </span>
        <span className="dp-work-bar">
          <span className="dp-segs dp-thin dp-grow">{segs.length ? segs : <i className="dp-st-planned" />}</span>
          <span className="dp-pc">{w.archived ? 'archived' : `${p.merged}/${w.stack - p.closed}`}</span>
        </span>
      </a>
      <div className={`dp-collapse${expanded ? ' dp-open' : ''}`}><div>{views}</div></div>
    </>
  );
}

function WorkTree({ ov, slug, views, repo }: { ov: Overview | null; slug: string; views: (w: WorkSummary) => React.ReactNode; repo?: string }) {
  const works = new Map((ov?.works || []).filter((w) => !w.archived).map((w) => [w.slug, w]));
  const repos = (ov?.repos || []).filter((r) => !repo || r.id === repo);
  const { expanded, toggle } = useExpanded(slug);
  return (
    <>
      {repos.map((r) => (
        <React.Fragment key={r.id}>
          {!repo && <div className="dp-repo"><Icon name="git-branch" size={14} /><span>{r.name}</span><span className="dp-gh-name">{r.github.split('/')[0]}</span></div>}
          {r.works.map((s) => works.get(s)).filter((w): w is WorkSummary => Boolean(w)).map((w) => (
            <WorkRow key={w.slug} w={w} on={w.slug === slug} expanded={expanded.includes(w.slug)} onToggle={() => toggle(w.slug)} views={views(w)} />
          ))}
        </React.Fragment>
      ))}
    </>
  );
}

function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const list = commands.filter((c) => `${c.label} ${c.hint || ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  const run = (c?: Command) => { if (!c) return; onClose(); c.run(); };
  return (
    <div className="dp-overlay dp-on" onClick={onClose}>
      <div className="dp-palette" onClick={(e) => e.stopPropagation()}>
        <div className="dp-pin">
          <Icon name="search" />
          <input autoFocus value={q} placeholder="Jump to a PR, view, layout or variant…" onChange={(e) => { setQ(e.target.value); setHl(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(h + 1, list.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
              if (e.key === 'Enter') run(list[hl]);
              if (e.key === 'Escape') onClose();
            }} />
          <span className="dp-kbd">esc</span>
        </div>
        <div className="dp-pl">
          {list.map((c, i) => (
            <div key={c.id} className={`dp-mi${i === hl ? ' dp-hl' : ''}`} onMouseEnter={() => setHl(i)} onClick={() => run(c)}>
              <Icon name={c.icon} /><span className="dp-ell">{c.label}</span>{c.hint && <span className="dp-r">{c.hint}</span>}
            </div>
          ))}
          {!list.length && <div className="dp-mi dp-t3">Nothing matches.</div>}
        </div>
        <div className="dp-pf"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> run</span><span className="dp-sp" /><span><kbd>⌘</kbd><kbd>.</kbd> beta features</span></div>
      </div>
    </div>
  );
}

function Bench({ d, slug }: { d: PreviewData & { work: { w: NonNullable<PreviewData['work']['w']> } }; slug: string }) {
  const prefs = usePrefs();
  const theme = useTheme();
  const groups = useWorkbench((s) => (s.slug === slug ? s.groups : []));
  const [selected, setSelected] = useState<string | null>(() => {
    const first = d.prs.find((p) => !['merged', 'closed'].includes(prState(p))) || d.prs[0];
    return first ? prKey(first) : null;
  });
  const [inspector, setInspector] = useState(true);
  const [palette, setPalette] = useState(false);
  const { open: controls, toggle: toggleControls } = useBetaPanel();
  const [waitOpen, setWaitOpen] = useState(false);
  const [repo, setRepo] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const narrow = useNarrow();
  useEffect(() => {
    document.body.classList.add('dp-on');
    return () => document.body.classList.remove('dp-on');
  }, []);

  const layouts = useWorkLayouts(slug);

  const ov = d.overview;
  const summary = ov?.works.find((w) => w.slug === slug);
  const repoId = repo || summary?.repo || ov?.repos.find((r) => r.works.includes(slug))?.id || null;
  const repoName = ov?.repos.find((r) => r.id === repoId)?.name;
  const tabDetails = narrow || prefs.shell === 'C' || prefs.details === 'tab';
  const showInspector = !tabDetails && inspector;
  const waiting = d.pending.filter((p) => !p.where || p.where.href.includes(slug));
  const counts = useMemo(() => {
    const by: Record<string, number> = {};
    d.prs.forEach((p) => { const s = prState(p); by[s] = (by[s] || 0) + 1; });
    return by;
  }, [d.prs]);
  const ciRun = d.prs.filter((p) => p.ci === 'pending').length;
  const ciBad = d.prs.filter((p) => p.ci === 'failure').length;
  const openFindings = (d.findings?.rows || []).filter((f) => f.status === 'open').length;
  const tabCount: Record<string, number | undefined> = { stack: d.prs.length, findings: openFindings || undefined, decisions: (d.work.w.decisions || []).length || undefined };
  const agents = useAgentList(slug) || [];

  const openPr = (key: string) => {
    setSelected(key);
    if (tabDetails) open(`pr-${key}`);
    else setInspector(true);
  };
  const split = () => {
    const s = useWorkbench.getState();
    const tab = s.groups.find((g) => g.id === s.focused)?.active;
    if (tab) s.moveToOtherGroup(tab);
  };

  const commands: Command[] = [
    ...VIEWS.map((v) => ({ id: `v-${v.id}`, label: v.label, hint: 'view', icon: v.icon, run: () => open(v.id) })),
    { id: 'new-agent', label: 'New agent', hint: 'agents', icon: 'bot', run: () => open('ask') },
    ...d.prs.map((p) => ({ id: `new-agent-${prKey(p)}`, label: `New agent on ${p.number ? `#${p.number}` : prLabel(prKey(p))} ${prTitle(p)}`, hint: 'agents', icon: 'bot' as const, run: () => open(`ask-new-${prKey(p)}`) })),
    ...agents.map((a) => ({ id: `agent-${a.id}`, label: `Agent: ${a.title}`, hint: a.status, icon: 'bot' as const, run: () => open(a.id) })),
    ...layouts.list.map((l, i) => ({ id: `l-${l.id}`, label: `Layout: ${l.name}`, hint: i < 9 ? `⌥${i + 1}` : 'layout', icon: 'columns' as const, run: () => applyLayout(l) })),
    { id: 'split', label: 'Move the tab to the other pane', hint: '⌘\\', icon: 'columns', run: split },
    ...CHOICES.flatMap((c) => c.options.map((o) => ({ id: `c-${c.key}-${o.value}`, label: `${c.label}: ${o.label}`, hint: prefs[c.key] === o.value ? 'current' : 'variant', icon: 'eye' as const, run: () => prefs.set(c.key, o.value) }))),
    ...d.prs.map((p) => ({ id: `pr-${prKey(p)}`, label: `${p.number ? `#${p.number}` : 'planned'} ${prTitle(p)}`, hint: prState(p), icon: 'git-pull-request' as const, run: () => openPr(prKey(p)) })),
    ...d.prs.filter((p) => p.number).map((p) => ({ id: `review-${p.number}`, label: `Review #${p.number} ${prTitle(p)}`, hint: 'code', icon: 'file' as const, run: () => open(`review-${p.number}`) })),
    ...(ov?.works || []).filter((w) => !w.archived && w.slug !== slug).map((w) => ({ id: `w-${w.slug}`, label: w.title, hint: 'work', icon: 'layers' as const, run: () => { location.hash = workHref(w.slug); } })),
    { id: 'theme', label: `Theme: ${theme.resolved === 'dark' ? 'light' : 'dark'}`, hint: '⌘⇧L', icon: theme.resolved === 'dark' ? 'sun' : 'moon', run: () => setThemeMode(theme.resolved === 'dark' ? 'light' : 'dark') },
  ];

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
      if (mod && e.key.toLowerCase() === 'i' && !tabDetails) { e.preventDefault(); setInspector((x) => !x); }
      if (mod && e.key === 'Enter' && selected) { e.preventDefault(); open(`pr-${selected}`); }
      const n = e.altKey && !mod && /^Digit([1-9])$/.exec(e.code);
      if (n && layouts.list[Number(n[1]) - 1]) { e.preventDefault(); applyLayout(layouts.list[Number(n[1]) - 1]); }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  });

  const views = (w: WorkSummary) => (
    <div className="dp-views">
      {VIEWS.map((v) => {
        const here = w.slug === slug;
        const isOpen = here && groups.some((g) => g.tabs.includes(v.id));
        const count = here ? tabCount[v.id] : v.id === 'stack' ? w.stack || undefined : undefined;
        return (
          <div key={v.id} className={`dp-view${isOpen ? ' dp-open' : ''}`} onClick={() => { if (here) open(v.id); else location.hash = `${workHref(w.slug)}/${v.id}`; }}>
            <Icon name={v.icon} size={14} /><span>{v.label}</span>
            {count !== undefined && <span className="dp-count">{count}</span>}
          </div>
        );
      })}
      <AgentsSection slug={w.slug} live={w.slug === slug} prs={w.slug === slug ? d.prs : []} onOpen={(id) => { if (w.slug === slug) open(id); else location.hash = `${workHref(w.slug)}/${id}`; }} />
    </div>
  );

  return (
    <PreviewContext.Provider value={{ d, selected, select: setSelected, openPr }}>
      <div className="dp-app">
        <header className="dp-titlebar">
          <button type="button" className={`dp-ibtn dp-lg dp-menu${menu ? ' dp-on' : ''}`} title="Works and views" onClick={() => setMenu((m) => !m)}><Icon name="list" /></button>
          <span className="dp-brandmark">c</span>
          <div className="dp-crumbs">
            {repoName && <><span>{repoName}</span><span className="dp-sl">/</span></>}
            <b>{d.work.w.title}</b>
            {waiting.length > 0 && <span className="dp-chip dp-warn" style={{ marginLeft: 4 }}><Icon name="alert-triangle" size={12} />needs you</span>}
          </div>
          <div className="dp-cmdk" onClick={() => setPalette(true)}><Icon name="search" size={14} /><span className="dp-grow">Search PRs, views, variants…</span><kbd>⌘</kbd><kbd>K</kbd></div>
          <div className="dp-row dp-g4">
            <LayoutMenu slug={slug} />
            <span className="dp-sep-v" style={{ margin: '0 4px' }} />
            {!tabDetails && <button type="button" className={`dp-ibtn dp-lg${showInspector ? ' dp-on' : ''}`} title="Inspector  ⌘I" onClick={() => setInspector((x) => !x)}><Icon name="panel-right" /></button>}
            <button type="button" className="dp-ibtn dp-lg" title="Light / dark  ⌘⇧L" onClick={() => setThemeMode(theme.resolved === 'dark' ? 'light' : 'dark')}><Icon name={theme.resolved === 'dark' ? 'sun' : 'moon'} /></button>          </div>
        </header>

        <div className="dp-body">
          {prefs.shell === 'A' && (
            <div className="dp-activity">
              <button type="button" className="dp-ibtn dp-on" title="Works"><Icon name="layers" /></button>
              {NAV.slice(1).map((n) => <a key={n.href} className="dp-ibtn" href={n.href} title={n.label}><Icon name={n.icon} />{n.label === 'Inbox' && (ov?.notices || 0) > 0 && <span className="dp-count dp-acc">{ov?.notices}</span>}</a>)}
              <span className="dp-sp" />
              <button type="button" className={`dp-ibtn${controls ? ' dp-on' : ''}`} title="Beta features  ⌘." onClick={toggleControls}><Icon name="settings" /></button>
            </div>
          )}
          {prefs.shell === 'C' && (
            <div className="dp-activity" style={{ width: 52, gap: 6, paddingTop: 8 }}>
              {(ov?.repos || []).map((r) => (
                <button key={r.id} type="button" className={`dp-ibtn${r.id === repoId ? ' dp-on' : ''}`} title={r.name} style={{ width: 32, height: 32 }} onClick={() => setRepo(r.id)}>
                  <span className={`dp-rail-av${r.id === repoId ? ' dp-on' : ''}`}>{r.name.slice(0, 1).toUpperCase()}</span>
                </button>
              ))}
              <span className="dp-sp" />
              {NAV.slice(1, 3).map((n) => <a key={n.href} className="dp-ibtn" href={n.href} title={n.label}><Icon name={n.icon} /></a>)}
              <button type="button" className={`dp-ibtn${controls ? ' dp-on' : ''}`} title="Beta features  ⌘." onClick={toggleControls}><Icon name="settings" /></button>
            </div>
          )}
          <nav className={`dp-sidebar${prefs.shell === 'B' ? ' dp-classic' : ''}${menu ? ' dp-sb-open' : ''}`} onClick={(e) => { if (narrow && e.target instanceof Element && e.target.closest('a, .dp-view')) setMenu(false); }}>
            {prefs.shell === 'A' && <div className="dp-sb-head">Works</div>}
            {prefs.shell === 'C' && <div className="dp-sb-head">{repoName}<span className="dp-sp" /></div>}
            <div className="dp-sb-scroll">
              {prefs.shell === 'B' && NAV.map((n) => <a key={n.href} className="dp-sb-nav" href={n.href}><Icon name={n.icon} /><span>{n.label}</span>{n.label === 'Inbox' && (ov?.notices || 0) > 0 && <span className="dp-count dp-acc">{ov?.notices}</span>}</a>)}
              {prefs.shell === 'B' && <div className="dp-sb-group">Works</div>}
              <WorkTree ov={ov} slug={slug} views={views} repo={prefs.shell === 'C' ? repoId || undefined : undefined} />
              {prefs.shell === 'C' && repoId === summary?.repo && (
                <>
                  <div className="dp-sb-group"><Icon name="git-pull-request" size={14} />Open PRs<span className="dp-count" style={{ marginLeft: 4 }}>{d.prs.filter((p) => p.number && !['merged', 'closed'].includes(prState(p))).length}</span></div>
                  {d.prs.filter((p) => p.number && !['merged', 'closed'].includes(prState(p))).map((p) => (
                    <div key={prKey(p)} className={`dp-view${selected === prKey(p) ? ' dp-open' : ''}`} style={{ paddingLeft: 8 }} onClick={() => openPr(prKey(p))}>
                      <span className={`dp-prb dp-st-${prState(p)}${p.ci === 'failure' ? ' dp-ci-bad' : p.ci === 'pending' ? ' dp-ci-run' : ''}`}><Icon name="git-pull-request" size={12} />#{p.number}</span>
                      <span className="dp-ell">{prTitle(p)}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
            {prefs.shell === 'B' && <div className="dp-sb-foot"><div className="dp-sb-nav" onClick={toggleControls}><Icon name="settings" /><span>Beta features</span><span className="dp-xs dp-t3" style={{ marginLeft: 'auto' }}>⌘.</span></div></div>}
          </nav>

          <div className="dp-wb"><WorkbenchView slug={slug} data={d.work} defs={previewTabDef} /></div>

          {showInspector && <Inspector d={d} prKey={selected} onClose={() => setInspector(false)} />}
        </div>

        <footer className="dp-statusbar">
          <span className="dp-sbi"><span className="dp-dot dp-live" />GitHub synced {new Date(d.work.w.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span className="dp-sbi" onClick={() => open('stack')}><Icon name="git-pull-request" />{d.prs.length - (counts.merged || 0) - (counts.closed || 0) - (counts.planned || 0)} open · {counts.merged || 0} merged · {counts.planned || 0} planned</span>
          {summary?.progress.restack && <span className="dp-sbi" style={{ color: 'var(--dp-warn)' }}><Icon name="git-branch" />Restack needed</span>}
          {d.agents.length > 0 && <span className="dp-sbi"><Icon name="bot" />{d.agents.length} linked agents</span>}
          {(ciRun > 0 || ciBad > 0) && <span className="dp-sbi"><Icon name="circle-dot" />CI{ciRun > 0 && ` ${ciRun} running`}{ciRun > 0 && ciBad > 0 && <span className="dp-t4">·</span>}{ciBad > 0 && <span className="dp-ci-bad">{ciBad} failing</span>}</span>}
          <span className="dp-sp" />
          {waiting.length > 0 && <span className="dp-sbi dp-wait" onClick={() => (prefs.questions === 'tab' ? open('waiting') : setWaitOpen((w) => !w))}><Icon name="message-square" />{waiting.length} waiting on you</span>}
          <span className="dp-sbi">Layout: {layouts.current?.name || 'unsaved'}</span>
          <span className="dp-sbi" onClick={() => setPalette(true)}><kbd>⌘</kbd><kbd>K</kbd>Commands</span>
          <span className="dp-sbi" onClick={split}><kbd>⌘</kbd><kbd>\</kbd>Other pane</span>
          <span className="dp-sbi" onClick={toggleControls}><kbd>⌘</kbd><kbd>.</kbd>Beta</span>
        </footer>

        {waitOpen && prefs.questions === 'inline' && (
          <div className="dp-pop dp-on dp-waitpop">
            <div className="dp-pop-h"><b>Waiting on you</b><span className="dp-count dp-acc">{waiting.length}</span><span className="dp-sp" /><button type="button" className="dp-ibtn" onClick={() => setWaitOpen(false)}><Icon name="x" size={14} /></button></div>
            <div className="dp-pop-s dp-legacy"><PendingPermissions withWhere /></div>
          </div>
        )}
        {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
        {controls && <BetaPanel preview />}
      </div>
    </PreviewContext.Provider>
  );
}

export default function DesignPreview({ slug }: { slug?: string }) {
  useEffect(() => {
    if (slug) return;
    api.overview().then((ov) => {
      const first = ov.repos.flatMap((r) => r.works).map((s) => ov.works.find((w) => w.slug === s)).find((w) => w && !w.archived && w.stack > 0);
      if (first) history.replaceState(null, '', `#/design-preview/${first.slug}`), dispatchEvent(new HashChangeEvent('hashchange'));
    }, () => {});
  }, [slug]);
  if (!slug) return <div className="dp"><div className="dp-empty">Loading your works…</div></div>;
  return <Loaded key={slug} slug={slug} />;
}

function Loaded({ slug }: { slug: string }) {
  const d = usePreviewData(slug);
  const { w } = d.work;
  if (!w) return <div className="dp"><div className="dp-empty">{d.work.err || 'Loading the work…'}</div></div>;
  const work = { ...d.work, w };
  return (
    <WorkContext.Provider value={work}>
      <div className="dp"><Bench d={{ ...d, work }} slug={slug} /></div>
    </WorkContext.Provider>
  );
}

export type { PrefKey };
