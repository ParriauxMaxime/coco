import React, { useState } from 'react';
import { cycleTheme, useTheme } from '../theme.ts';
import type { ThemeMode } from '../theme.ts';
import { useConfig } from '../config.ts';
import type { Persona, Skill, WorkProgress, WorkSummary } from '../types.ts';

export type Nav = { works: WorkSummary[]; personas: Persona[]; skills: Skill[]; projects: number; running: number };

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
};

const usePersisted = (key: string, initial: boolean): [boolean, () => void] => {
  const [v, setV] = useState(() => { const s = localStorage.getItem(key); return s === null ? initial : s === '1'; });
  return [v, () => { localStorage.setItem(key, v ? '0' : '1'); setV(!v); }];
};

type SectionProps = { id: string; title: string; count?: number; extra?: React.ReactNode; defaultOpen?: boolean; children?: React.ReactNode };
function Section({ id, title, count, extra, defaultOpen = true, children }: SectionProps) {
  const [open, toggle] = usePersisted(`nav:${id}`, defaultOpen);
  return (
    <div className="nav-section">
      <button className="group" onClick={toggle} aria-expanded={open}>
        <span className={`caret ${open ? 'open' : ''}`}>▸</span>{title}{count != null && <span className="gcount">{count}</span>}
        {extra}
      </button>
      {open && children}
    </div>
  );
}

function WorkLink({ w, on, onClose }: { w: WorkSummary; on: boolean; onClose: () => void }) {
  const p: Partial<WorkProgress> = w.progress || {};
  const total = w.stack || 1;
  const seg = (n: number | undefined, st: string) => Array.from({ length: n || 0 }, (_, i) => <i key={`${st}-${i}`} className={`st-${st}`} style={{ flex: 1 }} title={`${n} ${st}`} />);
  return (
    <a className={`nav work ${on ? 'on' : ''} ${w.archived ? 'archived' : ''}`} href={`#/work/${w.slug}`} onClick={onClose} title={w.title}>
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
  const [showArchived, toggleArchived] = usePersisted('showArchived', false);
  const Link = ({ href, on, icon, children }: { href: string; on: boolean; icon: React.ReactNode; children?: React.ReactNode }) => (
    <a className={`nav ${on ? 'on' : ''}`} href={href} onClick={onClose}>{icon}{children}</a>
  );
  const works = nav.works.filter((w) => showArchived || !w.archived);
  const archivedCount = nav.works.filter((w) => w.archived).length;
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
        <a className={`nav ask ${is('ask') ? 'on' : ''}`} href="#/ask" onClick={onClose}><span className="ico emoji">🦜</span>Ask coco</a>
      </nav>

      <Section id="works" title="Works" count={works.length} extra={archivedCount > 0 && <span className="gtoggle" onClick={(e) => { e.stopPropagation(); toggleArchived(); }}>{showArchived ? 'hide archived' : `+${archivedCount} archived`}</span>}>
        {works.map((w) => <WorkLink key={w.slug} w={w} on={is('work', w.slug)} onClose={onClose} />)}
        {works.length === 0 && <div className="nav-empty">No work yet</div>}
      </Section>

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
