import { Suspense, lazy, useEffect, useState } from 'react';
import { termApi } from '../api.ts';
import type { WorkspaceScript, WorkspaceTerminal } from '../api.ts';
import { subscribe, topic } from '../live.ts';
import { confirmDialog } from '../components/Dialogs.tsx';
import { pendingClass, useAction } from '../components/action.ts';
import { toast } from '../components/Toast.tsx';
import { parseTerminalTab } from '../workbench/code/ids.ts';
import Icon from './Icon.tsx';
import './git.css';
import './terminal.css';

// xterm.js and its stylesheet stay out of the main bundle until a terminal shows
const XtermView = lazy(() => import('./Xterm.tsx'));

type Scripts = { list: WorkspaceScript[]; supported: boolean };
type ListEv = { type: 'terminals'; terminals: WorkspaceTerminal[] } | { type: 'scripts'; scripts: WorkspaceScript[]; supported: boolean };

// a workspace's terminals and scripts, live (topic workspace-terminals)
export function useWorkspaceTerminals(wsId: string) {
  const [terms, setTerms] = useState<WorkspaceTerminal[] | null>(null);
  const [scripts, setScripts] = useState<Scripts | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setTerms(null);
    setScripts(null);
    setError('');
    return subscribe(topic('workspace-terminals', wsId), {
      message: (ev: ListEv) => {
        if (ev.type === 'terminals') {
          setTerms(ev.terminals);
          setError('');
        } else setScripts({ list: ev.scripts, supported: ev.supported });
      },
      error: (e: { error: string }) => setError(e.error),
    });
  }, [wsId]);
  return { terms, scripts, error };
}

// label: the title its shell set, else its name
type Tab = { id: string; name: string; label: string; busy: boolean; script: string | null };

// a workspace's Paseo terminals as sub-tabs (one live xterm at a time), New terminal and Kill; its scripts on the side with Start / Stop,
// a port's link, and a script's output opened as one more sub-tab. Every action is a click: nothing here runs on its own.
export function TerminalPanel({ wsId }: { wsId: string }) {
  const { terms, scripts, error } = useWorkspaceTerminals(wsId);
  const [active, setActive] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<string[]>([]);
  const { pending, busy, run } = useAction();
  // a worktree known by its path only: its terminals are listed, a new one needs a Paseo workspace
  const noSpace = wsId.startsWith('p.');

  const scriptOf = (id: string) => scripts?.list.find((s) => s.terminalId === id) ?? null;
  const tabs: Tab[] = [
    ...(terms ?? []).filter((t) => !scriptOf(t.id)).map((t) => ({ id: t.id, name: t.name, label: t.title || t.name, busy: t.busy, script: null })),
    ...outputs.flatMap((id) => {
      const s = scriptOf(id);
      return s ? [{ id, name: s.name, label: s.name, busy: s.running, script: s.name }] : [];
    }),
  ];
  const current = tabs.find((t) => t.id === active) ?? tabs[0] ?? null;

  const create = () => run('new', async () => {
    const r = await termApi.create(wsId);
    setActive(r.terminal.id);
  });
  const kill = async (t: Tab) => {
    const ok = await confirmDialog({ title: `Kill ${t.name}?`, body: 'Ends its shell and whatever runs in it. This cannot be undone.', ok: 'Kill', danger: true });
    if (ok) await run('kill', async () => {
      await termApi.kill(wsId, t.id);
      toast.success(`Killed ${t.name}`);
    });
  };
  const openOutput = (s: WorkspaceScript) => {
    if (!s.terminalId) return;
    const id = s.terminalId;
    setOutputs((o) => (o.includes(id) ? o : [...o, id]));
    setActive(id);
  };
  const closeOutput = (id: string) => setOutputs((o) => o.filter((x) => x !== id));
  const script = (s: WorkspaceScript, action: 'start' | 'stop') => run(`${action}:${s.name}`, async () => {
    const r = await termApi.script(wsId, s.name, action);
    toast.success(`${s.name} ${action === 'start' ? 'started' : 'stopped'}`);
    if (action === 'start' && r.script?.terminalId) openOutput(r.script);
  });

  if (error && !terms) return <div className="dp-empty">{error}</div>;
  if (!terms) return <div className="dp-empty">Reading the workspace's terminals…</div>;
  return (
    <div className="tm">
      <div className="tm-bar">
        <div className="tm-tabs" role="tablist">
          {tabs.map((t) => (
            <span key={t.id} className={`tm-tab${current?.id === t.id ? ' dp-on' : ''}`}>
              <button type="button" role="tab" aria-selected={current?.id === t.id} title={t.script ? `The output of the script ${t.script}` : t.label === t.name ? t.name : `${t.name}: ${t.label}`} onClick={() => setActive(t.id)}>
                <Icon name={t.script ? 'play' : 'terminal'} size={12} />
                <span className="dp-ell">{t.label}</span>
                {t.busy && <span className="dp-dot dp-live" title={t.script ? 'running' : 'busy'} />}
              </button>
              {t.script && <button type="button" className="dp-ibtn tm-x" title="Close the output (the script keeps running)" onClick={() => closeOutput(t.id)}><Icon name="x" size={12} /></button>}
            </span>
          ))}
        </div>
        <button type="button" className={`dp-btn dp-sm${pendingClass(pending === 'new')}`} disabled={busy || noSpace} title={noSpace ? 'Paseo opens a terminal in a workspace: this worktree has none' : "A new shell in the workspace's directory"} onClick={() => void create()}><Icon name="plus" size={12} />New terminal</button>
        <span className="dp-sp" />
        {current && !current.script && <button type="button" className={`dp-btn dp-sm dp-ghost${pendingClass(pending === 'kill')}`} disabled={busy} title={`Kill ${current.name}`} onClick={() => void kill(current)}><Icon name="trash" size={12} />Kill</button>}
      </div>
      <div className="tm-body">
        <main className="tm-main">
          {current ? (
            <Suspense fallback={<div className="dp-empty">Loading the terminal…</div>}>
              <XtermView key={current.id} wsId={wsId} terminalId={current.id} />
            </Suspense>
          ) : (
            <div className="dp-empty">
              No terminal in this workspace yet.
              <button type="button" className="dp-btn dp-sm" disabled={busy || noSpace} onClick={() => void create()}><Icon name="plus" size={12} />New terminal</button>
            </div>
          )}
        </main>
        <aside className="tm-side">
          <div className="gp-sec-t"><span>Scripts</span>{scripts && <span className="dp-count">{scripts.list.length}</span>}</div>
          {!scripts && <div className="gp-none">Reading…</div>}
          {scripts && !scripts.supported && <div className="gp-none">Scripts belong to a Paseo workspace; this worktree has none.</div>}
          {scripts?.supported && scripts.list.length === 0 && <div className="gp-none">None set up in Paseo for this workspace.</div>}
          {scripts?.list.map((s) => (
            <div key={s.name} className="tm-script">
              <span className={`dp-dot ${s.running ? (s.health === 'unhealthy' ? 'dp-st-changes' : 'dp-live') : 'dp-hollow'}`} title={s.running ? `running${s.health ? `, ${s.health}` : ''}` : s.exitCode != null ? `stopped (exit ${s.exitCode})` : 'stopped'} />
              <span className="tm-script-n dp-ell" title={`${s.name} (${s.type})`}>{s.name}</span>
              {s.running && s.url && <a className="dp-chip" href={s.url} target="_blank" rel="noreferrer" title={s.url}>{s.port ? `:${s.port}` : 'open'}<Icon name="external-link" size={12} /></a>}
              <span className="dp-sp" />
              {s.terminalId && <button type="button" className="dp-ibtn" title="Its output, as a terminal" onClick={() => openOutput(s)}><Icon name="terminal" size={14} /></button>}
              {s.running
                ? <button type="button" className={`dp-btn dp-sm dp-ghost${pendingClass(pending === `stop:${s.name}`)}`} disabled={busy} onClick={() => void script(s, 'stop')}><Icon name="square" size={12} />Stop</button>
                : <button type="button" className={`dp-btn dp-sm${pendingClass(pending === `start:${s.name}`)}`} disabled={busy} onClick={() => void script(s, 'start')}><Icon name="play" size={12} />Start</button>}
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}

// term-<workspace id>: a workspace's terminals as a tab (⌘K Terminals opens the work's Plan workspace's)
export function TerminalTab({ tabId }: { tabId: string }) {
  const wsId = parseTerminalTab(tabId);
  return wsId ? <div className="dp-tabview tm-tab-view"><TerminalPanel wsId={wsId} /></div> : <div className="dp-empty">Unknown workspace.</div>;
}
