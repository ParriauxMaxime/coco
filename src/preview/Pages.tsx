import React from 'react';
import Shell from './Shell.tsx';
import type { Crumb } from './Shell.tsx';
import { useOverview } from './overview.ts';
import { Empty, Page } from './pages/Page.tsx';
import DashboardPage from './pages/DashboardPage.tsx';
import InboxPage from './pages/InboxPage.tsx';
import WaitingPage from './pages/WaitingPage.tsx';
import ArchivePage from './pages/ArchivePage.tsx';
import AgentsPage from './pages/AgentsPage.tsx';
import AgentPage from './pages/AgentPage.tsx';
import NewAgentPage from './pages/NewAgentPage.tsx';
import ProjectsPage from './pages/ProjectsPage.tsx';
import RepoPage, { NewRepoPage } from './pages/RepoPage.tsx';
import NewWorkPage from './pages/NewWorkPage.tsx';
import PersonaPage from './pages/PersonaPage.tsx';
import SkillPage from './pages/SkillPage.tsx';
import RitualsPage from './pages/RitualsPage.tsx';
import SchedulesPage from './pages/SchedulesPage.tsx';
import RulesPage from './pages/RulesPage.tsx';
import AskPage from './pages/AskPage.tsx';
import PurgePage from './pages/PurgePage.tsx';
import SettingsPage from './pages/SettingsPage.tsx';
import WorksPage from './pages/WorksPage.tsx';
import type { Overview } from '../types.ts';

const dec = (s?: string) => (s ? decodeURIComponent(s) : undefined);

function routed(parts: string[], ov: Overview | null): { crumbs: Crumb[]; node: React.ReactNode } {
  const [root = '', a, b, c] = parts;
  const id = dec(a) ?? '';
  const page = (label: string, href?: string): Crumb => ({ label, href });
  if (!root) return { crumbs: [page('Dashboard')], node: <DashboardPage /> };
  if (root === 'inbox') return { crumbs: [page('Inbox')], node: <InboxPage /> };
  if (root === 'waiting') return { crumbs: [page('Waiting on you')], node: <WaitingPage ov={ov} /> };
  if (root === 'works') return { crumbs: [page('Works')], node: <WorksPage /> };
  if (root === 'archive') return { crumbs: [page('Archive')], node: <ArchivePage /> };
  if (root === 'purge') return { crumbs: [page('Purge')], node: <PurgePage /> };
  if (root === 'settings') return { crumbs: [page('Settings')], node: <SettingsPage /> };
  if (root === 'agents' && a?.split('?')[0] === 'new') {
    const place = new URLSearchParams(a.split('?')[1] || '').get('place');
    return { crumbs: [page('Agents', '#/agents'), page('New agent')], node: <NewAgentPage key={place || ''} place={place} /> };
  }
  if (root === 'agents' && a) return { crumbs: [page('Agents', '#/agents'), page(ov?.agents.find((x) => x.id === id)?.name || id.slice(0, 8))], node: <AgentPage key={id} agentId={id} toWaiting={b === 'waiting'} /> };
  if (root === 'agents') return { crumbs: [page('Agents')], node: <AgentsPage /> };
  if (root === 'projects') return { crumbs: [page('Projects')], node: <ProjectsPage /> };
  if (root === 'rules') return { crumbs: [page('Rules')], node: <RulesPage /> };
  if (root === 'schedules') {
    const [sid, q] = (a ?? '').split('?');
    const label = !sid ? null : sid === 'new' ? 'New schedule' : b === 'edit' ? 'Edit' : dec(sid)!;
    return { crumbs: [page('Schedules', label ? '#/schedules' : undefined), ...(label ? [page(label)] : [])], node: <SchedulesPage id={dec(sid) || undefined} edit={b === 'edit'} query={q || ''} /> };
  }
  if (root === 'rituals') return { crumbs: [page('Rituals')], node: <RitualsPage key={id} preset={a} /> };
  if (root === 'ask') return { crumbs: [page('Ask coco', a ? '#/ask' : undefined), ...(a ? [page(id.slice(0, 8))] : [])], node: <AskPage key={id} convId={a} /> };
  if (root === 'repos' && a === 'new') return { crumbs: [page('Projects', '#/projects'), page('New repo')], node: <NewRepoPage /> };
  if (root === 'repo' && a) return { crumbs: [page('Projects', '#/projects'), page(ov?.repos.find((r) => r.id === id)?.name || id)], node: <RepoPage key={id} id={id} section={b} /> };
  if (root === 'work' && a === 'new' && b) return { crumbs: [page('Projects', '#/projects'), page('New work')], node: <NewWorkPage projectId={b} projectName={dec(c) || b} /> };
  if (root === 'persona' && a) {
    const p = ov?.personas.find((x) => x.login === id);
    return { crumbs: [page('Personas'), page(p ? p.title.replace(/ — .*$/, '') : id)], node: <PersonaPage key={id} login={id} tab={b} /> };
  }
  if (root === 'skill' && a) return { crumbs: [page('Skills'), page(id)], node: <SkillPage key={id} name={id} tab={b} /> };
  return { crumbs: [page('Not found')], node: <Page><Empty icon="alert-triangle">No such page.</Empty></Page> };
}

// every route outside a work, inside the new workbench's shell
export default function Pages({ route }: { route: string }) {
  const { ov } = useOverview();
  const parts = route.split('/').filter(Boolean);
  const { crumbs, node } = routed(parts, ov);
  return <Shell ov={ov} root={parts[0] === 'repos' ? 'repos' : parts[0] || ''} crumbs={crumbs}>{node}</Shell>;
}
