import React, { useEffect, useMemo, useRef, useState } from 'react';
import Ask from '../pages/Ask.tsx';
import Decisions from '../workbench/tabs/Decisions.tsx';
import Timeline from '../workbench/tabs/Timeline.tsx';
import Notes from '../workbench/tabs/Notes.tsx';
import Artifacts from '../workbench/tabs/Artifacts.tsx';
import { PendingPermissions } from '../components/PermissionCard.tsx';
import { WorkContext } from '../workbench/use-work.ts';
import { setThemeMode, useTheme } from '../theme.ts';
import { api } from '../api.ts';
import Icon from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import StackView from './StackView.tsx';
import Inspector from './Inspector.tsx';
import OverviewView from './OverviewView.tsx';
import FindingsView from './FindingsView.tsx';
import BetaPanel from './BetaPanel.tsx';
import { CHOICES, useBetaPanel, usePrefs, workHref } from './prefs.ts';
import type { PrefKey, Prefs } from './prefs.ts';
import { prKey, prState, prTitle, usePreviewData } from './data.ts';
import type { PreviewData } from './data.ts';
import type { Overview, WorkSummary } from '../types.ts';
import type { WorkData } from '../workbench/types.ts';
import './preview.css';

type Pane = { tabs: string[]; active: string };
type Layout = { panes: Pane[]; sizes: number[]; focused: number };
type Command = { id: string; label: string; hint?: string; icon: IconName; run: () => void };

const VIEWS: { id: string; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'stack', label: 'Stack', icon: 'list' },
  { id: 'ask', label: 'Ask coco', icon: 'message-square' },
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

const PRESETS: Record<'plan' | 'review', Layout> = {
  plan: { panes: [{ tabs: ['overview', 'stack'], active: 'overview' }, { tabs: ['ask', 'decisions'], active: 'ask' }], sizes: [1.2, 1], focused: 0 },
  review: { panes: [{ tabs: ['stack', 'overview'], active: 'stack' }, { tabs: ['findings', 'ask'], active: 'findings' }], sizes: [1.2, 1], focused: 0 },
};
const layoutKey = (slug: string) => `cc.dp.layout.${slug}`;
const initialLayout = (slug: string, preset: Prefs['preset']): Layout => {
  if (preset !== 'last') return PRESETS[preset];
  try {
    const saved: Layout = JSON.parse(localStorage.getItem(layoutKey(slug)) || 'null');
    if (saved?.panes?.length) return saved;
  } catch {}
  return PRESETS.review;
};

const viewOf = (id: string) => VIEWS.find((v) => v.id === id);
const isPrTab = (id: string) => id.startsWith('pr-');

function useLayout(slug: string, preset: Prefs['preset']) {
  const [layout, setLayout] = useState<Layout>(() => initialLayout(slug, preset));
  useEffect(() => { try { localStorage.setItem(layoutKey(slug), JSON.stringify(layout)); } catch {} }, [slug, layout]);
  const open = (tab: string, pane = layout.focused) => setLayout((l) => {
    const at = l.panes.findIndex((p) => p.tabs.includes(tab));
    if (at >= 0) return { ...l, focused: at, panes: l.panes.map((p, i) => (i === at ? { ...p, active: tab } : p)) };
    const to = Math.min(pane, l.panes.length - 1);
    return { ...l, focused: to, panes: l.panes.map((p, i) => (i === to ? { tabs: [...p.tabs, tab], active: tab } : p)) };
  });
  const close = (tab: string) => setLayout((l) => {
    const panes = l.panes.map((p) => {
      if (!p.tabs.includes(tab)) return p;
      const tabs = p.tabs.filter((t) => t !== tab);
      return { tabs, active: p.active === tab ? tabs[Math.max(0, p.tabs.indexOf(tab) - 1)] || '' : p.active };
    }).filter((p) => p.tabs.length);
    if (!panes.length) return { panes: [{ tabs: ['overview'], active: 'overview' }], sizes: [1], focused: 0 };
    return { panes, sizes: panes.length === l.panes.length ? l.sizes : panes.map(() => 1), focused: Math.min(l.focused, panes.length - 1) };
  });
  const split = () => setLayout((l) => {
    if (l.panes.length > 1) return { panes: [{ tabs: l.panes.flatMap((p) => p.tabs), active: l.panes[l.focused].active }], sizes: [1], focused: 0 };
    const src = l.panes[0];
    if (src.tabs.length < 2) return { panes: [src, { tabs: ['ask'], active: 'ask' }].filter((p, i) => i === 0 || !src.tabs.includes('ask')), sizes: [1, 1], focused: 1 };
    const moved = src.active;
    const tabs = src.tabs.filter((t) => t !== moved);
    return { panes: [{ tabs, active: tabs[tabs.length - 1] }, { tabs: [moved], active: moved }], sizes: [1, 1], focused: 1 };
  });
  const move = (tab: string, to: number) => setLayout((l) => {
    if (to >= l.panes.length) {
      if (l.panes.length > 1 || l.panes[0].tabs.length < 2) return l;
      const tabs = l.panes[0].tabs.filter((t) => t !== tab);
      return { panes: [{ tabs, active: tabs[0] }, { tabs: [tab], active: tab }], sizes: [1, 1], focused: 1 };
    }
    if (l.panes[to].tabs.includes(tab)) return l;
    const panes = l.panes.map((p, i) => {
      if (i === to) return { tabs: [...p.tabs, tab], active: tab };
      if (!p.tabs.includes(tab)) return p;
      const tabs = p.tabs.filter((t) => t !== tab);
      return { tabs, active: p.active === tab ? tabs[0] || '' : p.active };
    }).filter((p) => p.tabs.length);
    return { panes, sizes: panes.length === l.panes.length ? l.sizes : [1], focused: Math.min(to, panes.length - 1) };
  });
  const activate = (pane: number, tab: string) => setLayout((l) => ({ ...l, focused: pane, panes: l.panes.map((p, i) => (i === pane ? { ...p, active: tab } : p)) }));
  const focus = (pane: number) => setLayout((l) => (l.focused === pane ? l : { ...l, focused: pane }));
  const resize = (sizes: number[]) => setLayout((l) => ({ ...l, sizes }));
  const apply = (preset: 'plan' | 'review') => setLayout(PRESETS[preset]);
  return { layout, open, close, split, move, activate, focus, resize, apply };
}

const progressOf = (w: WorkSummary) => {
  const p = w.progress;
  const total = Math.max(1, w.stack);
  return { merged: (p.merged / total) * 100, open: ((p.draft + p.ready) / total) * 100, label: `${p.merged}/${w.stack}` };
};

function WorkRow({ w, on, views }: { w: WorkSummary; on: boolean; views?: React.ReactNode }) {
  const pr = progressOf(w);
  const st = w.progress.attention ? 'dp-st-changes' : w.progress.ready + w.progress.draft ? 'dp-st-draft' : 'dp-st-planned dp-hollow';
  return (
    <>
      <a className={`dp-work${on ? ' dp-on' : ''}`} href={workHref(w.slug)}>
        <span className={`dp-dot dp-lg ${st}`} />
        <span className="dp-grow dp-ell">{w.title}</span>
        <span className="dp-mini"><i style={{ width: `${pr.merged}%` }} /><i className="dp-d" style={{ width: `${pr.open}%` }} /></span>
        <span className="dp-pc">{pr.label}</span>
      </a>
      {on && views}
    </>
  );
}

function WorkTree({ ov, slug, views, repo }: { ov: Overview | null; slug: string; views: React.ReactNode; repo?: string }) {
  const works = new Map((ov?.works || []).filter((w) => !w.archived).map((w) => [w.slug, w]));
  const repos = (ov?.repos || []).filter((r) => !repo || r.id === repo);
  return (
    <>
      {repos.map((r) => (
        <React.Fragment key={r.id}>
          {!repo && <div className="dp-repo"><Icon name="git-branch" size={14} /><span>{r.name}</span><span className="dp-gh-name">{r.github.split('/')[0]}</span></div>}
          {r.works.map((s) => works.get(s)).filter((w): w is WorkSummary => Boolean(w)).map((w) => <WorkRow key={w.slug} w={w} on={w.slug === slug} views={views} />)}
        </React.Fragment>
      ))}
    </>
  );
}

function Panel({ tab, d, onOpenPr, onOpen, selected, onSelect }: { tab: string; d: PreviewData; onOpenPr: (key: string) => void; onOpen: (tab: string) => void; selected: string | null; onSelect: (key: string) => void }) {
  const reload = () => { d.work.load(); };
  if (tab === 'overview') return <OverviewView d={d} onOpenPr={onOpenPr} onOpenTab={onOpen} />;
  if (tab === 'stack') return <StackView d={d} selected={selected} onSelect={onSelect} onOpen={(key) => onOpen(`pr-${key}`)} />;
  if (tab === 'findings') return <FindingsView d={d} onOpenPr={onOpenPr} onReload={reload} />;
  if (isPrTab(tab)) return <Inspector d={d} prKey={tab.slice(3)} asTab />;
  const legacy = tab === 'ask' ? <Ask workSlug={d.slug} /> : tab === 'decisions' ? <Decisions /> : tab === 'timeline' ? <Timeline /> : tab === 'notes' ? <Notes /> : tab === 'artifacts' ? <Artifacts group={1} /> : tab === 'waiting' ? <PendingPermissions withWhere /> : null;
  return <div className="dp-legacy">{legacy}</div>;
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
  const { layout, open, close, split, move, activate, focus, resize, apply } = useLayout(slug, prefs.preset);
  const [selected, setSelected] = useState<string | null>(() => {
    const first = d.prs.find((p) => !['merged', 'closed'].includes(prState(p))) || d.prs[0];
    return first ? prKey(first) : null;
  });
  const [inspector, setInspector] = useState(true);
  const [palette, setPalette] = useState(false);
  const { open: controls, toggle: toggleControls } = useBetaPanel();
  const [waitOpen, setWaitOpen] = useState(false);
  const [repo, setRepo] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const bench = useRef<HTMLDivElement | null>(null);

  const ov = d.overview;
  const summary = ov?.works.find((w) => w.slug === slug);
  const repoId = repo || summary?.repo || ov?.repos.find((r) => r.works.includes(slug))?.id || null;
  const repoName = ov?.repos.find((r) => r.id === repoId)?.name;
  const tabDetails = prefs.shell === 'C' || prefs.details === 'tab';
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
  const tabCount: Record<string, number | undefined> = { stack: d.prs.length, findings: openFindings || undefined, decisions: (d.work.w.decisions || []).length || undefined, ask: d.asks.length || undefined };

  const openPr = (key: string) => {
    setSelected(key);
    if (tabDetails) open(`pr-${key}`);
    else setInspector(true);
  };
  const openTab = (tab: string) => open(tab);
  const preset = layout.panes.length === 2 && layout.panes[0].active === 'overview' && layout.panes[1].active === 'ask' ? 'Plan' : layout.panes.length === 2 && layout.panes[0].active === 'stack' && layout.panes[1].active === 'findings' ? 'Review' : 'Custom';

  const commands: Command[] = [
    ...VIEWS.map((v) => ({ id: `v-${v.id}`, label: v.label, hint: 'view', icon: v.icon, run: () => open(v.id) })),
    { id: 'l-plan', label: 'Layout: Plan · Overview | Ask coco', hint: 'layout', icon: 'columns', run: () => apply('plan') },
    { id: 'l-review', label: 'Layout: Review · Stack + inspector | Findings', hint: 'layout', icon: 'columns', run: () => apply('review') },
    { id: 'split', label: 'Split / join panes', hint: '⌘\\', icon: 'columns', run: split },
    ...CHOICES.flatMap((c) => c.options.map((o) => ({ id: `c-${c.key}-${o.value}`, label: `${c.label}: ${o.label}`, hint: prefs[c.key] === o.value ? 'current' : 'variant', icon: 'eye' as const, run: () => prefs.set(c.key, o.value) }))),
    ...d.prs.map((p) => ({ id: `pr-${prKey(p)}`, label: `${p.number ? `#${p.number}` : 'planned'} ${prTitle(p)}`, hint: prState(p), icon: 'git-pull-request' as const, run: () => openPr(prKey(p)) })),
    ...(ov?.works || []).filter((w) => !w.archived && w.slug !== slug).map((w) => ({ id: `w-${w.slug}`, label: w.title, hint: 'work', icon: 'layers' as const, run: () => { location.hash = workHref(w.slug); } })),
    { id: 'theme', label: `Theme: ${theme.resolved === 'dark' ? 'light' : 'dark'}`, hint: '⌘⇧L', icon: theme.resolved === 'dark' ? 'sun' : 'moon', run: () => setThemeMode(theme.resolved === 'dark' ? 'light' : 'dark') },
    { id: 'exit', label: 'Exit the preview (today’s UI)', icon: 'external-link', run: () => { location.hash = `#/work/${slug}`; } },
  ];

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
      if (mod && e.key === '\\') { e.preventDefault(); split(); }
      if (mod && e.key.toLowerCase() === 'i' && !tabDetails) { e.preventDefault(); setInspector((x) => !x); }
      if (mod && e.key === 'Enter' && selected) { e.preventDefault(); open(`pr-${selected}`); }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  });

  const startResize = (e: React.PointerEvent) => {
    const box = bench.current?.getBoundingClientRect();
    if (!box) return;
    const moveTo = (ev: PointerEvent) => {
      const x = Math.min(0.8, Math.max(0.2, (ev.clientX - box.left) / box.width));
      resize([x, 1 - x]);
    };
    const up = () => { removeEventListener('pointermove', moveTo); removeEventListener('pointerup', up); };
    addEventListener('pointermove', moveTo);
    addEventListener('pointerup', up);
    e.preventDefault();
  };

  const views = (
    <div className="dp-views">
      {VIEWS.map((v) => {
        const isOpen = layout.panes.some((p) => p.tabs.includes(v.id));
        return (
          <div key={v.id} className={`dp-view${isOpen ? ' dp-open' : ''}`} onClick={() => open(v.id)}>
            <Icon name={v.icon} size={14} /><span>{v.label}</span>
            {tabCount[v.id] !== undefined && <span className={`dp-count${v.id === 'ask' && waiting.length ? ' dp-acc' : ''}`}>{tabCount[v.id]}</span>}
          </div>
        );
      })}
    </div>
  );

  const tabLabel = (t: string) => {
    if (isPrTab(t)) { const p = d.prs.find((x) => prKey(x) === t.slice(3)); return p?.number ? `#${p.number}` : (p ? prTitle(p) : t); }
    if (t === 'waiting') return 'Waiting on you';
    return viewOf(t)?.label || t;
  };
  const tabIcon = (t: string): IconName => (isPrTab(t) ? 'git-pull-request' : t === 'waiting' ? 'inbox' : viewOf(t)?.icon || 'file');

  return (
    <div className="dp-app">
      <header className="dp-titlebar">
        <span className="dp-brandmark">c</span>
        <div className="dp-crumbs">
          {repoName && <><span>{repoName}</span><span className="dp-sl">/</span></>}
          <b>{d.work.w.title}</b>
          {waiting.length > 0 && <span className="dp-chip dp-warn" style={{ marginLeft: 4 }}><Icon name="alert-triangle" size={12} />needs you</span>}
        </div>
        <div className="dp-cmdk" onClick={() => setPalette(true)}><Icon name="search" size={14} /><span className="dp-grow">Search PRs, views, variants…</span><kbd>⌘</kbd><kbd>K</kbd></div>
        <div className="dp-row dp-g4">
          <span className="dp-xs dp-t3">Layout</span>
          <div className="dp-seg">
            <button type="button" className={preset === 'Plan' ? 'dp-on' : ''} onClick={() => apply('plan')}>Plan</button>
            <button type="button" className={preset === 'Review' ? 'dp-on' : ''} onClick={() => apply('review')}>Review</button>
            <button type="button" className={preset === 'Custom' ? 'dp-on' : ''}>Custom</button>
          </div>
          <span className="dp-sep-v" style={{ margin: '0 4px' }} />
          {!tabDetails && <button type="button" className={`dp-ibtn dp-lg${showInspector ? ' dp-on' : ''}`} title="Inspector  ⌘I" onClick={() => setInspector((x) => !x)}><Icon name="panel-right" /></button>}
          <button type="button" className="dp-ibtn dp-lg" title="Light / dark  ⌘⇧L" onClick={() => setThemeMode(theme.resolved === 'dark' ? 'light' : 'dark')}><Icon name={theme.resolved === 'dark' ? 'sun' : 'moon'} /></button>
          <button type="button" className="dp-btn dp-sm" title="Turn the new workbench off" onClick={() => { prefs.set('workbench', 'off'); location.hash = `#/work/${slug}`; }}>Today’s UI</button>
        </div>
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
        <nav className={`dp-sidebar${prefs.shell === 'B' ? ' dp-classic' : ''}`}>
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

        <div className="dp-wb" ref={bench}>
          {layout.panes.map((pane, i) => (
            <React.Fragment key={i}>
              {i > 0 && <div className="dp-handle" title="Drag to resize · double-click to even out" onPointerDown={startResize} onDoubleClick={() => resize([1, 1])} />}
              <section className={`dp-group${layout.focused === i ? ' dp-focus' : ''}`} style={{ flex: layout.sizes[i] || 1 }} onMouseDown={() => focus(i)}
                onDragOver={(e) => { if (drag) e.preventDefault(); }} onDrop={() => { if (drag) move(drag, i); setDrag(null); }}>
                <div className="dp-strip">
                  <div className="dp-tabs">
                    {pane.tabs.map((t) => (
                      <div key={t} draggable className={`dp-tab${pane.active === t ? ' dp-on' : ''}`} onClick={() => activate(i, t)} onDragStart={() => setDrag(t)} onDragEnd={() => setDrag(null)} title={isPrTab(t) ? 'PR details' : undefined}>
                        <Icon name={tabIcon(t)} /><span className="dp-lbl">{tabLabel(t)}</span>
                        {tabCount[t] !== undefined && <span className={`dp-count${t === 'ask' && waiting.length ? ' dp-acc' : ''}`}>{tabCount[t]}</span>}
                        <button type="button" className="dp-ibtn dp-x" title="Close" onClick={(e) => { e.stopPropagation(); close(t); }}><Icon name="x" size={12} /></button>
                      </div>
                    ))}
                  </div>
                  <div className="dp-acts">
                    <button type="button" className="dp-ibtn" title={layout.panes.length > 1 ? 'Join panes  ⌘\\' : 'Split right  ⌘\\'} onClick={split}><Icon name="columns" /></button>
                    {layout.panes.length === 1 && drag && <div className="dp-chip dp-acc" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.stopPropagation(); move(drag, 1); setDrag(null); }}>Drop to split</div>}
                  </div>
                </div>
                {pane.tabs.map((t) => (
                  <div key={t} className={`dp-panel${pane.active === t ? ' dp-on' : ''}`}>
                    {pane.active === t && <Panel tab={t} d={d} onOpenPr={openPr} onOpen={openTab} selected={selected} onSelect={setSelected} />}
                  </div>
                ))}
              </section>
            </React.Fragment>
          ))}
        </div>

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
        <span className="dp-sbi">Layout: {preset}</span>
        <span className="dp-sbi" onClick={() => setPalette(true)}><kbd>⌘</kbd><kbd>K</kbd>Commands</span>
        <span className="dp-sbi" onClick={split}><kbd>⌘</kbd><kbd>\</kbd>Split</span>
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
  const ctx: WorkData = { ...d.work, w };
  return (
    <WorkContext.Provider value={ctx}>
      <div className="dp"><Bench d={{ ...d, work: ctx }} slug={slug} /></div>
    </WorkContext.Provider>
  );
}

export type { PrefKey };
