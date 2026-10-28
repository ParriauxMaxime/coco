// The Paseo daemon as coco's bridge sees it: its connection (connected, reconnecting, down), version and last error, and each provider's availability.
// GET /api/paseo/health · topic `paseo` on each change · POST /api/paseo/restart runs `paseo daemon restart` · POST /api/paseo/providers/refresh asks the daemon to look again.
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import { defaultExec } from './placement.ts';
import type { ReadBody, Req, Res, Send } from './core-types.ts';
import type { Sink } from './events.ts';
import type { ConnectionState, DaemonClient, DaemonConnection, ProviderEntry } from './paseo-agent.ts';

type Exec = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
type HealthClient = { connection?: DaemonConnection; providers?: Partial<NonNullable<DaemonClient['providers']>> };

export type ProviderHealth = { id: string; label: string; status: string; enabled: boolean; reason: string | null; diagnostic: string | null };
export type PaseoHealth = {
  state: 'connected' | 'reconnecting' | 'down';
  reason: string | null;
  since: string;
  version: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  providers: ProviderHealth[];
  providersAt: string | null;
  restarting: boolean;
  restartError: string | null;
};

// lost for longer than this, the daemon reads as down rather than reconnecting
const DOWN_AFTER_MS = 30000;
// unreachable at boot: coco tries again this often
const RETRY_MS = 15000;
// a read older than this refreshes the providers in the background
const PROVIDERS_TTL_MS = 60000;
const RESTART_TIMEOUT_S = 120;
const ANSWER_MS = 2000;

// the one line that says why a provider is out, from Paseo's diagnostic: its binary missing, else its status line
export function diagnosticReason(text: string | null | undefined) {
  if (!text) return null;
  const line = (k: string) => text.match(new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm'))?.[1]?.trim() || '';
  if (/^not found$/i.test(line('Resolved path'))) return `${line('Binary') || 'its command'} not found on PATH`;
  return line('Status') || null;
}

export function createPaseoHealth({ client, exec = defaultExec, downAfterMs = DOWN_AFTER_MS, retryMs = RETRY_MS, now = Date.now }: { client: () => Promise<HealthClient>; exec?: Exec; downAfterMs?: number; retryMs?: number; now?: () => number }) {
  const listeners = new Set<() => void>();
  let attached: HealthClient | null = null;
  let attaching: Promise<void> | null = null;
  let conn: ConnectionState = { status: 'connecting' };
  let connectError: string | null = null;
  let since = now();
  let providers: ProviderHealth[] = [];
  let providersAt = 0;
  let loading: Promise<void> | null = null;
  let restarting = false;
  let restartError: string | null = null;
  let downTimer: ReturnType<typeof setTimeout> | null = null;
  const diagnostics = new Map<string, string | null>();

  const changed = () => [...listeners].forEach((l) => l());

  function current(): PaseoHealth {
    const up = conn.status === 'connected';
    // a first connect in flight reads as reconnecting; one that failed, or a connection lost too long, as down
    const down = attached ? now() - since >= downAfterMs : Boolean(connectError);
    return {
      state: up ? 'connected' : down ? 'down' : 'reconnecting',
      reason: up ? null : connectError || conn.reason || attached?.connection?.lastError() || (conn.status === 'connecting' ? 'connecting…' : 'disconnected'),
      since: new Date(since).toISOString(),
      version: up ? attached?.connection?.version() ?? null : null,
      lastError: attached?.connection?.lastError() ?? connectError,
      nextRetryAt: conn.nextRetryAt ?? null,
      providers,
      providersAt: providersAt ? new Date(providersAt).toISOString() : null,
      restarting,
      restartError,
    };
  }

  function onState(s: ConnectionState) {
    const was = conn.status === 'connected';
    conn = s;
    if ((s.status === 'connected') !== was) since = now();
    if (downTimer) clearTimeout(downTimer);
    downTimer = null;
    if (s.status === 'connected') void loadProviders(true);
    else (downTimer = setTimeout(changed, downAfterMs)).unref?.();
    changed();
  }

  // coco's client once it has one; unreachable, the daemon reads as down and coco tries again
  function attach() {
    attaching ||= client().then(
      (c) => {
        connectError = null;
        attached = c;
        c.connection?.onChange(onState);
        c.providers?.subscribe?.(() => void loadProviders(true));
        onState(c.connection?.state() ?? { status: 'connected' });
      },
      (e) => {
        attaching = null;
        connectError = errorMessage(e);
        conn = { status: 'disconnected' };
        changed();
        setTimeout(attach, retryMs).unref?.();
      },
    );
    return attaching;
  }

  // each provider with its status; one out with no error of its own gets the reason its diagnostic gives
  function loadProviders(force = false) {
    if (!attached?.providers?.snapshot || conn.status !== 'connected') return Promise.resolve();
    if (loading || (!force && now() - providersAt < PROVIDERS_TTL_MS)) return loading || Promise.resolve();
    const p = attached.providers;
    loading = (async () => {
      const { entries } = await p.snapshot!();
      if (force) diagnostics.clear();
      providers = await Promise.all(
        entries.map(async (e: ProviderEntry) => {
          const out = e.enabled !== false && e.status !== 'ready' && e.status !== 'loading';
          if (out && !e.error && p.diagnostic && !diagnostics.has(e.provider)) diagnostics.set(e.provider, (await p.diagnostic(e.provider).catch(() => null))?.diagnostic ?? null);
          const diagnostic = out ? diagnostics.get(e.provider) ?? null : null;
          return { id: e.provider, label: e.label || e.provider, status: e.status, enabled: e.enabled !== false, reason: out ? e.error || diagnosticReason(diagnostic) : null, diagnostic };
        }),
      );
      providersAt = now();
      changed();
    })()
      .catch((e) => console.error(`paseo providers: ${errorMessage(e)}`))
      .finally(() => (loading = null));
    return loading;
  }

  // never waits long on a daemon that does not answer: the state says so, the topic tells the rest
  async function health() {
    await Promise.race([attach(), new Promise((r) => setTimeout(r, ANSWER_MS).unref?.())]);
    void loadProviders();
    return current();
  }

  // the daemon worker restarts under its supervisor; coco's client reconnects by itself, nudged once the command returns
  function restart() {
    if (restarting) throw new HttpError(409, 'the Paseo daemon is already restarting');
    restarting = true;
    restartError = null;
    changed();
    void exec('paseo', ['daemon', 'restart', '--json', '--timeout', String(RESTART_TIMEOUT_S)])
      .then((r) => (restartError = r.ok ? null : (r.stderr || r.stdout).trim().slice(0, 300) || 'paseo daemon restart failed'))
      .finally(() => {
        restarting = false;
        attached?.connection?.reconnect();
        if (!attached) void attach();
        changed();
      });
    return current();
  }

  async function refreshProviders() {
    await attach();
    if (!attached?.providers?.refresh || conn.status !== 'connected') throw new HttpError(503, 'Paseo is not connected');
    await attached.providers.refresh();
    await loadProviders(true);
    return current();
  }

  function watch(sink: Sink) {
    const write = () => sink.send(JSON.stringify(current()));
    listeners.add(write);
    sink.onClose(() => listeners.delete(write));
    void health().then(write, () => write());
  }

  async function handle(req: Req, res: Res, parts: string[], _readBody: ReadBody, send: Send) {
    const [, a, b] = parts;
    try {
      if (a === 'health' && req.method === 'GET') return send(res, 200, await health());
      if (a === 'restart' && req.method === 'POST') return send(res, 202, restart());
      if (a === 'providers' && b === 'refresh' && req.method === 'POST') return send(res, 200, await refreshProviders());
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { boot: attach, health, current, restart, refreshProviders, watch, handle, onChange: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) };
}
