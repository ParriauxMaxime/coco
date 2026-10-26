import React, { useRef, useState } from 'react';
import { cycleTheme, useTheme } from '../theme.ts';
import type { ThemeMode } from '../theme.ts';
import { useConfig } from '../config.ts';
import { api } from '../api.ts';
import type { Persona, RepoGroup, Skill, WorkProgress, WorkSummary } from '../types.ts';

export type Nav = { works: WorkSummary[]; repos: RepoGroup[]; personas: Persona[]; skills: Skill[]; projects: number; running: number };

const Icon = ({ d }: { d: string[] }) => (
  <svg className="ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.map((p, i) => <path key={i} d={p} />)}
  </svg>
);
const ICONS = {
  dashboard: ['M3 13h8V3H3z', 'M13 21h8V11h-8z', 'M3 21h8v-6H3z', 'M13 3v6h8V3z'],
  projects: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  agents: ['M12 8V4', 'M8 4h8', 'M5 8h14v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z', 'M9 13h.01', 'M15 13h.01', 'M9 17h6'],
  rituals: ['M12 3v3', 'M12 18v3', 'M3 12h3', 'M18 12h3', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
  rules: ['M8 6h12', 'M8 12h12', 'M8 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  archive: ['M3 4h18v4H3z', 'M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8', 'M10 12h4'],
};

const usePersisted = (key: string, initial: boolean): [boolean, () => void] => {
  const [v, setV] = useState(() => { const s = localStorage.getItem(key); return s === null ? initial : s === '1'; });
  return [v, () => { localStorage.setItem(key, v ? '0' : '1'); setV(!v); }];
};

type SectionProps = { id: string; title: string; count?: number; extra?: React.ReactNode; defaultOpen?: boolean; handle?: React.HTMLAttributes<HTMLButtonElement> & { draggable?: boolean }; className?: string; children?: React.ReactNode };
function Section({ id, title, count, extra, defaultOpen = true, handle, className = '', children }: SectionProps) {
  const [open, toggle] = usePersisted(`nav:${id}`, defaultOpen);
  return (
    <div className={`nav-section ${className}`}>
      <button className="group" onClick={toggle} aria-expanded={open} {...handle}>
        <span className={`caret ${open ? 'open' : ''}`}>▸</span>{title}{count != null && <span className="gcount">{count}</span>}
        {extra}
      </button>
      {open && children}
    </div>
  );
}

type Dragged = { kind: 'repo'; id: string } | { kind: 'work'; repo: string; slug: string };
// `item` lands where `target` was: after it when moving down, before it when moving up
const moveBefore = (list: string[], item: string, target: string) => {
  const down = list.indexOf(item) < list.indexOf(target);
  const out = list.filter((x) => x !== item);
  out.splice(out.indexOf(target) + (down ? 1 : 0), 0, item);
  return out;
};
type DragProps = Pick<React.HTMLAttributes<HTMLElement>, 'onDragStart' | 'onDragOver' | 'onDragLeave' | 'onDrop' | 'onDragEnd'>;

function WorkLink({ w, on, onClose, drag, over }: { w: WorkSummary; on: boolean; onClose: () => void; drag: DragProps; over: boolean }) {
  const p: Partial<WorkProgress> = w.progress || {};
  const total = w.stack || 1;
  const seg = (n: number | undefined, st: string) => Array.from({ length: n || 0 }, (_, i) => <i key={`${st}-${i}`} className={`st-${st}`} style={{ flex: 1 }} title={`${n} ${st}`} />);
  return (
    <a className={`nav work ${on ? 'on' : ''} ${w.archived ? 'archived' : ''} ${over ? 'drop-over' : ''}`} href={`#/work/${w.slug}`} onClick={onClose} title={w.title} draggable {...drag}>
      <span className="work-title">{p.attention && <span className="attn" title="changes requested or CI failing" />}{w.title}{p.restack && <span className="chip c-orange" title="a parent PR merged: its children still sit on the old base">restack</span>}</span>
      <span className="work-meta">
        <span className="bar">{seg(p.merged, 'merged')}{seg(p.ready, 'ready')}{seg(p.draft, 'draft')}{seg(p.planned, 'planned')}{seg(p.closed, 'closed')}{!w.stack && <i className="st-planned" style={{ flex: 1 }} />}</span>
        <span className="frac">{w.archived ? 'archived' : `${p.merged || 0}/${total - (p.closed || 0)}`}</span>
      </span>
    </a>
  );
}

const THEME_ICON: Record<ThemeMode, string> = { system: '◐', light: '☀︎', dark: '☾' };

function ThemeToggle() {
  const { mode } = useTheme();
  return (
    <button className="theme-toggle" onClick={cycleTheme} title={`Theme: ${mode} (Cmd/Ctrl+Shift+L)`} aria-label={`Theme: ${mode}. Click to change`}>
      <span aria-hidden="true">{THEME_ICON[mode]}</span>{mode}
    </button>
  );
}

type SidebarProps = { route: string; open: boolean; onClose: () => void; nav: Nav };

export default function Sidebar({ route, open, onClose, nav }: SidebarProps) {
  const [root, a] = route.split('/').filter(Boolean);
  const is = (r: string, x?: string) => root === r && (!x || a === x);
  const Link = ({ href, on, icon, children }: { href: string; on: boolean; icon: React.ReactNode; children?: React.ReactNode }) => (
    <a className={`nav ${on ? 'on' : ''}`} href={href} onClick={onClose}>{icon}{children}</a>
  );
  const archivedCount = nav.works.filter((w) => w.archived).length;
  const bySlug = new Map(nav.works.map((w) => [w.slug, w]));
  // reorders show at once; the next overview poll brings the saved order back
  const [moved, setMoved] = useState<{ from: RepoGroup[]; to: RepoGroup[] } | null>(null);
  const groups = moved?.from === nav.repos ? moved.to : nav.repos;
  const reorder = (to: RepoGroup[]) => setMoved({ from: nav.repos, to });
  const dragging = useRef<Dragged | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const dragProps = (item: Dragged, key: string, drop: () => void): DragProps => ({
    onDragStart: (e) => { e.stopPropagation(); dragging.current = item; e.dataTransfer.effectAllowed = 'move'; },
    onDragOver: (e) => { if (dragging.current?.kind !== item.kind) return; e.preventDefault(); e.stopPropagation(); setOver(key); },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    onDrop: (e) => { e.preventDefault(); e.stopPropagation(); setOver(null); drop(); },
    onDragEnd: () => { dragging.current = null; setOver(null); },
  });
  const dropRepo = (target: string) => {
    const d = dragging.current;
    if (d?.kind !== 'repo' || d.id === target) return;
    const ids = moveBefore(groups.map((g) => g.id), d.id, target);
    reorder(ids.flatMap((id) => groups.filter((g) => g.id === id)));
    api.saveLayout({ repos: ids }).catch(() => {});
  };
  // a work moves inside its repo only
  const dropWork = (repo: string, target: string) => {
    const d = dragging.current;
    if (d?.kind !== 'work' || d.repo !== repo || d.slug === target) return;
    const g = groups.find((x) => x.id === repo);
    if (!g) return;
    const slugs = moveBefore(g.works, d.slug, target);
    reorder(groups.map((x) => (x.id === repo ? { ...x, works: slugs } : x)));
    api.saveLayout({ repo, works: slugs }).catch(() => {});
  };
  const meLogin = useConfig((s) => s.owner.login);
  const hasRituals = useConfig((s) => s.rituals.length > 0);
  const me = nav.personas.find((p) => p.login === meLogin) || nav.personas.find((p) => p.kind === 'writer');
  const reviewers = nav.personas.filter((p) => p !== me && p.kind !== 'writer');
  const firstName = (p: Persona) => p.title.replace(/ — .*$/, '');
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <a className="brand" href="#/" onClick={onClose}><i>🦜</i> cocopilot</a>
      <nav className="primary">
        <Link href="#/" on={!root} icon={<Icon d={ICONS.dashboard} />}>Dashboard</Link>
        <Link href="#/inbox" on={is('inbox')} icon={<Icon d={ICONS.inbox} />}>Inbox</Link>
        <Link href="#/projects" on={is('projects')} icon={<Icon d={ICONS.projects} />}>Projects <span className="n">{nav.projects}</span></Link>
        <Link href="#/agents" on={is('agents')} icon={<Icon d={ICONS.agents} />}>Agents {nav.running > 0 && <span className="n live"><span className="dot run" />{nav.running}</span>}</Link>
        {hasRituals && <Link href="#/rituals" on={is('rituals')} icon={<Icon d={ICONS.rituals} />}>Rituals</Link>}
        <Link href="#/rules" on={is('rules')} icon={<Icon d={ICONS.rules} />}>Rules</Link>
        {archivedCount > 0 && <Link href="#/archive" on={is('archive')} icon={<Icon d={ICONS.archive} />}>Archive <span className="n">{archivedCount}</span></Link>}
        <a className={`nav ask ${is('ask') ? 'on' : ''}`} href="#/ask" onClick={onClose}><span className="ico emoji">🦜</span>Ask coco</a>
      </nav>

      {groups.map((g) => {
        const list = g.works.map((s) => bySlug.get(s)).filter((w): w is WorkSummary => Boolean(w) && !w?.archived);
        return (
          <Section
            key={g.id}
            id={`repo:${g.id}`}
            title={g.name}
            count={list.length}
            className={over === `repo:${g.id}` ? 'drop-over' : ''}
            handle={{ draggable: true, title: g.github || g.name, ...dragProps({ kind: 'repo', id: g.id }, `repo:${g.id}`, () => dropRepo(g.id)) }}
          >
            {list.map((w) => <WorkLink key={w.slug} w={w} on={is('work', w.slug)} onClose={onClose} over={over === `work:${w.slug}`} drag={dragProps({ kind: 'work', repo: g.id, slug: w.slug }, `work:${w.slug}`, () => dropWork(g.id, w.slug))} />)}
            {list.length === 0 && <div className="nav-empty">No work yet</div>}
          </Section>
        );
      })}

      <Section id="personas" title="Personas" count={reviewers.length}>
        <div className="people">
          {reviewers.map((p) => (
            <a key={p.login} className={`person ${is('persona', p.login) ? 'on' : ''}`} href={`#/persona/${p.login}`} onClick={onClose} title={`${firstName(p)} · ${p.login}`}>
              <img src={`/api/avatar/${p.login}`} alt="" loading="lazy" />
              <span>{firstName(p).split(' ')[0]}</span>
            </a>
          ))}
        </div>
        {me && <a className={`nav me ${is('persona', me.login) ? 'on' : ''}`} href={`#/persona/${me.login}`} onClick={onClose}><img className="ava" src={`/api/avatar/${me.login}`} alt="" />My voice</a>}
      </Section>

      <Section id="skills" title="Skills" count={nav.skills.length} defaultOpen={false}>
        {nav.skills.map((s) => <a key={s.name} className={`nav skill ${is('skill', s.name) ? 'on' : ''}`} href={`#/skill/${s.name}`} onClick={onClose}>{s.name}</a>)}
      </Section>

      <div className="sidebar-foot"><ThemeToggle /></div>
    </aside>
  );
}
