import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { peek, useResource, useShownInterval } from '../../resource.ts';
import type { RowAction } from '../../api.ts';
import type { DevServerRowData, DevServersResponse } from '../../types.ts';
import { useAction } from '../../components/action.ts';
import { toast } from '../../components/Toast.tsx';
import { confirmDialog } from '../../components/Dialogs.tsx';
import { baseName, holdersText, idleText, loginSteps, optInsText, pinnedText, placementText, serverActions, statusText } from '../../../dev-servers/shared/view-model.ts';
import type { LoginSteps as LoginStepsData, StopAction } from '../../../dev-servers/shared/view-model.ts';

const POLL_MS = { on: 5000, off: 30000 };
const LOG_POLL_MS = 3000;
const LOG_LINES = 80;

// the work's dev servers: { on, board, rows } from the plugin through coco, or { on: false, reason } when the plugin is not there
// one read and one poll per work however many views show it
export function useDevServers(slug: string) {
  const fetcher = () => api.devServers(slug).catch((e): DevServersResponse => ({ on: false, reason: errorMessage(e) }));
  const key = `/api/dev-servers/works/${slug}`;
  const res = useResource<DevServersResponse>(key, fetcher, { poll: POLL_MS[peek<DevServersResponse>(key)?.on === false ? 'off' : 'on'] });
  const data = res.data ?? null;
  const rows: Record<string, DevServerRowData> = Object.fromEntries((data?.on ? data.rows : []).map((r) => [String(r.key), r]));
  return { data, rows, reload: () => res.reload() };
}

export function useDevLogs(id: string) {
  const [lines, setLines] = useState<string[] | null>(null);
  const live = useRef(id);
  live.current = id;
  const load = () => api.devServerLogs(id, LOG_LINES).then((r) => live.current === id && setLines(r.lines), (e) => live.current === id && setLines([`(no logs: ${errorMessage(e)})`]));
  useEffect(() => { void load(); }, [id]);
  useShownInterval(load, LOG_POLL_MS);
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
  const stop = async (action: StopAction) => server && (await confirmDialog({ title: action.confirm, ok: action.label, danger: action.force })) && act('stop', async () => toast.success((await rowAction('stop', { serverId: server.id, force: action.force })).next));
  const pin = () => server && act('pin', async () => toast.success((await rowAction('pin', { serverId: server.id, pinned: !server.pinned })).next));
  const login = () => server && run('login', async () => setSteps(loginSteps(await api.devServerLogin(server.id))));

  const held = Boolean(server?.running && server.leases.some((l) => l.mine));
  const startLabel = !row.worktree ? null : !server?.running ? 'Start' : held ? null : 'Use this server';
  const actions = server ? serverActions(server) : null;
  const stopAction = actions?.stop ?? null;
  const queued = row.prebuildQueued == null ? null : `Warm build queued${row.prebuildQueued ? `, ${row.prebuildQueued} ahead` : ', next'}`;
  // what an agent that asks for a server here gets, before anyone starts one
  const placed = row.placement && row.worktree && !server?.running ? `An agent here gets: ${placementText(row.placement, row.worktree)}` : null;
  const details = [...(server ? [statusText(server), holdersText(server), pinnedText(server), optInsText(server), idleText(server)] : []), queued, placed].filter((x): x is string => Boolean(x));
  return { server, pending, busy, steps, setSteps, start, stop, pin, login, startLabel, actions, stopAction, details };
}
