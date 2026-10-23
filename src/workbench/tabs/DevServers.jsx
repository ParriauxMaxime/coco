import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useAction, pendingClass } from '../../components/action.js';
import { toast } from '../../components/Toast.jsx';
import { baseName, holdersText, idleText, loginSteps, optInsText, pinnedText, placementText, serverActions, stateLabel, stateTone, statusText, summarize } from '../../../dev-servers/shared/view-model.ts';

const POLL_MS = { on: 5000, off: 30000 };
const LOG_POLL_MS = 3000;
const LOG_LINES = 80;
const TONE = { success: 'c-green', warning: 'c-orange', danger: 'c-red', muted: 'c-grey', accent: 'c-blue' };

// the plan page's dev servers: { on, board, rows } from the plugin through coco, or { on: false, reason } when the plugin is not there
export function useDevServers(slug) {
  const [data, setData] = useState(null);
  const load = () =>
    api.devServers(slug).then(
      (d) => (setData(d), d),
      (e) => { const d = { on: false, reason: e.message }; setData(d); return d; },
    );
  useEffect(() => {
    let timer;
    let live = true;
    let last = null;
    const tick = async () => {
      if (document.visibilityState === 'visible') last = await load();
      if (live) timer = setTimeout(tick, POLL_MS[last?.on === false ? 'off' : 'on']);
    };
    tick();
    return () => { live = false; clearTimeout(timer); };
  }, [slug]);
  const rows = Object.fromEntries((data?.rows || []).map((r) => [String(r.key), r]));
  return { data, rows, reload: load };
}

export function DevServersSummary({ data }) {
  if (!data) return null;
  if (!data.on) return <span className="status" title={data.reason}>dev servers off</span>;
  return <span className="status">{summarize(data.board)}</span>;
}

function LoginSteps({ steps, onClose }) {
  const copy = () => navigator.clipboard?.writeText(steps.snippet).then(() => toast.success('Snippet copied: paste it in the developer console of the server tab'), (e) => toast.error(`Copy failed: ${e.message}`));
  return (
    <div className="dev-login">
      {steps.kind === 'direct' ? (
        <div className="row"><a href={steps.url} target="_blank" rel="noreferrer">Open logged in</a><span className="status">{steps.next}</span></div>
      ) : (
        <>
          <div className="row"><span className="status">1.</span><button className="sm" onClick={() => window.open(steps.open, '_blank')}>Open {steps.open}</button></div>
          <div className="row"><span className="status">2.</span><button className="sm" onClick={copy}>Copy the snippet</button><span className="status">then paste it in that tab's developer console: it stores the session and opens {steps.then}</span></div>
          <pre>{steps.snippet}</pre>
        </>
      )}
      <button className="sm" onClick={onClose}>Done</button>
    </div>
  );
}

function Logs({ id }) {
  const [lines, setLines] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => api.devServerLogs(id, LOG_LINES).then((r) => live && setLines(r.lines), (e) => live && setLines([`(no logs: ${e.message})`]));
    load();
    const t = setInterval(load, LOG_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [id]);
  return <pre className="dev-logs">{lines ? lines.join('\n') || '(empty)' : '…'}</pre>;
}

// one stack row: the server serving its worktree (its own, or the stack top it holds), and what this row can do with it
export function DevServerRow({ slug, row, onChange }) {
  const { pending, busy, run } = useAction();
  const [steps, setSteps] = useState(null);
  const [showLogs, setShowLogs] = useState(false);
  const server = row.server;
  const act = (key, fn) => run(key, async () => { await fn(); await onChange(); });
  const rowAction = (action, body) => api.devServerRow(slug, row.key, action, body);

  const start = () => act('start', async () => {
    const r = await rowAction('start');
    const evicted = (r.evicted || []).map((e) => `stopped ${baseName(e.worktree)} to make room`);
    toast.success([placementText(r.placement, row.worktree), r.next, ...evicted].join(' · '));
  });
  const stop = (action) => confirm(action.confirm) && act('stop', async () => toast.success((await rowAction('stop', { serverId: server.id, force: action.force })).next));
  const pin = () => act('pin', async () => toast.success((await rowAction('pin', { serverId: server.id, pinned: !server.pinned })).next));
  const login = () => run('login', async () => setSteps(loginSteps(await api.devServerLogin(server.id))));

  const held = Boolean(server?.running && server.leases.some((l) => l.mine));
  const startLabel = !row.worktree ? null : !server?.running ? 'Start' : held ? null : 'Use this server';
  const actions = server ? serverActions(server) : null;
  const button = (key, action, onClick, extra = '') =>
    action?.visible && <button key={key} className={`sm${extra}${pendingClass(pending === key)}`} disabled={busy || !action.enabled} title={action.hint} onClick={onClick}>{action.label}</button>;
  const details = server ? [statusText(server), holdersText(server), pinnedText(server), optInsText(server), idleText(server)].filter(Boolean) : [];

  return (
    <div className="dev-server">
      <div className="row dev-line">
        <span className="status">dev server:</span>
        {!server && <span className="chip c-grey" title={row.branch || ''}>{row.worktree ? 'none' : 'not checked out'}</span>}
        {server && <span className={`chip ${TONE[stateTone(server.state)]}`} title={server.url}>{stateLabel(server.state)} :{server.port}</span>}
        {row.servedFrom && <span className="status" title={row.servedFrom}>served from {baseName(row.servedFrom)}</span>}
        {server?.pinned && <span className="chip c-blue" title={pinnedText(server)}>pinned</span>}
        <span className="row open-side">
          {startLabel && <button className={`sm${pendingClass(pending === 'start')}`} disabled={busy} onClick={start}>{startLabel}</button>}
          {actions && button('open', actions.open, () => window.open(server.url, '_blank'))}
          {actions && button('login', actions.login, login)}
          {actions && button('logs', { ...actions.logs, label: showLogs ? 'Hide logs' : 'Logs' }, () => setShowLogs(!showLogs))}
          {actions && button('pin', actions.pin, pin)}
          {actions?.stop && button('stop', actions.stop, () => stop(actions.stop), actions.stop.force ? ' danger' : '')}
        </span>
      </div>
      {details.length > 0 && <div className="status dev-details">{details.join(' · ')}</div>}
      {steps && <LoginSteps steps={steps} onClose={() => setSteps(null)} />}
      {showLogs && server && <Logs id={server.id} />}
    </div>
  );
}
