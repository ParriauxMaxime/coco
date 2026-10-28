import React, { useEffect, useState } from 'react';
import { PendingPermissions, usePendingPermissions } from './chat/Permission.tsx';
import { setThemeMode, useTheme } from '../theme.ts';
import { useConfig } from '../config.ts';
import Icon from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import BetaPanel from './BetaPanel.tsx';
import { useWaiting } from './waiting.ts';
import AgentsSection from './AgentsSection.tsx';
import { CHOICES, useBetaPanel, usePrefs, workHref } from './prefs.ts';
import type { Overview, WorkSummary } from '../types.ts';
import JobsStatus from './JobsStatus.tsx';
import './preview.css';

export type Command = { id: string; label: string; hint?: string; icon: IconName; run: () => void };
export type Crumb = { label: string; href?: string };

export const VIEWS: { id: string; label: string; icon: IconName }[] = [
  { id: 'plan', label: 'Overview', icon: 'home' },
  { id: 'stack', label: 'Stack', icon: 'list' },
  { id: 'findings', label: 'Findings', icon: 'flag' },
  { id: 'decisions', label: 'Decisions', icon: 'scale' },
  { id: 'timeline', label: 'Timeline', icon: 'history' },
  { id: 'notes', label: 'Notes', icon: 'notebook' },
  { id: 'artifacts', label: 'Artifacts', icon: 'folder' },
];

type NavItem = { href: string; root: string; label: string; icon: IconName };
const NAV: NavItem[] = [
  { href: '#/', root: '', label: 'Dashboard', icon: 'home' },
  { href: '#/inbox', root: 'inbox', label: 'Inbox', icon: 'inbox' },
  { href: '#/waiting', root: 'waiting', label: 'Waiting on you', icon: 'clock' },
  { href: '#/agents', root: 'agents', label: 'Agents', icon: 'bot' },
  { href: '#/projects', root: 'projects', label: 'Projects', icon: 'layers' },
  { href: '#/rituals', root: 'rituals', label: 'Rituals', icon: 'sparkles' },
  { href: '#/rules', root: 'rules', label: 'Rules', icon: 'scale' },
  { href: '#/archive', root: 'archive', label: 'Archive', icon: 'archive' },
  { href: '#/purge', root: 'purge', label: 'Purge', icon: 'trash' },
  { href: '#/ask', root: 'ask', label: 'Ask coco', icon: 'message-square' },
];

const NARROW = '(max-width: 900px)';
export const useNarrow = () => {
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

const readList = (key: string): string[] => { try { const v: unknown = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
const usePersistedList = (key: string, initial: (saved: string[]) => string[]) => {
  const [list, setList] = useState(() => initial(readList(key)));
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(list)); } catch {} }, [list]);
  const toggle = (s: string) => setList((l) => (l.includes(s) ? l.filter((x) => x !== s) : [...l, s]));
  return { list, toggle };
};

// open PRs by current milestone, furthest first
export const MILESTONE_ORDER = ['approved', 'ready', 'pushed', 'kit', 'self-review'];

export function SegBar({ w, thin = true }: { w: WorkSummary; thin?: boolean }) {
  const p = w.progress;
  const open = p.ready + p.draft;
  const steps = MILESTONE_ORDER.flatMap((id) => Array<string>(p.milestones?.[id] || 0).fill(id)).slice(0, open);
  const seg = (cls: string, title: string) => (_: unknown, i: number) => <i key={`${cls}-${i}`} className={cls} title={title} />;
  const segs = steps.length
    ? [
        ...Array.from({ length: p.merged }, seg('dp-st-merged', 'merged')),
        ...steps.map((id, i) => seg(`dp-ms-${id}`, `next: ${id}`)(null, i)),
        ...Array.from({ length: open - steps.length }, seg('dp-st-draft', 'open')),
        ...Array.from({ length: p.planned }, seg('dp-st-planned', 'planned')),
        ...Array.from({ length: p.closed }, seg('dp-st-closed', 'closed')),
      ]
    : SEGMENTS.flatMap(([k, state]) => Array.from({ length: Number(p[k]) || 0 }, (_, i) => <i key={`${state}-${i}`} className={`dp-st-${state}`} />));
  return <span className={`dp-segs${thin ? ' dp-thin' : ''} dp-grow`}>{segs.length ? segs : <i className="dp-st-planned" />}</span>;
}
export const workDot = (w: WorkSummary) => (w.progress.attention ? 'dp-st-changes' : w.progress.ready + w.progress.draft ? 'dp-st-draft' : 'dp-st-planned dp-hollow');

function WorkRow({ w, on, expanded, onToggle, views }: { w: WorkSummary; on: boolean; expanded: boolean; onToggle: () => void; views: React.ReactNode }) {
  const p = w.progress;
  return (
    <>
      <a className={`dp-work dp-work2${on ? ' dp-on' : ''}`} href={workHref(w.slug)} title={w.title} onClick={() => { if (!expanded) onToggle(); }}>
        <span className="dp-work-top">
          <button type="button" className={`dp-caret${expanded ? ' dp-open' : ''}`} aria-label={expanded ? 'Collapse' : 'Expand'} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}><Icon name="chevron-right" size={12} /></button>
          <span className={`dp-dot dp-lg ${workDot(w)}`} />
          <span className="dp-grow dp-ell">{w.title}</span>
          {p.restack && <span className="dp-chip dp-warn" title="A parent PR merged: its children still sit on the old base">restack</span>}
        </span>
        <span className="dp-work-bar">
          <SegBar w={w} />
          <span className="dp-pc">{w.archived ? 'archived' : `${p.merged}/${w.stack - p.closed}`}</span>
        </span>
      </a>
      <div className={`dp-collapse${expanded ? ' dp-open' : ''}`}><div>{views}</div></div>
    </>
  );
}

// a work's views and agents; off its page each one opens the work on that tab
export function WorkViews({ w, open, isOpen, count, prs }: { w: WorkSummary; open?: (id: string) => void; isOpen?: (id: string) => boolean; count?: (id: string) => number | undefined; prs?: React.ComponentProps<typeof AgentsSection>['prs'] }) {
  const go = (id: string) => (open ? open(id) : (location.hash = `${workHref(w.slug)}/${id}`));
  return (
    <div className="dp-views">
      {VIEWS.map((v) => {
        const n = count ? count(v.id) : v.id === 'stack' ? w.stack || undefined : undefined;
        return (
          <div key={v.id} className={`dp-view${isOpen?.(v.id) ? ' dp-open' : ''}`} onClick={() => go(v.id)}>
            <Icon name={v.icon} size={14} /><span>{v.label}</span>
            {n !== undefined && <span className="dp-count">{n}</span>}
          </div>
        );
      })}
      <AgentsSection slug={w.slug} live={Boolean(open)} prs={prs || []} onOpen={go} />
    </div>
  );
}

function WorkTree({ ov, slug, views, repo }: { ov: Overview | null; slug?: string; views: (w: WorkSummary) => React.ReactNode; repo?: string }) {
  const works = new Map((ov?.works || []).filter((w) => !w.archived).map((w) => [w.slug, w]));
  const repos = (ov?.repos || []).filter((r) => !repo || r.id === repo);
  const { list: expanded, toggle } = usePersistedList('cc.dp.expanded', (l) => (!slug || l.includes(slug) ? l : [...l, slug]));
  return (
    <>
      {repos.map((r) => (
        <React.Fragment key={r.id}>
          {!repo && <a className="dp-repo" href={`#/repo/${r.id}`}><Icon name="git-branch" size={14} /><span>{r.name}</span><span className="dp-gh-name">{r.github.split('/')[0]}</span></a>}
          {r.works.map((s) => works.get(s)).filter((w): w is WorkSummary => Boolean(w)).map((w) => (
            <WorkRow key={w.slug} w={w} on={w.slug === slug} expanded={expanded.includes(w.slug)} onToggle={() => toggle(w.slug)} views={views(w)} />
          ))}
        </React.Fragment>
      ))}
    </>
  );
}

function SbGroup({ id, label, icon, count, children }: { id: string; label: string; icon: IconName; count?: number; children: React.ReactNode }) {
  const { list: open, toggle } = usePersistedList('cc.dp.groups', (l) => l);
  const on = open.includes(id);
  return (
    <>
      <div className="dp-sb-group dp-sb-fold" onClick={() => toggle(id)}>
        <span className={`dp-caret${on ? ' dp-open' : ''}`}><Icon name="chevron-right" size={12} /></span>
        <Icon name={icon} size={14} />{label}{count !== undefined && <span className="dp-count">{count}</span>}
      </div>
      <div className={`dp-collapse${on ? ' dp-open' : ''}`}><div>{children}</div></div>
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
          <input autoFocus value={q} placeholder="Jump to a page, work, PR, view or persona…" onChange={(e) => { setQ(e.target.value); setHl(0); }}
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

type ShellProps = {
  ov: Overview | null;
  // the route's first segment, '' on the dashboard: marks its nav entry
  root: string;
  crumbs: Crumb[];
  slug?: string;
  attention?: boolean;
  titleRight?: React.ReactNode;
  views?: (w: WorkSummary) => React.ReactNode;
  // the repo rail's choice (shell C) and what its sidebar adds under the works
  repo?: string | null;
  onRepo?: (id: string) => void;
  sidebarExtra?: React.ReactNode;
  status?: React.ReactNode;
  statusRight?: React.ReactNode;
  commands?: Command[];
  // with the questions-as-tab variant, where waiting on you opens
  onWaitingTab?: () => void;
  children: React.ReactNode;
};

// title bar, activity bar, works sidebar and status bar around any page of the new workbench
export default function Shell({ ov, root, crumbs, slug, attention, titleRight, views, repo, onRepo, sidebarExtra, status, statusRight, commands = [], onWaitingTab, children }: ShellProps) {
  const prefs = usePrefs();
  const theme = useTheme();
  const { open: controls, toggle: toggleControls } = useBetaPanel();
  const { pending } = usePendingPermissions();
  const queue = useWaiting();
  const hasRituals = useConfig((s) => s.rituals.length > 0);
  const [palette, setPalette] = useState(false);
  const [waitOpen, setWaitOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const narrow = useNarrow();
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);

  const archived = (ov?.works || []).filter((w) => w.archived).length;
  const nav = NAV.filter((n) => (n.root !== 'rituals' || hasRituals) && (n.root !== 'archive' || archived > 0 || root === 'archive'));
  const running = (ov?.agents || []).filter((a) => a.status === 'running').length;
  const counts: Record<string, number | undefined> = { inbox: ov?.notices || undefined, waiting: queue?.count || undefined, archive: archived || undefined };
  const repoId = repo ?? null;
  const repoName = ov?.repos.find((r) => r.id === repoId)?.name;
  const reviewers = (ov?.personas || []).filter((p) => p.kind !== 'writer');
  const writers = (ov?.personas || []).filter((p) => p.kind === 'writer');
  const firstName = (title: string) => title.replace(/ — .*$/, '');
  const renderViews = views || ((w: WorkSummary) => <WorkViews w={w} />);

  const go = (href: string) => () => { location.hash = href; };
  const all: Command[] = [
    ...commands,
    ...nav.map((n) => ({ id: `nav-${n.root || 'home'}`, label: n.label, hint: 'page', icon: n.icon, run: go(n.href) })),
    { id: 'new-repo', label: 'New repo', hint: 'page', icon: 'plus', run: go('#/repos/new') },
    ...(ov?.works || []).filter((w) => !w.archived && w.slug !== slug).map((w) => ({ id: `w-${w.slug}`, label: w.title, hint: 'work', icon: 'layers' as const, run: go(workHref(w.slug)) })),
    ...(ov?.repos || []).map((r) => ({ id: `r-${r.id}`, label: r.name, hint: 'repo', icon: 'git-branch' as const, run: go(`#/repo/${r.id}`) })),
    ...(ov?.personas || []).map((p) => ({ id: `p-${p.login}`, label: firstName(p.title), hint: 'persona', icon: 'user' as const, run: go(`#/persona/${p.login}`) })),
    ...(ov?.skills || []).map((s) => ({ id: `s-${s.name}`, label: s.name, hint: 'skill', icon: 'book' as const, run: go(`#/skill/${s.name}`) })),
    ...CHOICES.flatMap((c) => c.options.map((o) => ({ id: `c-${c.key}-${o.value}`, label: `${c.label}: ${o.label}`, hint: prefs[c.key] === o.value ? 'current' : 'variant', icon: 'eye' as const, run: () => prefs.set(c.key, o.value) }))),
    { id: 'theme', label: `Theme: ${theme.resolved === 'dark' ? 'light' : 'dark'}`, hint: '⌘⇧L', icon: theme.resolved === 'dark' ? 'sun' : 'moon', run: () => setThemeMode(theme.resolved === 'dark' ? 'light' : 'dark') },
  ];

  const waiting = slug ? pending.filter((p) => !p.where || p.where.href.includes(slug)) : pending;
  const navLink = (n: NavItem, withLabel: boolean) => (
    <a key={n.href} className={withLabel ? `dp-sb-nav${root === n.root ? ' dp-on' : ''}` : `dp-ibtn${root === n.root ? ' dp-on' : ''}`} href={n.href} title={n.label}>
      <Icon name={n.icon} />{withLabel && <span>{n.label}</span>}
      {counts[n.root] !== undefined && <span className={`dp-count${n.root === 'inbox' || n.root === 'waiting' ? ' dp-acc' : ''}`}>{counts[n.root]}</span>}
      {n.root === 'agents' && running > 0 && <span className="dp-count" title={`${running} running`}>{running}</span>}
    </a>
  );

  return (
    <div className="dp">
      <div className="dp-app">
        <header className="dp-titlebar">
          <button type="button" className={`dp-ibtn dp-lg dp-menu${menu ? ' dp-on' : ''}`} title="Pages and works" onClick={() => setMenu((m) => !m)}><Icon name="list" /></button>
          <a className="dp-brandmark" href="#/" title="Dashboard">c</a>
          <div className="dp-crumbs">
            {crumbs.map((c, i) => (
              <React.Fragment key={`${c.label}-${i}`}>
                {i > 0 && <span className="dp-sl">/</span>}
                {i === crumbs.length - 1 ? <b className="dp-ell">{c.label}</b> : c.href ? <a className="dp-crumb" href={c.href}>{c.label}</a> : <span>{c.label}</span>}
              </React.Fragment>
            ))}
            {attention && <span className="dp-chip dp-warn" style={{ marginLeft: 4 }}><Icon name="alert-triangle" size={12} />needs you</span>}
          </div>
          <div className="dp-cmdk" onClick={() => setPalette(true)}><Icon name="search" size={14} /><span className="dp-grow">Search pages, works, PRs, personas…</span><kbd>⌘</kbd><kbd>K</kbd></div>
          <div className="dp-row dp-g4">
            {titleRight}
            <button type="button" className="dp-ibtn dp-lg" title="Light / dark  ⌘⇧L" onClick={() => setThemeMode(theme.resolved === 'dark' ? 'light' : 'dark')}><Icon name={theme.resolved === 'dark' ? 'sun' : 'moon'} /></button>
          </div>
        </header>

        <div className="dp-body">
          {prefs.shell === 'A' && (
            <div className="dp-activity">
              {nav.map((n) => navLink(n, false))}
              <span className="dp-sp" />
              <button type="button" className={`dp-ibtn${controls ? ' dp-on' : ''}`} title="Beta features  ⌘." onClick={toggleControls}><Icon name="settings" /></button>
            </div>
          )}
          {prefs.shell === 'C' && (
            <div className="dp-activity" style={{ width: 52, gap: 6, paddingTop: 8 }}>
              {(ov?.repos || []).map((r) => (
                <button key={r.id} type="button" className={`dp-ibtn${r.id === repoId ? ' dp-on' : ''}`} title={r.name} style={{ width: 32, height: 32 }} onClick={() => (onRepo ? onRepo(r.id) : go(`#/repo/${r.id}`)())}>
                  <span className={`dp-rail-av${r.id === repoId ? ' dp-on' : ''}`}>{r.name.slice(0, 1).toUpperCase()}</span>
                </button>
              ))}
              <span className="dp-sp" />
              {nav.slice(0, 3).map((n) => navLink(n, false))}
              <button type="button" className={`dp-ibtn${controls ? ' dp-on' : ''}`} title="Beta features  ⌘." onClick={toggleControls}><Icon name="settings" /></button>
            </div>
          )}
          <nav className={`dp-sidebar${prefs.shell === 'B' ? ' dp-classic' : ''}${menu ? ' dp-sb-open' : ''}`} onClick={(e) => { if (narrow && e.target instanceof Element && e.target.closest('a, .dp-view')) setMenu(false); }}>
            {prefs.shell === 'A' && <div className="dp-sb-head">Works</div>}
            {prefs.shell === 'C' && <div className="dp-sb-head">{repoName}<span className="dp-sp" /></div>}
            <div className="dp-sb-scroll">
              {(prefs.shell === 'B' || narrow) && nav.map((n) => navLink(n, true))}
              {(prefs.shell === 'B' || narrow) && <div className="dp-sb-group">Works</div>}
              <WorkTree ov={ov} slug={slug} views={renderViews} repo={prefs.shell === 'C' ? repoId || undefined : undefined} />
              <a className={`dp-sb-nav dp-sb-new${root === 'repos' ? ' dp-on' : ''}`} href="#/repos/new"><Icon name="plus" /><span>New repo</span></a>
              {sidebarExtra}
              {reviewers.length > 0 && (
                <SbGroup id="personas" label="Personas" icon="users" count={reviewers.length}>
                  <div className="dp-sb-people">
                    {reviewers.map((p) => (
                      <a key={p.login} className={`dp-sb-person${root === 'persona' && location.hash.includes(`/${p.login}`) ? ' dp-on' : ''}`} href={`#/persona/${p.login}`} title={`${firstName(p.title)} · ${p.login}`}>
                        <img src={`/api/avatar/${p.login}`} alt="" loading="lazy" /><span className="dp-ell">{firstName(p.title).split(' ')[0]}</span>
                      </a>
                    ))}
                  </div>
                  {writers.map((p) => <a key={p.login} className="dp-sb-nav" href={`#/persona/${p.login}`}><img className="dp-sb-av" src={`/api/avatar/${p.login}`} alt="" /><span>{firstName(p.title)}</span><span className="dp-xs dp-t3" style={{ marginLeft: 'auto' }}>voice</span></a>)}
                </SbGroup>
              )}
              {(ov?.skills || []).length > 0 && (
                <SbGroup id="skills" label="Skills" icon="book" count={ov?.skills.length}>
                  {ov?.skills.map((s) => <a key={s.name} className="dp-sb-nav dp-sb-skill" href={`#/skill/${s.name}`}><span className="dp-ell">{s.name}</span></a>)}
                </SbGroup>
              )}
            </div>
            {prefs.shell === 'B' && <div className="dp-sb-foot"><div className="dp-sb-nav" onClick={toggleControls}><Icon name="settings" /><span>Beta features</span><span className="dp-xs dp-t3" style={{ marginLeft: 'auto' }}>⌘.</span></div></div>}
          </nav>

          {children}
        </div>

        <footer className="dp-statusbar">
          {status}
          {!slug && running > 0 && <a className="dp-sbi" href="#/agents"><span className="dp-dot dp-live" />{running} agent{running > 1 ? 's' : ''} running</a>}
          <JobsStatus onOpenAgent={(j) => { location.hash = j.work ? `#/work/${encodeURIComponent(j.work)}/ag-${j.agentId}` : '#/agents'; }} />
          <span className="dp-sp" />
          {waiting.length > 0 && <span className="dp-sbi dp-wait" onClick={() => (prefs.questions === 'tab' && onWaitingTab ? onWaitingTab() : setWaitOpen((w) => !w))}><Icon name="message-square" />{waiting.length} waiting on you</span>}
          {statusRight}
          <span className="dp-sbi" onClick={() => setPalette(true)}><kbd>⌘</kbd><kbd>K</kbd>Commands</span>
          <span className="dp-sbi" onClick={toggleControls}><kbd>⌘</kbd><kbd>.</kbd>Beta</span>
        </footer>

        {waitOpen && (
          <div className="dp-pop dp-on dp-waitpop">
            <div className="dp-pop-h"><b>Waiting on you</b><span className="dp-count dp-acc">{waiting.length}</span><span className="dp-sp" /><button type="button" className="dp-ibtn" onClick={() => setWaitOpen(false)}><Icon name="x" size={14} /></button></div>
            <div className="dp-pop-s dp-waitpop-s"><PendingPermissions withWhere /></div>
          </div>
        )}
        {palette && <Palette commands={all} onClose={() => setPalette(false)} />}
        {controls && <BetaPanel />}
      </div>
    </div>
  );
}
