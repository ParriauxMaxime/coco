import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { useShownInterval } from '../../resource.ts';
import Icon from '../Icon.tsx';
import { workHref } from '../prefs.ts';
import { Empty, ErrorNote, Loading, Page, PageHead, Section, Tiles } from './Page.tsx';
import type { PaseoAgent, PaseoProject, PaseoResponse } from '../../types.ts';
import './projects.css';

const AGENT_TONE: Record<string, string> = { running: 'dp-ag-running', idle: 'dp-ag-done', error: 'dp-ag-failed', closed: 'dp-ag-archived' };
const AGENTS_SHOWN = 8;
const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

function AgentLine({ a, where }: { a: PaseoAgent; where?: string }) {
  return (
    <div className="dp-proj-ag">
      <span className={`dp-ag-dot ${AGENT_TONE[a.status] || 'dp-ag-waiting'}`} title={a.status} />
      <span className="dp-ell dp-grow">{a.name}</span>
      {where && <span className="dp-proj-path dp-ell">{short(where)}</span>}
      <span className="dp-chip">{a.provider}</span>
      <span className="dp-proj-when">{a.created}</span>
    </div>
  );
}

function Workspace({ w }: { w: PaseoProject['workspaces'][number] }) {
  const [all, setAll] = useState(false);
  const shown = all ? w.agents : w.agents.slice(0, AGENTS_SHOWN);
  return (
    <div className="dp-proj-ws">
      <div className="dp-proj-ws-h">
        <Icon name="folder" size={14} />
        <span className="dp-ell">{w.name}</span>
        <span className="dp-chip">{w.isolation}</span>
        <span className="dp-proj-path dp-ell">{short(w.cwd)}</span>
        <span className="dp-sp" />
        {w.agents.length > 0 && <span className="dp-count">{w.agents.length}</span>}
      </div>
      {shown.map((a) => <AgentLine key={a.id} a={a} />)}
      {w.agents.length > AGENTS_SHOWN && <button type="button" className="dp-btn dp-ghost dp-sm dp-proj-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show ${w.agents.length - AGENTS_SHOWN} more`}</button>}
    </div>
  );
}

function ProjectRow({ p, open, seen, onToggle }: { p: PaseoProject; open: boolean; seen: boolean; onToggle: () => void }) {
  return (
    <div className={`dp-proj${open ? ' dp-open' : ''}`}>
      <div className="dp-rowi dp-click dp-proj-h" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <span className={`dp-caret${open ? ' dp-open' : ''}`}><Icon name="chevron-right" size={12} /></span>
        <span className="dp-rowi-b">
          <span className="dp-row dp-g6"><b className="dp-ell">{p.name}</b><span className="dp-chip">{p.kind}</span>{p.running > 0 && <span className="dp-chip dp-ok"><span className="dp-d" />{p.running} running</span>}</span>
          <span className="dp-proj-path dp-ell">{short(p.path)}</span>
        </span>
        <span className="dp-proj-stat" title="Workspaces"><Icon name="folder" size={12} />{p.workspaces.length}</span>
        <span className="dp-proj-stat" title="Agents"><Icon name="bot" size={12} />{p.agentCount}</span>
        <span className="dp-proj-act" onClick={(e) => e.stopPropagation()}>
          {p.work ? (
            <a className="dp-btn dp-sm dp-proj-work" href={workHref(p.work.slug)} title={p.work.title}><Icon name="layers" size={12} /><span className="dp-ell">{p.work.title}</span></a>
          ) : (
            <a className="dp-btn dp-sm dp-ghost" href={`#/work/new/${p.projectId}/${encodeURIComponent(p.name)}`}><Icon name="plus" size={12} />Attach a work</a>
          )}
        </span>
      </div>
      <div className={`dp-collapse${open ? ' dp-open' : ''}`}>
        <div>
          {seen && (
            <div className="dp-proj-body">
              {p.workspaces.map((w) => <Workspace key={w.workspaceId} w={w} />)}
              {p.workspaces.length === 0 && <div className="dp-proj-none">No workspace.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  const [data, setData] = useState<PaseoResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [seen, setSeen] = useState<Record<string, boolean>>({});
  const refresh = () => api.paseo().then((d) => { setData(d); setErr(''); }, (e) => setErr(errorMessage(e)));
  useEffect(() => { refresh(); }, []);
  useShownInterval(refresh, 20000);
  const toggle = (id: string) => {
    if (seen[id]) return setOpen((o) => ({ ...o, [id]: !o[id] }));
    setSeen((s) => ({ ...s, [id]: true }));
    requestAnimationFrame(() => setOpen((o) => ({ ...o, [id]: true })));
  };
  const reload = () => { setBusy(true); refresh().finally(() => setBusy(false)); };
  const head = (
    <PageHead
      icon="folder"
      title="Projects"
      sub={<>Synced from your local Paseo (<code>paseo project ls</code>, <code>workspace ls</code>, <code>ls</code>). A project with a work carries long-term context: stack, artifacts, personas, notes.</>}
      actions={<button type="button" className="dp-btn" onClick={reload} disabled={busy}><Icon name="refresh" size={14} className={busy ? 'dp-spin' : undefined} />{busy ? 'Refreshing…' : 'Refresh'}</button>}
    />
  );
  if (!data) return <Page>{head}{err ? <ErrorNote>{err}</ErrorNote> : <Loading what="Loading Paseo…" />}</Page>;

  const projects = [...data.projects].sort((a, b) => b.running - a.running || b.agentCount - a.agentCount || a.name.localeCompare(b.name));
  const workspaces = projects.reduce((n, p) => n + p.workspaces.length, 0);
  const agents = projects.reduce((n, p) => n + p.agentCount, 0) + data.orphanAgents.length;
  const running = projects.reduce((n, p) => n + p.running, 0) + data.orphanAgents.filter((a) => a.status === 'running').length;
  const withWork = projects.filter((p) => p.work).length;

  return (
    <Page>
      {head}
      {(err || data.error) && <div className="dp-proj-err"><ErrorNote>{err || data.error}</ErrorNote></div>}
      <Tiles items={[
        { label: 'Projects', value: projects.length, hint: `${withWork} with a work` },
        { label: 'Workspaces', value: workspaces, hint: 'worktrees and folders' },
        { label: 'Agents', value: agents, hint: running ? `${running} running` : 'none running', tone: running ? 'ok' : undefined, href: '#/agents' },
        { label: 'Outside a workspace', value: data.orphanAgents.length, hint: 'agents', tone: data.orphanAgents.length ? 'warn' : undefined },
      ]} />

      <Section title="Projects" count={projects.length} meta="Click a project for its workspaces and agents">
        {projects.length ? (
          <div className="dp-rows">
            {projects.map((p) => <ProjectRow key={p.projectId} p={p} open={Boolean(open[p.projectId])} seen={Boolean(seen[p.projectId])} onToggle={() => toggle(p.projectId)} />)}
          </div>
        ) : <Empty icon="folder">No Paseo project yet.</Empty>}
      </Section>

      {data.orphanAgents.length > 0 && (
        <Section title="Agents outside a workspace" count={data.orphanAgents.length}>
          <div className="dp-rows dp-proj-orphans">{data.orphanAgents.map((a) => <AgentLine key={a.id} a={a} where={a.cwdAbs} />)}</div>
        </Section>
      )}
    </Page>
  );
}
