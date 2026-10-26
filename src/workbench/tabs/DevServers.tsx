import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import type { RowAction } from '../../api.ts';
import type { DevServerRowData, DevServersResponse } from '../../types.ts';
import { useAction } from '../../components/action.ts';
import { toast } from '../../components/Toast.tsx';
import { baseName, holdersText, idleText, loginSteps, optInsText, pinnedText, placementText, serverActions, statusText } from '../../../dev-servers/shared/view-model.ts';
import type { LoginSteps as LoginStepsData, StopAction } from '../../../dev-servers/shared/view-model.ts';

const POLL_MS = { on: 5000, off: 30000 };
const LOG_POLL_MS = 3000;
const LOG_LINES = 80;

// the work's dev servers: { on, board, rows } from the plugin through coco, or { on: false, reason } when the plugin is not there
export function useDevServers(slug: string) {
  const [data, setData] = useState<DevServersResponse | null>(null);
  const load = () =>
    api.devServers(slug).then(
      (d) => (setData(d), d),
      (e): DevServersResponse => { const d: DevServersResponse = { on: false, reason: errorMessage(e) }; setData(d); return d; },
    );
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    let last: DevServersResponse | null = null;
    const tick = async () => {
      if (document.visibilityState === 'visible') last = await load();
      if (live) timer = setTimeout(tick, POLL_MS[last?.on === false ? 'off' : 'on']);
    };
    tick();
    return () => { live = false; clearTimeout(timer); };
  }, [slug]);
  const rows: Record<string, DevServerRowData> = Object.fromEntries((data?.on ? data.rows : []).map((r) => [String(r.key), r]));
  return { data, rows, reload: load };
}

export function useDevLogs(id: string) {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.devServerLogs(id, LOG_LINES).then((r) => live && setLines(r.lines), (e) => live && setLines([`(no logs: ${errorMessage(e)})`]));
    load();
    const t = setInterval(load, LOG_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [id]);
  return lines ? lines.join('\n') || '(empty)' : '…';
}

// what a stack row can do with the server serving its worktree (its own, or the stack top it holds)
export function useDevServerRow(slug: string, row: DevServerRowData, onChange: () => unknown) {
  const { pending, busy, run } = useAction();
  const [steps, setSteps] = useState<LoginStepsData | null>(null);
  const server = row.server;
  const act = (key: string, fn: () => Promise<unknown>) => run(key, async () => { await fn(); await onChange(); });
  const rowAction = <A extends RowAction>(action: A, body?: Record<string, unknown>) => api.devServerRow(slug, row.key, action, body);

  const start = () => act('start', async () => {
    const r = await rowAction('start');
    const evicted = (r.evicted || []).map((e) => `stopped ${baseName(e.worktree)} to make room`);
    toast.success([placementText(r.placement, row.worktree ?? ''), r.next, ...evicted].join(' · '));
  });
  const stop = (action: StopAction) => server && confirm(action.confirm) && act('stop', async () => toast.success((await rowAction('stop', { serverId: server.id, force: action.force })).next));
  const pin = () => server && act('pin', async () => toast.success((await rowAction('pin', { serverId: server.id, pinned: !server.pinned })).next));
  const login = () => server && run('login', async () => setSteps(loginSteps(await api.devServerLogin(server.id))));

  const held = Boolean(server?.running && server.leases.some((l) => l.mine));
  const startLabel = !row.worktree ? null : !server?.running ? 'Start' : held ? null : 'Use this server';
  const actions = server ? serverActions(server) : null;
  const stopAction = actions?.stop ?? null;
  const details = server ? [statusText(server), holdersText(server), pinnedText(server), optInsText(server), idleText(server)].filter(Boolean) : [];
  return { server, pending, busy, steps, setSteps, start, stop, pin, login, startLabel, actions, stopAction, details };
}
