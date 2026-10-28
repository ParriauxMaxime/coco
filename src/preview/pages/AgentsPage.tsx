import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { toHash } from '../../workbench/hash.ts';
import { PendingPermissions, usePendingPermissions } from '../chat/Permission.tsx';
import Icon from '../Icon.tsx';
import { usageLine, usageTitle } from '../format.ts';
import { ContextRing } from '../Ring.tsx';
import { launcherHref } from '../launcher.ts';
import { Empty, ErrorNote, Loading, Page, PageHead, Section, Tiles } from './Page.tsx';
import type { AgentsResponse, LinkedAgent, PaseoAgent, PaseoWorkspace } from '../../types.ts';
import './agents-page.css';

type GroupBy = 'workspace' | 'status';
type Row = { a: PaseoAgent; state: string; ws?: PaseoWorkspace; link?: LinkedAgent };
type Group = { key: string; title: React.ReactNode; hint?: string; chip?: string; rows: Row[] };

const WS_SHOWN = 8;
const ORDER = ['waiting', 'running', 'error', 'idle', 'closed'];
const DOT: Record<string, string> = { waiting: 'dp-ag-waiting', running: 'dp-ag-running', idle: 'dp-ag-done', error: 'dp-ag-failed' };
const LABEL: Record<string, string> = { waiting: 'Waiting on you', running: 'Running', error: 'Failed', idle: 'Idle', closed: 'Closed' };
const rank = (s: string) => (ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length);
const label = (s: string) => LABEL[s] || s[0].toUpperCase() + s.slice(1);
const byState = (x: Row, y: Row) => rank(x.state) - rank(y.state);

function AgentRow({ r, open, log, where, onToggle }: { r: Row; open: boolean; log?: string; where: boolean; onToggle: () => void }) {
  const { a, ws, link } = r;
  const usage = a.usage ? usageLine(a.usage) : '';
  return (
    <div className={`dp-agp-item${open ? ' dp-open' : ''}`}>
      <div className="dp-rowi dp-click dp-agp-row" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <span className={`dp-ag-dot ${DOT[r.state] || 'dp-ag-archived'}`} title={label(r.state)} />
        <span className="dp-rowi-b">
          <span className="dp-agp-name"><span className="dp-ell">{a.name}</span><span className="dp-agp-id">{a.shortId}</span></span>
          {(where || link) && (
            <span className="dp-agp-sub">
              {where && <span className="dp-ell">{ws ? `${ws.project} / ${ws.name}` : a.cwd}</span>}
              {link && <a className="dp-agp-link dp-ell" href={toHash(link.slug, `brief-${link.key}`, false)} onClick={(e) => e.stopPropagation()}><Icon name="layers" size={12} />{link.workTitle} {link.label}{link.briefAt ? <span className="dp-t3"> · brief sent</span> : null}</a>}
            </span>
          )}
        </span>
        <span className="dp-chip dp-agp-prov" title={a.provider}>{a.provider}</span>
        {a.thinking && <span className="dp-chip">{a.thinking}</span>}
        {usage && a.usage && <span className="dp-xs dp-t3 dp-agp-usage" title={usageTitle(a.usage)}>{usage}</span>}
        {r.state !== 'closed' && <span className="dp-xs dp-t3"><ContextRing used={a.usage?.contextTokens} max={a.usage?.contextMax} label /></span>}
        <span className="dp-rowi-m dp-agp-ago">{a.created}</span>
        <a className="dp-btn dp-sm dp-agp-open" href={`#/agents/${encodeURIComponent(a.id)}`} title="Its transcript, cards and a composer to message it" onClick={(e) => e.stopPropagation()}><Icon name="message-square" size={12} />Chat</a>
        <span className="dp-agp-caret"><Icon name="chevron-right" size={12} /></span>
      </div>
      <div className={`dp-collapse${open ? ' dp-open' : ''}`}><div><pre className="dp-agp-log">{log ?? ''}</pre></div></div>
    </div>
  );
}

export default function AgentsPage() {
  const [data, setData] = useState<AgentsResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<Record<string, LinkedAgent>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [group, setGroup] = useState<GroupBy>('workspace');
  const [filter, setFilter] = useState('live');
  const [asked, setAsked] = useState(false);
  const [allWs, setAllWs] = useState(false);
  const { pending } = usePendingPermissions();
  const refresh = () => {
    setBusy(true);
    api.linkedAgents().then((all) => setLinks(Object.fromEntries(all.map((l) => [l.agentId, l]))), () => setLinks({}));
    return api.agents().then((d) => { setData(d); setErr(''); }, (e) => setErr(errorMessage(e))).finally(() => setBusy(false));
  };
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { if (pending.length) setAsked(true); }, [pending.length]);
  const toggle = async (id: string) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    setLogs((l) => ({ ...l, [id]: 'loading…' }));
    const r = await api.agentActivity(id).catch((e) => ({ ok: false, out: '', err: errorMessage(e) }));
    setLogs((l) => ({ ...l, [id]: r.ok ? r.out : r.err || 'no output' }));
  };

  const head = (
    <PageHead
      icon="bot"
      title="Agents"
      sub={<>From <code>paseo ls --json</code>, refreshed every 15 s. Open an agent for its recent log, or Chat to message it; questions it waits on show first.</>}
      actions={<>
        <button type="button" className="dp-btn" disabled={busy} onClick={() => void refresh()}><Icon name="refresh" size={14} className={busy ? 'dp-spin' : undefined} />Refresh</button>
        <a className="dp-btn dp-primary" href={launcherHref()} title="Start a free agent in a repo, a work or a PR, as in Paseo"><Icon name="plus" size={14} />New agent</a>
      </>}
    />
  );
  if (!data) return <Page>{head}{err ? <ErrorNote>{err}</ErrorNote> : <Loading what="Reading Paseo agents…" />}</Page>;

  const workspaces = data.workspaces || [];
  const byWs = new Map(workspaces.map((w) => [w.cwd, w]));
  const waiting = new Set(pending.map((p) => p.agentId));
  const rows: Row[] = (data.agents || []).map((a) => ({ a, ws: byWs.get(a.cwd), link: links[a.id], state: waiting.has(a.id) && a.status !== 'closed' ? 'waiting' : a.status }));
  const count = (s: string) => rows.filter((r) => r.state === s).length;
  const states = [...new Set(rows.map((r) => r.state))].sort((x, y) => rank(x) - rank(y));
  const live = rows.filter((r) => r.state !== 'closed').length;
  const shown = rows.filter((r) => filter === 'all' || (filter === 'live' ? r.state !== 'closed' : r.state === filter)).sort(byState);
  const groups: Group[] = group === 'status'
    ? states.map((s) => ({ key: s, title: <><span className={`dp-ag-dot ${DOT[s] || 'dp-ag-archived'}`} />{label(s)}</>, rows: shown.filter((r) => r.state === s) }))
    : [...new Set(shown.map((r) => r.ws?.workspaceId || r.a.cwd))].map((k) => {
      const mine = shown.filter((r) => (r.ws?.workspaceId || r.a.cwd) === k);
      const ws = mine[0].ws;
      return { key: k, title: <><Icon name="folder" size={14} /><span className="dp-ell">{ws ? <>{ws.project}<span className="dp-t4"> / </span>{ws.name}</> : 'No Paseo workspace'}</span></>, hint: ws?.cwd || k, chip: ws?.isolation, rows: mine };
    }).sort((x, y) => rank(x.rows[0].state) - rank(y.rows[0].state) || y.rows.length - x.rows.length);
  const folders = [...new Set(workspaces.map((w) => w.cwd))].map((cwd) => {
    const all = workspaces.filter((w) => w.cwd === cwd);
    return { w: all[0], n: all.length, names: [...new Set(all.map((w) => w.name))].join(', '), agents: rows.filter((r) => r.a.cwd === cwd).length, live: rows.filter((r) => r.a.cwd === cwd && r.state !== 'closed').length };
  }).sort((x, y) => y.live - x.live || y.agents - x.agents);
  const listed = allWs ? folders : folders.slice(0, WS_SHOWN);
  const other = rows.length - count('waiting') - count('running') - count('idle');

  return (
    <Page>
      {head}
      <Tiles items={[
        { label: 'Waiting on you', value: pending.length, hint: 'agent questions', tone: pending.length ? 'acc' : undefined },
        { label: 'Running', value: count('running'), hint: 'mid-turn', tone: count('running') ? 'ok' : undefined },
        { label: 'Idle', value: count('idle'), hint: 'live, between turns' },
        { label: 'Closed', value: other, hint: count('error') ? `${count('error')} failed` : 'or archived', tone: count('error') ? 'bad' : undefined },
        { label: 'Workspaces', value: workspaces.length, hint: `${rows.length} agents` },
      ]} />

      {(asked || pending.length > 0) && (
        <Section title="Waiting on you" count={pending.length}>
          <PendingPermissions withWhere />
        </Section>
      )}

      <Section
        title="Agents"
        count={rows.length}
        action={(
          <span className="dp-row dp-g8">
            <div className="dp-filters dp-agp-filters">
              <button type="button" className={filter === 'live' ? 'dp-on' : ''} onClick={() => setFilter('live')}>Live <span>{live}</span></button>
              <button type="button" className={filter === 'all' ? 'dp-on' : ''} onClick={() => setFilter('all')}>All <span>{rows.length}</span></button>
              {states.map((s) => <button key={s} type="button" className={filter === s ? 'dp-on' : ''} onClick={() => setFilter(s)}>{label(s)} <span>{count(s)}</span></button>)}
            </div>
            <div className="dp-seg">
              <button type="button" className={group === 'workspace' ? 'dp-on' : ''} onClick={() => setGroup('workspace')}>Workspace</button>
              <button type="button" className={group === 'status' ? 'dp-on' : ''} onClick={() => setGroup('status')}>Status</button>
            </div>
          </span>
        )}
      >
        {data.error && <ErrorNote>{data.error}</ErrorNote>}
        {err && <ErrorNote>{err}</ErrorNote>}
        {shown.length ? groups.filter((g) => g.rows.length).map((g) => (
          <div key={g.key} className="dp-agp-group">
            <div className="dp-agp-gh">
              {g.title}
              {g.chip && <span className="dp-chip">{g.chip}</span>}
              <span className="dp-count">{g.rows.length}</span>
              {g.hint && <span className="dp-agp-path dp-ell" title={g.hint}>{g.hint}</span>}
            </div>
            <div className="dp-rows">
              {g.rows.map((r) => <AgentRow key={r.a.id} r={r} open={open === r.a.id} log={logs[r.a.id]} where={group === 'status'} onToggle={() => void toggle(r.a.id)} />)}
            </div>
          </div>
        )) : !data.error && <Empty icon="bot">{!rows.length ? 'No Paseo agent right now.' : filter === 'live' ? `No live agent; ${rows.length} closed under All.` : 'No agent in this state.'}</Empty>}
      </Section>

      <Section title="Workspaces" count={workspaces.length} meta={folders.length !== workspaces.length ? `${folders.length} folders` : undefined}>
        {workspaces.length ? (
          <div className="dp-box">
            <table className="dp-tbl dp-agp-tbl">
              <thead><tr><th>Project</th><th>Workspace</th><th>Isolation</th><th className="dp-agp-n">Live</th><th className="dp-agp-n">Agents</th><th>Path</th></tr></thead>
              <tbody>
                {listed.map(({ w, n, names, agents, live: up }) => (
                  <tr key={w.cwd}>
                    <td className="dp-agp-txt"><b className="dp-ell" title={w.project}>{w.project}</b></td>
                    <td className="dp-agp-txt"><span className="dp-row dp-g6"><span className="dp-ell" title={names}>{w.name}</span>{n > 1 && <span className="dp-chip" title={`${n} Paseo workspaces on this folder`}>×{n}</span>}</span></td>
                    <td><span className="dp-chip">{w.isolation}</span></td>
                    <td className="dp-agp-n">{up || <span className="dp-t4">0</span>}</td>
                    <td className="dp-agp-n">{agents || <span className="dp-t4">0</span>}</td>
                    <td className="dp-agp-cwd"><span className="dp-ell" title={w.cwd}>{w.cwd}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {folders.length > WS_SHOWN && <button type="button" className="dp-agp-more" onClick={() => setAllWs(!allWs)}><Icon name={allWs ? 'chevron-down' : 'chevron-right'} size={12} />{allWs ? 'Show fewer' : `Show all ${folders.length} folders`}</button>}
          </div>
        ) : <Empty icon="folder">No Paseo workspace.</Empty>}
      </Section>
    </Page>
  );
}
