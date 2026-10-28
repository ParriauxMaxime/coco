// A workspace's files as the Paseo app's file explorer shows them: a directory at a time, a file's text (or an image, or a binary/too large note),
// its whole list for quick open, and a save the owner clicks. Paseo's file API while the daemon answers, the file system otherwise; every path is
// checked here first, the daemon's own check aside: relative, no `..`, and its real path (symlinks followed) inside the workspace.
// GET /api/workspaces/<id>/files/list|read|stat?path= · GET /api/workspaces/<id>/files/tree · POST /api/workspaces/<id>/files/write
// topic workspace-file:<id>:<path>: `ready` then `changed` (modifiedAt, size) or `missing` as the file moves on disk
import fs from 'node:fs/promises';
import { unwatchFile, watchFile } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { checkPath } from './code.ts';
import { launcherEnv } from './paseo-agent.ts';
import { within } from './workspace-git.ts';
import { HttpError, errorMessage, errorStatus } from './core-types.ts';
import type { FilesApi } from './paseo-agent.ts';
import type { ReadBody, Req, Res, Send } from './core-types.ts';
import type { Sink } from './events.ts';

export type FsEntry = { name: string; path: string; kind: 'dir' | 'file'; size: number; modifiedAt: string; link?: boolean };
export type FsFile = { path: string; size: number; modifiedAt: string; revision?: string; kind: 'text' | 'image' | 'binary' | 'large'; content?: string; mime?: string; dataUrl?: string };
type Deps = {
  dirOf: (id: string) => Promise<string>;
  // the daemon's file calls while it is connected, else null: the file system does the work
  files?: () => Promise<FilesApi | null>;
  pollMs?: number;
  sdkMs?: number;
};

const SDK_MS = 10000;
const POLL_MS = 1000;
export const MAX_READ = 2 * 1024 * 1024;
const MAX_BODY = 3 * MAX_READ;
const MAX_ENTRIES = 5000;
const MAX_TREE = 50000;
const SKIP = new Set(['.git', 'node_modules']);
const IMAGES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' };

const iso = (st: Stats) => new Date(st.mtimeMs).toISOString();
export const isBinary = (buf: Uint8Array) => buf.subarray(0, 8192).includes(0);
const imageMime = (p: string) => IMAGES[path.extname(p).slice(1).toLowerCase()];

class Conflict extends HttpError {
  modifiedAt: string | null;
  constructor(modifiedAt: string | null) {
    super(409, modifiedAt ? 'the file changed on disk since it was read' : 'the file is gone from disk');
    this.modifiedAt = modifiedAt;
  }
}

// rel inside root: lexically (checkPath) and once symlinks are followed; '' is root itself when allowed
export async function inside(root: string, rel: unknown, allowRoot = false) {
  const base = await fs.realpath(root);
  if (allowRoot && (rel === '' || rel === undefined || rel === null)) return { base, real: base, rel: '' };
  const p = checkPath(rel);
  let real: string;
  try {
    real = await fs.realpath(path.join(base, p));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, `no ${p} in the workspace`);
    throw e;
  }
  if (real !== base && !real.startsWith(base + path.sep)) throw new HttpError(403, `${p} leads outside the workspace`);
  return { base, real, rel: p };
}

// a real path in the repo's git data: a .git segment in any case (a symlink to .git/config, .GIT on a case-insensitive disk), or under the
// directories git itself names (a separate git dir, a worktree's common dir)
async function inGitDir(base: string, real: string) {
  if (path.relative(base, real).split(path.sep).some((s) => s.toLowerCase() === '.git')) return true;
  const out = await new Promise<string>((resolve) => execFile('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: base, env: launcherEnv(), timeout: 10000, encoding: 'utf8' }, (err, o) => resolve(err ? '' : o)));
  const dirs = await Promise.all(out.split('\n').filter(Boolean).map((d) => fs.realpath(d).catch(() => d)));
  const r = real.toLowerCase();
  return dirs.some((d) => r === d.toLowerCase() || r.startsWith(d.toLowerCase() + path.sep));
}

export function createWorkspaceFiles({ dirOf, files = async () => null, pollMs = POLL_MS, sdkMs = SDK_MS }: Deps) {
  const sdk = () => within(files(), 2000).catch(() => null);

  async function list(root: string, rel: unknown) {
    const { real, rel: dir } = await inside(root, rel, true);
    if (!(await fs.stat(real)).isDirectory()) throw new HttpError(400, `${dir} is not a directory`);
    const join = (name: string) => (dir ? `${dir}/${name}` : name);
    let entries: FsEntry[] | null = null;
    let via: 'paseo' | 'fs' = 'paseo';
    const c = await sdk();
    if (c) {
      try {
        const d = await within(c.listDirectory(root, dir || '.'), SDK_MS);
        entries = d.entries.map((e) => ({ name: e.name, path: join(e.name), kind: e.kind === 'directory' ? 'dir' : 'file', size: e.size, modifiedAt: e.modifiedAt }));
      } catch {}
    }
    if (!entries) {
      via = 'fs';
      const dirents = (await fs.readdir(real, { withFileTypes: true })).slice(0, MAX_ENTRIES + 1);
      entries = await Promise.all(dirents.map(async (d): Promise<FsEntry> => {
        const st = await fs.stat(path.join(real, d.name)).catch(() => null);
        return { name: d.name, path: join(d.name), kind: st?.isDirectory() ? 'dir' : 'file', size: st?.size ?? 0, modifiedAt: st ? iso(st) : '', ...(d.isSymbolicLink() ? { link: true } : {}) };
      }));
    }
    entries.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name));
    return { path: dir, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES, via };
  }

  async function stat(root: string, rel: unknown) {
    try {
      const { real, rel: p } = await inside(root, rel);
      const st = await fs.stat(real);
      return { path: p, kind: st.isDirectory() ? 'dir' : 'file', size: st.size, modifiedAt: iso(st) };
    } catch (e) {
      if (errorStatus(e) === 404) return { path: String(rel), kind: 'missing' };
      throw e;
    }
  }

  async function read(root: string, rel: unknown): Promise<FsFile> {
    const { real, rel: p } = await inside(root, rel);
    const st = await fs.stat(real);
    if (!st.isFile()) throw new HttpError(400, `${p} is not a file`);
    const meta = { path: p, size: st.size, modifiedAt: iso(st) };
    if (st.size > MAX_READ) return { ...meta, kind: 'large' };
    let bytes: Uint8Array | null = null;
    let revision: string | undefined;
    const c = await sdk();
    if (c) {
      try {
        const r = await within(c.readFile(root, p, undefined, MAX_READ), SDK_MS);
        bytes = r.bytes;
        Object.assign(meta, { size: r.size, modifiedAt: r.modifiedAt });
        revision = r.revision;
      } catch {}
    }
    bytes ??= await fs.readFile(real);
    const mime = imageMime(p);
    if (mime) return { ...meta, kind: 'image', mime, dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` };
    if (isBinary(bytes)) return { ...meta, kind: 'binary' };
    return { ...meta, ...(revision ? { revision } : {}), kind: 'text', content: Buffer.from(bytes).toString('utf8') };
  }

  // a save over the version the owner read: a file changed on disk since is a conflict, the owner decides
  async function write(root: string, body: Record<string, unknown>) {
    const p = checkPath(body.path);
    if (p.split('/').some((s) => s.toLowerCase() === '.git')) throw new HttpError(403, 'coco does not write inside .git');
    const { content, expectedModifiedAt: expected, expectedRevision } = body;
    if (typeof content !== 'string' || content.length > MAX_READ) throw new HttpError(400, `content: a text of at most ${MAX_READ} characters`);
    if (typeof expected !== 'string' || !expected) throw new HttpError(400, 'expectedModifiedAt: the modifiedAt of the version read');
    const { base, real } = await inside(root, p).catch((e) => {
      throw errorStatus(e) === 404 ? new Conflict(null) : e;
    });
    if (await inGitDir(base, real)) throw new HttpError(403, 'coco does not write inside .git');
    const st = await fs.stat(real);
    if (!st.isFile()) throw new HttpError(400, `${p} is not a file`);
    const c = await sdk();
    if (c) {
      let r: Awaited<ReturnType<FilesApi['writeFile']>> | null = null;
      try {
        r = await within(c.writeFile({ cwd: root, path: p, content, expectedModifiedAt: expected, ...(typeof expectedRevision === 'string' && expectedRevision ? { expectedRevision } : {}) }), SDK_MS);
      } catch {}
      if (r?.status === 'written') return { ok: true, modifiedAt: r.modifiedAt, size: r.size, ...(r.revision ? { revision: r.revision } : {}), via: 'paseo' };
      if (r?.status === 'conflict') throw new Conflict(r.version.status === 'ready' ? r.version.modifiedAt : null);
      if (r?.status === 'error') throw new HttpError(409, r.error);
    }
    if (iso(st) !== expected) throw new Conflict(iso(st));
    await fs.writeFile(real, content);
    const after = await fs.stat(real);
    return { ok: true, modifiedAt: iso(after), size: after.size, via: 'fs' };
  }

  // every file for quick open: git's list (tracked and untracked, ignored left out), else a walk past .git and node_modules
  async function tree(root: string) {
    const base = await fs.realpath(root);
    const git = await new Promise<string | null>((resolve) => execFile('git', ['--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: base, env: launcherEnv(), maxBuffer: 256 * 1024 * 1024, timeout: 30000, encoding: 'utf8' }, (err, out) => resolve(err ? null : out)));
    if (git !== null) {
      const all = [...new Set(git.split('\0').filter(Boolean))];
      return { files: all.slice(0, MAX_TREE), truncated: all.length > MAX_TREE };
    }
    const out: string[] = [];
    const queue = [''];
    while (queue.length && out.length < MAX_TREE) {
      const dir = queue.shift() as string;
      const dirents = await fs.readdir(path.join(base, dir), { withFileTypes: true }).catch(() => []);
      for (const d of dirents) {
        const p = dir ? `${dir}/${d.name}` : d.name;
        if (d.isDirectory()) {
          if (!SKIP.has(d.name)) queue.push(p);
        } else out.push(p);
      }
    }
    return { files: out.slice(0, MAX_TREE), truncated: out.length >= MAX_TREE };
  }

  // ---- live: one watch per file, Paseo's file subscription while it answers, else a stat poll (an editor's save by rename included)

  type Version = { status: 'ready'; modifiedAt: string; size: number } | { status: 'missing' | 'error' };
  type Watch = { sinks: Set<Sink>; last: string; stop: () => void; done: boolean };
  const watched = new Map<string, Watch>();
  const tag = (v: Version) => (v.status === 'ready' ? `${v.modifiedAt}:${v.size}` : v.status);

  function follow(root: string, p: string, real: string, st: Stats): Watch {
    const w: Watch = { sinks: new Set(), last: `${iso(st)}:${st.size}`, stop: () => {}, done: false };
    const emit = (v: Version) => {
      if (v.status === 'error' || tag(v) === w.last) return;
      w.last = tag(v);
      const msg = JSON.stringify(v.status === 'ready' ? { type: 'changed', modifiedAt: v.modifiedAt, size: v.size } : { type: 'missing' });
      w.sinks.forEach((s) => s.send(msg));
    };
    void (async () => {
      const c = await sdk();
      if (c) {
        const sub = (async () => c.subscribeFile({ cwd: root, path: p }, (v) => emit(v)))();
        try {
          const s = await within(sub, sdkMs);
          w.stop = () => void s.unsubscribe().catch(() => {});
          if (w.done) w.stop();
          else emit(s.initial);
          return;
        } catch {
          // the poll takes over: a subscription that still comes through is let go
          sub.then((s) => s.unsubscribe().catch(() => {}), () => {});
        }
      }
      const onStat = (cur: Stats) => emit(cur.mtimeMs ? { status: 'ready', modifiedAt: iso(cur), size: cur.size } : { status: 'missing' });
      watchFile(real, { interval: pollMs, persistent: false }, onStat);
      w.stop = () => unwatchFile(real, onStat);
      if (w.done) w.stop();
    })();
    return w;
  }

  async function watch(sink: Sink, id: string, rel: string) {
    const root = await dirOf(id);
    const { real, rel: p } = await inside(root, rel);
    const st = await fs.stat(real);
    if (sink.closed) return;
    const w = watched.get(real) ?? follow(root, p, real, st);
    watched.set(real, w);
    w.sinks.add(sink);
    sink.send(JSON.stringify({ type: 'ready', modifiedAt: iso(st), size: st.size }));
    sink.onClose(() => {
      w.sinks.delete(sink);
      if (w.sinks.size) return;
      w.done = true;
      w.stop();
      if (watched.get(real) === w) watched.delete(real);
    });
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [, id, , action, extra] = parts;
    try {
      if (!id || parts[2] !== 'files' || !action || extra) throw new HttpError(404, 'no route');
      const q = new URL(req.url || '/', 'http://x').searchParams;
      if (req.method === 'GET') {
        const root = await dirOf(id);
        if (action === 'list') return send(res, 200, await list(root, q.get('path') ?? ''));
        if (action === 'read') return send(res, 200, await read(root, q.get('path')));
        if (action === 'stat') return send(res, 200, await stat(root, q.get('path')));
        if (action === 'tree') return send(res, 200, await tree(root));
        throw new HttpError(404, 'no route');
      }
      if (req.method !== 'POST' || action !== 'write') throw new HttpError(404, 'no route');
      const raw = await readBody(req);
      if (raw.length > MAX_BODY) throw new HttpError(413, 'the file is too large to save from coco');
      let body: unknown;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        throw new HttpError(400, 'the body is not JSON');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'the body must be an object');
      return send(res, 200, await write(await dirOf(id), body as Record<string, unknown>));
    } catch (e) {
      return send(res, errorStatus(e), { error: errorMessage(e), ...(e instanceof Conflict ? { conflict: true, modifiedAt: e.modifiedAt } : {}) });
    }
  }

  return { handle, watch };
}
