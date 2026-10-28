import { useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { pendingClass, useAction } from '../../components/action.ts';
import { toast } from '../../components/Toast.tsx';
import { useDevLogs, useDevServerRow } from '../../workbench/tabs/DevServers.tsx';
import { baseName, stateLabel, stateTone, statusText, summarize } from '../../../dev-servers/shared/view-model.ts';
import type { Action, LoginSteps as LoginStepsData } from '../../../dev-servers/shared/view-model.ts';
import type { DevServerRowData, DevServersResponse } from '../../types.ts';
import './widgets.css';

const TONE: Record<string, string> = { success: 'dp-ok', warning: 'dp-warn', danger: 'dp-bad', accent: 'dp-info' };
type Server = NonNullable<DevServerRowData['server']>;
const toneOf = (server: Server) => TONE[stateTone(server.state)] || '';

export function DevServersLine({ data }: { data: DevServersResponse | null }) {
  if (!data) return <span className="dp-t4">…</span>;
  if (!data.on) return <span className="dp-t3" title={data.reason}>off</span>;
  return <>{summarize(data.board)}</>;
}

// the work's checked-out rows and what a dev server costs there now: running (agents reuse it), building, a warm build, queued, or a cold start
// what a start costs in a row's worktree, worst news first: a failed warm build, then warm, on disk, queued, cold
function costOf(r: DevServerRowData): { label: string; tone: string; why: string | null; warmable: boolean } {
  const s = r.server;
  if (s?.running) return { label: `${stateLabel(s.state)} :${s.port}`, tone: toneOf(s), why: statusText(s), warmable: false };
  if (r.prebuildQueued != null) return { label: 'warm build queued', tone: '', why: r.prebuildQueued ? `${r.prebuildQueued} ahead` : 'next', warmable: false };
  if (s?.lastError?.startsWith('warm build failed')) return { label: 'warm build failed', tone: 'dp-bad', why: s.lastError, warmable: true };
  if (s?.buildSeconds !== undefined) return { label: 'warm build', tone: 'dp-info', why: statusText(s), warmable: false };
  if (r.cacheOnDisk) return { label: 'build on disk', tone: 'dp-info', why: 'A build cache is in the worktree, but no build was seen to succeed here: Warm up makes it a known warm build', warmable: true };
  return { label: 'cold start', tone: '', why: 'No build yet: a first start builds for several minutes', warmable: true };
}

// the work's checked-out rows and what a dev server costs there now: running (agents reuse it), building, a warm build, queued, or a cold start
export function DevServersList({ data, slug, onChange }: { data: DevServersResponse | null; slug: string; onChange: () => unknown }) {
  const { pending, busy, run } = useAction();
  if (!data?.on) return null;
  const rows = data.rows.filter((r) => r.worktree);
  if (!rows.length) return <div className="dp-t3 dp-xs">No PR of this work is checked out</div>;
  const warm = (r: DevServerRowData) => run(`warm-${r.key}`, async () => {
    const res = await api.devServerRow(slug, r.key, 'warm');
    toast.success(res.queued ? `Warm build of ${baseName(r.worktree || '')} ${res.why}` : `Not queued: ${res.why}`);
    await onChange();
  });
  return (
    <div className="dp-dev-list">
      {rows.map((r) => {
        const s = r.server;
        const cost = costOf(r);
        const why = [cost.why, r.servedFrom ? `served from ${baseName(r.servedFrom)}` : null].filter(Boolean).join(' · ');
        const label = typeof r.key === 'number' ? `#${r.key}` : baseName(r.worktree || '');
        return (
          <div key={String(r.key)} className="dp-row dp-g4 dp-dev-li" title={why || undefined}>
            <span className="dp-mono dp-xs">{label}</span>
            {s?.running ? <a className={`dp-chip ${cost.tone}`} href={s.url} target="_blank" rel="noreferrer">{cost.label}</a> : <span className={`dp-chip ${cost.tone}`}>{cost.label}</span>}
            {r.servedFrom && <span className="dp-t3 dp-xs dp-ell">from {baseName(r.servedFrom)}</span>}
            {cost.warmable && <button type="button" className={`dp-btn dp-sm dp-ghost${pendingClass(pending === `warm-${r.key}`)}`} disabled={busy} title="Queue a background build of this worktree, so an agent's first start only boots" onClick={() => warm(r)}>Warm up</button>}
          </div>
        );
      })}
    </div>
  );
}

// stack cell: the state of the server serving the row, or a start button when its worktree has none
export function DevServerCell({ slug, row, onChange }: { slug: string; row: DevServerRowData | undefined; onChange: () => unknown }) {
  if (!row?.worktree) return <span className="dp-t4" title={row?.branch ? 'not checked out' : undefined}>–</span>;
  return <Cell slug={slug} row={row} onChange={onChange} />;
}

function Cell({ slug, row, onChange }: { slug: string; row: DevServerRowData; onChange: () => unknown }) {
  const { server, pending, busy, start, startLabel } = useDevServerRow(slug, row, onChange);
  if (server?.running) {
    return (
      <a className={`dp-dev-st ${toneOf(server)}`} href={server.url} target="_blank" rel="noreferrer" title={`${stateLabel(server.state)} · ${server.url}${row.servedFrom ? ` · served from ${baseName(row.servedFrom)}` : ''}`} onClick={(e) => e.stopPropagation()}>
        <i />:{server.port}
      </a>
    );
  }
  if (!startLabel) return <span className="dp-t4">–</span>;
  return <button type="button" className={`dp-btn dp-sm dp-ghost dp-dev-go${pendingClass(pending === 'start')}`} disabled={busy} title="Start a dev server for this worktree" onClick={(e) => { e.stopPropagation(); start(); }}>Start</button>;
}

function LoginSteps({ steps, onClose }: { steps: LoginStepsData; onClose: () => void }) {
  const copy = () => steps.kind === 'seed' && navigator.clipboard?.writeText(steps.snippet).then(() => toast.success('Snippet copied: paste it in the developer console of the server tab'), (e) => toast.error(`Copy failed: ${errorMessage(e)}`));
  return (
    <div className="dp-dev-login">
      {steps.kind === 'direct' ? (
        <div className="dp-row dp-g4"><a className="dp-btn dp-sm dp-primary" href={steps.url} target="_blank" rel="noreferrer">Open logged in</a><span className="dp-t3 dp-xs">{steps.next}</span></div>
      ) : (
        <>
          <div className="dp-row dp-g4"><span className="dp-t3">1.</span><button type="button" className="dp-btn dp-sm" onClick={() => window.open(steps.open, '_blank')}>Open the server</button></div>
          <div className="dp-row dp-g4"><span className="dp-t3">2.</span><button type="button" className="dp-btn dp-sm" onClick={copy}>Copy the snippet</button><span className="dp-t3 dp-xs">paste it in that tab's console, it opens {steps.then}</span></div>
          <pre className="dp-dev-pre">{steps.snippet}</pre>
        </>
      )}
      <button type="button" className="dp-btn dp-sm dp-ghost" onClick={onClose}>Done</button>
    </div>
  );
}

function Logs({ id }: { id: string }) {
  return <pre className="dp-dev-pre dp-dev-logs">{useDevLogs(id)}</pre>;
}

// inspector section: state, where it is served from, every server action, login steps and live logs
export function DevServerPanel({ slug, row, onChange }: { slug: string; row: DevServerRowData; onChange: () => unknown }) {
  const { server, pending, busy, steps, setSteps, start, stop, pin, login, startLabel, actions, stopAction, details } = useDevServerRow(slug, row, onChange);
  const [showLogs, setShowLogs] = useState(false);
  const button = (key: string, action: Action | null | undefined, onClick: () => unknown, extra = '') =>
    action?.visible && <button key={key} type="button" className={`dp-btn dp-sm${extra}${pendingClass(pending === key)}`} disabled={busy || !action.enabled} title={action.hint} onClick={onClick}>{action.label}</button>;
  return (
    <div className="dp-dev">
      <div className="dp-row dp-g4 dp-dev-head">
        {!server && <span className="dp-chip" title={row.branch || ''}>{row.worktree ? 'none' : 'not checked out'}</span>}
        {server && <a className={`dp-chip ${toneOf(server)}`} href={server.url} target="_blank" rel="noreferrer">{stateLabel(server.state)} :{server.port}</a>}
        {server?.pinned && <span className="dp-chip dp-info">pinned</span>}
        {row.servedFrom && <span className="dp-t3 dp-xs dp-ell" title={row.servedFrom}>from {baseName(row.servedFrom)}</span>}
      </div>
      <div className="dp-row dp-g4 dp-dev-acts">
        {startLabel && <button type="button" className={`dp-btn dp-sm dp-primary${pendingClass(pending === 'start')}`} disabled={busy} onClick={start}>{startLabel}</button>}
        {actions && button('login', actions.login, login)}
        {actions && button('logs', { ...actions.logs, label: showLogs ? 'Hide logs' : 'Logs' }, () => setShowLogs(!showLogs))}
        {actions && button('pin', actions.pin, pin)}
        {stopAction && button('stop', stopAction, () => stop(stopAction), stopAction.force ? ' dp-danger' : '')}
      </div>
      {details.length > 0 && <div className="dp-t3 dp-xs">{details.join(' · ')}</div>}
      {steps && <LoginSteps steps={steps} onClose={() => setSteps(null)} />}
      {showLogs && server && <Logs id={server.id} />}
    </div>
  );
}
