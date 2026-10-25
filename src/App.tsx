import React, { useEffect, useState } from 'react';
import Dashboard from './pages/Dashboard.tsx';
import Persona from './pages/Persona.tsx';
import Skill from './pages/Skill.tsx';
import Agents from './pages/Agents.tsx';
import Rituals from './pages/Rituals.tsx';
import Projects from './pages/Projects.tsx';
import NewWork from './pages/NewWork.tsx';
import Workbench from './workbench/Workbench.tsx';
import { useWorkbench } from './workbench/workbench-store.ts';
import Ask from './pages/Ask.tsx';
import Rules from './components/Rules.tsx';
import Inbox from './pages/Inbox.tsx';
import { api } from './api.ts';
import Sidebar from './components/Sidebar.tsx';
import type { Nav } from './components/Sidebar.tsx';
import Toasts from './components/Toast.tsx';

const useHash = () => {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#/, '');
};


function crumbs(route: string, nav: Nav, tabTitle?: string | null) {
  const [root, a, b] = route.split('/').filter(Boolean);
  const out: [string, string][] = [['#/', 'Dashboard']];
  if (root === 'projects') out.push(['#/projects', 'Projects']);
  if (root === 'agents') out.push(['#/agents', 'Agents']);
  if (root === 'rituals') out.push(['#/rituals', 'Rituals']);
  if (root === 'ask') out.push(['#/ask', 'Ask coco']);
  if (root === 'rules') out.push(['#/rules', 'Rules']);
  if (root === 'inbox') out.push(['#/inbox', 'Inbox']);
  if (root === 'work') {
    out.push(['#/projects', 'Projects']);
    const w = nav.works.find((x) => x.slug === a);
    out.push([`#/work/${a}`, w ? w.title : a]);
    if (a !== 'new' && tabTitle) out.push([`#/work/${a}/${b || 'plan'}`, tabTitle]);
  }
  if (root === 'persona') {
    out.push(['#/', 'Personas']);
    const p = nav.personas.find((x) => x.login === a);
    out.push([`#/persona/${a}`, p ? p.title.replace(/ — .*$/, '') : a]);
    if (b) out.push([`#/persona/${a}/${b}`, b]);
  }
  if (root === 'skill') {
    out.push(['#/', 'Skills']);
    out.push([`#/skill/${a}`, a]);
    if (b) out.push([`#/skill/${a}/${b}`, b]);
  }
  return out;
}

export default function App() {
  const route = useHash();
  const tabTitle = useWorkbench((s) => s.title);
  const [root, a, b, c] = route.split('/').filter(Boolean);
  const [open, setOpen] = useState(false);
  const [nav, setNav] = useState<Nav>({ works: [], personas: [], skills: [], projects: 0, running: 0 });
  useEffect(() => {
    const load = () => api.overview().then((d) => setNav({ works: d.works || [], personas: d.personas, skills: d.skills, projects: d.projectCount || 0, running: d.agents.filter((x) => x.status === 'running').length })).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [route]);
  let page;
  if (!root) page = <Dashboard />;
  else if (root === 'persona' && a) page = <Persona login={decodeURIComponent(a)} tab={b} />;
  else if (root === 'skill' && a) page = <Skill name={decodeURIComponent(a)} tab={b} />;
  else if (root === 'projects') page = <Projects />;
  else if (root === 'work' && a === 'new' && b) page = <NewWork projectId={b} projectName={decodeURIComponent(c || b)} />;
  else if (root === 'work' && a) page = <Workbench key={a} slug={a} />;
  else if (root === 'ask') page = <Ask />;
  else if (root === 'inbox') page = <Inbox />;
  else if (root === 'rules') page = <><h1>Rules</h1><Rules /></>;
  else if (root === 'agents') page = <Agents />;
  else if (root === 'rituals') page = <Rituals preset={a} />;
  else page = <div className="card">No such page.</div>;
  const trail = crumbs(route, nav, tabTitle);
  const bench = root === 'work' && a && a !== 'new';
  return (
    <div className="shell">
      <Sidebar route={route} open={open} onClose={() => setOpen(false)} nav={nav} />
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <div className={`content ${bench ? 'wb' : ''}`}>
        <div className="topbar">
          <button className="menu-btn sm" onClick={() => setOpen(true)}>☰</button>
          <div className="crumbs">
            {trail.map(([href, label], i) => (
              <React.Fragment key={href + i}>
                {i > 0 && <span className="sep">/</span>}
                {i === trail.length - 1 ? <b>{label}</b> : <a href={href}>{label}</a>}
              </React.Fragment>
            ))}
          </div>
        </div>
        {bench ? page : <main>{page}</main>}
      </div>
      <Toasts />
    </div>
  );
}
