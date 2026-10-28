// A workspace's terminals and scripts as the Paseo app shows them: its terminals live (xterm in the page), a new one in its directory, Kill;
// its workspace scripts with status and port, Start / Stop, a script's output read as a terminal. Paseo's terminal API only: with the daemon
// away there is nothing to show. No MCP tool reaches these routes: what is typed, killed, started or stopped is the owner's click.
// GET /api/workspaces/<id>/terminals · POST .../terminals { name?, rows?, cols? } · POST .../terminals/<tid>/input { data } | resize { rows, cols } | kill
// GET /api/workspaces/<id>/scripts · POST .../scripts/<name>/start|stop
// topics: workspace-terminals:<id> (the terminals and the scripts, live) · terminal:<id>:<tid> (`output` base64, `reset` with the screen so far, `exit`)
// <id>: as in server/workspace-git.ts; a `p.<path>` worktree has terminals by its directory and no scripts (they belong to a Paseo workspace)
import { renderTerminalSnapshotToAnsi } from '@getpaseo/protocol/terminal-snapshot';
import { within } from './workspace-git.ts';
import { HttpError, errorMessage, errorStatus } from './core-types.ts';
import type { TerminalApi } from './paseo-agent.ts';
import type { ReadBody, Req, Res, Send } from './core-types.ts';
import type { Sink } from './events.ts';

export type Term = { id: string; name: string; title: string | null; busy: boolean };
export type Script = { name: string; type: string; running: boolean; health: string | null; port: number | null; url: string | null; exitCode: number | null; terminalId: string | null };
type Deps = {
  dirOf: (id: string) => Promise<string>;
  // the daemon's terminal calls while it is connected, else null
  daemon: () => Promise<TerminalApi | null>;
  pollMs?: number;
};
type RawTerm = { id: string; name: string; title?: string; activity?: { state?: string } | null };
type RawScript = { scriptName: string; type?: string; lifecycle: string; health: string | null; port: number | null; proxyUrl?: string | null; localProxyUrl?: string | null; exitCode?: number | null; terminalId?: string | null };

const SDK_MS = 10000;
const POLL_MS = 4000;
const OWNED_MS = 5000;
const SCROLLBACK = 5000;
const MAX_INPUT = 64 * 1024;
const TERM_ID = /^[\w.:-]{1,200}$/;
// a script's name comes from the workspace's own config: any printable text, looked up among the listed ones
const SCRIPT_NAME = /^[^\x00-\x1f\x7f/]{1,200}$/;

const termOf = (t: RawTerm): Term => ({ id: t.id, name: t.name, title: t.title || null, busy: Boolean(t.activity?.state && t.activity.state !== 'idle') });
const scriptOf = (s: RawScript): Script => ({
  name: s.scriptName,
  type: s.type || 'service',
  running: s.lifecycle === 'running',
  health: s.health,
  port: s.port,
  url: s.localProxyUrl || s.proxyUrl || (s.port ? `http://localhost:${s.port}` : null),
  exitCode: s.exitCode ?? null,
  terminalId: s.terminalId ?? null,
});
const int = (v: unknown, name: string, max: number) => {
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) throw new HttpError(400, `${name}: a whole number from 1 to ${max}`);
  return v as number;
};

export function createWorkspaceTerminals({ dirOf, daemon, pollMs = POLL_MS }: Deps) {
  const api = async () => {
    const d = await within(daemon(), 2000).catch(() => null);
    if (!d) throw new HttpError(503, 'Paseo is not connected: terminals come from its daemon');
    return d;
  };
  type At = { cwd: string; workspaceId: string | undefined };
  const placeOf = async (id: string): Promise<At> => ({ cwd: await dirOf(id), workspaceId: id.startsWith('p.') ? undefined : id });
  const scope = (at: At) => (at.workspaceId ? { workspaceId: at.workspaceId } : undefined);

  async function terminals(d: TerminalApi, at: At) {
    const r = await within(d.listTerminals(at.cwd, undefined, scope(at)), SDK_MS);
    return r.terminals.map(termOf);
  }
  async function scripts(d: TerminalApi, at: At) {
    if (!at.workspaceId) return [];
    const r = await within(d.listWorkspaceScripts(at.workspaceId), SDK_MS);
    if (r.error) throw new HttpError(409, r.error);
    return (r.scripts ?? []).map(scriptOf);
  }

  // a terminal id from the page must be this workspace's: one of its terminals or a script's output; kept a few seconds for typing
  const owned = new Map<string, { at: number; ids: Set<string> }>();
  async function own(d: TerminalApi, at: At, tid: string) {
    if (!TERM_ID.test(tid)) throw new HttpError(400, 'bad terminal id');
    const hit = owned.get(at.cwd);
    if (hit && Date.now() - hit.at < OWNED_MS && hit.ids.has(tid)) return;
    const [list, s] = await Promise.all([terminals(d, at), scripts(d, at).catch(() => [])]);
    const ids = new Set([...list.map((t) => t.id), ...s.flatMap((x) => (x.terminalId ? [x.terminalId] : []))]);
    owned.set(at.cwd, { at: Date.now(), ids });
    if (!ids.has(tid)) throw new HttpError(404, `no terminal ${tid} in this workspace`);
  }
  async function scriptNamed(d: TerminalApi, at: At, name: string) {
    if (!SCRIPT_NAME.test(name)) throw new HttpError(400, 'bad script name');
    if (!at.workspaceId) throw new HttpError(404, 'scripts belong to a Paseo workspace');
    if (!(await scripts(d, at)).some((s) => s.name === name)) throw new HttpError(404, `no script ${name} in this workspace`);
    return at.workspaceId;
  }

  async function create(d: TerminalApi, at: At, body: Record<string, unknown>) {
    const name = body.name === undefined || body.name === '' ? undefined : body.name;
    if (name !== undefined && (typeof name !== 'string' || !SCRIPT_NAME.test(name) || name.length > 100)) throw new HttpError(400, 'name: at most 100 characters');
    const size = body.rows === undefined && body.cols === undefined ? undefined : { rows: int(body.rows, 'rows', 500), cols: int(body.cols, 'cols', 1000) };
    if (!at.workspaceId) throw new HttpError(409, 'Paseo opens a terminal in a workspace: this worktree has none');
    const r = await within(d.createTerminal(at.cwd, name, undefined, { workspaceId: at.workspaceId, ...(size ? { size } : {}) }), SDK_MS);
    if (r.error || !r.terminal) throw new HttpError(409, r.error || 'Paseo made no terminal');
    owned.delete(at.cwd);
    return { terminal: termOf(r.terminal) };
  }

  async function act(d: TerminalApi, at: At, tid: string, action: string, body: Record<string, unknown>) {
    if (action === 'input') {
      if (typeof body.data !== 'string' || !body.data || body.data.length > MAX_INPUT) throw new HttpError(400, `data: 1 to ${MAX_INPUT} characters`);
      await own(d, at, tid);
      d.sendTerminalInput(tid, { type: 'input', data: body.data });
      return { ok: true };
    }
    if (action === 'resize') {
      const rows = int(body.rows, 'rows', 500);
      const cols = int(body.cols, 'cols', 1000);
      await own(d, at, tid);
      d.sendTerminalInput(tid, { type: 'resize', rows, cols });
      return { ok: true };
    }
    if (action === 'kill') {
      await own(d, at, tid);
      const r = await within(d.killTerminal(tid), SDK_MS);
      if (!r.success) throw new HttpError(409, 'Paseo did not kill it');
      owned.delete(at.cwd);
      return { ok: true };
    }
    throw new HttpError(404, 'no route');
  }

  async function script(d: TerminalApi, at: At, name: string, action: string) {
    if (action !== 'start' && action !== 'stop') throw new HttpError(404, 'no route');
    const ws = await scriptNamed(d, at, name);
    const r = await within(action === 'start' ? d.startWorkspaceScriptWithStatus(ws, name) : d.stopWorkspaceScript(ws, name), SDK_MS);
    if (r.error) throw new HttpError(409, r.error);
    owned.delete(at.cwd);
    return { script: r.script ? scriptOf(r.script) : null };
  }

  // ---- live

  async function watchList(sink: Sink, id: string) {
    const at = await placeOf(id);
    const d = await api();
    if (sink.closed) return;
    const sendTerms = (list: RawTerm[]) => sink.send(JSON.stringify({ type: 'terminals', terminals: list.map(termOf) }));
    const sub = d.observeTerminals({ cwd: at.cwd, ...scope(at) });
    sub.subscribe({
      snapshot: (p) => sendTerms(p.terminals),
      update: (m) => m.type === 'terminals_changed' && sendTerms(m.payload.terminals),
      error: (e) => sink.send(JSON.stringify({ error: errorMessage(e), status: 502 }), 'error'),
    });
    let last = '';
    const poll = async () => {
      const list = await scripts(d, at).catch(() => null);
      const json = list && JSON.stringify(list);
      if (json && json !== last && !sink.closed) {
        last = json;
        sink.send(JSON.stringify({ type: 'scripts', scripts: list, supported: Boolean(at.workspaceId) }));
      }
    };
    void poll();
    const timer = setInterval(poll, pollMs);
    timer.unref?.();
    sink.onClose(() => {
      clearInterval(timer);
      void sub.release().catch(() => {});
    });
  }

  // a terminal's output, base64: `reset` first with its screen and scrollback, then each `output`; `exit` once Paseo stops streaming it
  async function watchTerminal(sink: Sink, id: string, tid: string) {
    const at = await placeOf(id);
    const d = await api();
    await own(d, at, tid);
    if (sink.closed) return;
    const send = (type: string, data: Uint8Array | string) => sink.send(JSON.stringify({ type, data: Buffer.from(data).toString('base64') }));
    const exit = (error: string | null) => sink.send(JSON.stringify({ type: 'exit', error }));
    const sub = d.observeTerminal(tid, (e) => {
      if (e.type === 'output') send('output', e.data);
      else if (e.type === 'restore') send('reset', e.data);
      else send('reset', renderTerminalSnapshotToAnsi(e.state));
    }, { restore: { mode: 'full-snapshot', scrollbackLines: SCROLLBACK } });
    sub.subscribe({
      snapshot: (p) => p.error && exit(p.error),
      update: (m) => m.type === 'terminal_stream_exit' && exit(m.payload.error ?? null),
      error: (e) => exit(errorMessage(e)),
    });
    sink.onClose(() => void sub.release().catch(() => {}));
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [, id, kind, raw, action, extra] = parts;
    try {
      let sub = raw;
      try {
        sub = raw === undefined ? raw : decodeURIComponent(raw);
      } catch {
        throw new HttpError(400, 'bad path');
      }
      if (!id || (kind !== 'terminals' && kind !== 'scripts') || extra !== undefined) throw new HttpError(404, 'no route');
      if (req.method === 'GET') {
        if (sub) throw new HttpError(404, 'no route');
        const at = await placeOf(id);
        const d = await api();
        if (kind === 'terminals') return send(res, 200, { cwd: at.cwd, terminals: await terminals(d, at) });
        return send(res, 200, { supported: Boolean(at.workspaceId), scripts: await scripts(d, at) });
      }
      if (req.method !== 'POST' || (sub && !action) || (!sub && kind === 'scripts')) throw new HttpError(404, 'no route');
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        throw new HttpError(400, 'the body is not JSON');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'the body must be an object');
      const at = await placeOf(id);
      const d = await api();
      if (kind === 'scripts') return send(res, 200, await script(d, at, sub, action));
      if (!sub) return send(res, 200, await create(d, at, body as Record<string, unknown>));
      return send(res, 200, await act(d, at, sub, action, body as Record<string, unknown>));
    } catch (e) {
      return send(res, errorStatus(e), { error: errorMessage(e) });
    }
  }

  return { handle, watchList, watchTerminal };
}
