// A workspace's git as the Paseo app's checkout panel shows it: branch, ahead/behind its upstream and base, the working-tree diff, unpushed commits,
// and what the owner clicks (commit, pull, push, create PR, discard, stash). Paseo's checkout API while the daemon answers, plain git in the
// workspace otherwise (reads with --no-optional-locks). No MCP tool reaches these routes: a push or a PR is always the owner's click.
// GET /api/workspaces/<id>/git/status|diff|diff/file|commits|pr|commit/<sha>/refs|file|diff · POST /api/workspaces/<id>/git/commit|pull|push|pr|discard|stash
// <id>: a Paseo workspace id, or `p.<base64url path>` for a worktree of a configured repo that no workspace holds
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { checkPath, createCode, parseDiffFiles } from './code.ts';
import { gitWorktrees } from './worktrees.ts';
import { launcherEnv } from './paseo-agent.ts';
import { HttpError, errorMessage, errorStatus } from './core-types.ts';
import type { CheckoutApi, WorkspaceEntry } from './paseo-agent.ts';
import type { PrFile, ReadBody, Req, Res, Send } from './core-types.ts';
import type { Sink } from './events.ts';

type Out = { ok: boolean; stdout: string; stderr: string };
export type GitStatus = { branch: string | null; upstream: string | null; ahead: number | null; behind: number | null; base: string | null; aheadBase: number | null; behindBase: number | null; dirty: boolean; hasRemote: boolean; stashes: { index: number; message: string }[]; via: 'paseo' | 'git' };
export type GitCommit = { sha: string; shortSha: string; subject: string; author: string; date: string; files: number | null };
export type GitPr = { number: number | null; url: string; title: string; state: string; isDraft: boolean };
export type GitFile = PrFile & { binary?: boolean };
type Deps = {
  repos: { path: string }[];
  listWorkspaces: () => Promise<WorkspaceEntry[]>;
  // the daemon's checkout calls while it is connected, else null: git does the work
  checkout?: () => Promise<CheckoutApi | null>;
  pollMs?: number;
};

const SDK_MS = 10000;
const NET_MS = 120000;
const SPACES_TTL = 30000;
const POLL_MS = 3000;
const MAX_TEXT = 5 * 1024 * 1024;
const MAX_PATHS = 500;
const MAX_COMMITS = 50;
const SDK_COMMITS = 10;
const PATH_ID = /^p\.([A-Za-z0-9_-]{1,2000})$/;
const PASEO_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const BRANCH_RE = /^[\w][\w./-]{0,200}$/;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const pathId = (dir: string) => `p.${Buffer.from(dir).toString('base64url')}`;
const samePath = (a: string, b: string) => path.resolve(a) === path.resolve(b);
const within = <T>(p: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('Paseo did not answer in time')), ms)))]).finally(() => clearTimeout(timer));
};
const why = (r: Out) => (r.stderr || r.stdout).trim().slice(0, 500) || 'failed';
// a checkout payload's own error: the daemon did the call and git said no
const refused = <T extends { error?: { message: string } | null; success?: boolean }>(r: T) => {
  if (r.error || r.success === false) throw new HttpError(409, r.error?.message || 'Paseo refused');
  return r;
};

export function createWorkspaceGit({ repos, listWorkspaces, checkout = async () => null, pollMs = POLL_MS }: Deps) {
  const env = { ...launcherEnv(), GIT_TERMINAL_PROMPT: '0' };
  const run = (cmd: string, args: string[], cwd: string, timeout = 30000) =>
    new Promise<Out>((resolve) => {
      execFile(cmd, args, { cwd, env, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: String(stderr || err?.message || '') }));
    });
  const git = (cwd: string, args: string[], timeout?: number) => run('git', args, cwd, timeout);
  const read = (cwd: string, args: string[]) => git(cwd, ['--no-optional-locks', ...args]);
  const must = async (p: Promise<Out>) => {
    const r = await p;
    if (!r.ok) throw new HttpError(409, why(r));
    return r;
  };
  // a daemon that does not answer quickly leaves the work to git
  const sdk = () => within(checkout(), 2000).catch(() => null);

  let spaces: { at: number; list: Promise<WorkspaceEntry[]> } | null = null;
  const workspaces = (fresh = false) => {
    if (!spaces || fresh || Date.now() - spaces.at > SPACES_TTL) {
      const list = listWorkspaces();
      spaces = { at: Date.now(), list };
      list.catch(() => (spaces = null));
    }
    return spaces.list;
  };

  async function dirOf(id: string): Promise<string> {
    const m = PATH_ID.exec(id);
    let dir: string | undefined;
    if (m) {
      dir = Buffer.from(m[1], 'base64url').toString('utf8');
      if (!path.isAbsolute(dir)) throw new HttpError(400, 'bad workspace id');
      const trees = (await Promise.all(repos.filter((r) => r.path).map((r) => gitWorktrees((cmd, args) => run(cmd, args, r.path), r.path)))).flat();
      if (!trees.some((t) => samePath(t.path, dir as string))) throw new HttpError(404, 'not a worktree of a configured repo');
    } else {
      if (!PASEO_ID.test(id)) throw new HttpError(400, 'bad workspace id');
      const find = async (fresh: boolean) => (await workspaces(fresh)).find((w) => w.id === id && !w.archivingAt);
      const found = (await find(false)) || (await find(true));
      dir = found?.workspaceDirectory;
      if (!dir) throw new HttpError(404, `no workspace ${id}`);
    }
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(404, `${dir} is gone`);
    return dir;
  }

  // ---- reads

  async function baseOf(cwd: string) {
    const head = await read(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
    for (const ref of [head.ok ? head.stdout.trim() : '', 'origin/main', 'origin/master', 'main', 'master']) {
      if (ref && (await read(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])).ok) return ref;
    }
    return null;
  }

  async function stashesOf(cwd: string, branch: string | null) {
    const r = await read(cwd, ['stash', 'list', '--format=%gd%x1f%gs']);
    if (!r.ok || !branch) return [];
    return r.stdout.split('\n').flatMap((line) => {
      const [ref, subject = ''] = line.split('\x1f');
      const n = /^stash@\{(\d+)\}$/.exec(ref);
      return n && (subject.startsWith(`On ${branch}:`) || subject.startsWith(`WIP on ${branch}:`)) ? [{ index: Number(n[1]), message: subject }] : [];
    });
  }

  async function gitStatus(cwd: string): Promise<GitStatus> {
    const st = await read(cwd, ['status', '--porcelain=v2', '--branch', '-z']);
    if (!st.ok) throw new HttpError(409, `not a git checkout: ${why(st)}`);
    const lines = st.stdout.split('\0').filter(Boolean);
    const header = (key: string) => lines.find((l) => l.startsWith(`# branch.${key} `))?.slice(`# branch.${key} `.length) ?? null;
    const head = header('head');
    const branch = head && head !== '(detached)' ? head : null;
    const ab = /^\+(\d+) -(\d+)$/.exec(header('ab') || '');
    const base = await baseOf(cwd);
    const vsBase = base ? await read(cwd, ['rev-list', '--left-right', '--count', `${base}...HEAD`]) : null;
    const [behindBase, aheadBase] = vsBase?.ok ? vsBase.stdout.trim().split(/\s+/).map(Number) : [null, null];
    const remotes = await read(cwd, ['remote']);
    return {
      branch,
      upstream: header('upstream'),
      ahead: ab ? Number(ab[1]) : null,
      behind: ab ? Number(ab[2]) : null,
      base,
      aheadBase: aheadBase ?? null,
      behindBase: behindBase ?? null,
      dirty: lines.some((l) => !l.startsWith('#')),
      hasRemote: Boolean(remotes.ok && remotes.stdout.trim()),
      stashes: await stashesOf(cwd, branch),
      via: 'git',
    };
  }

  async function status(cwd: string): Promise<GitStatus> {
    const c = await sdk();
    if (c) {
      try {
        const s = await within(c.getCheckoutStatus(cwd), SDK_MS);
        if (s.isGit && !s.error) {
          return {
            branch: s.currentBranch,
            upstream: s.upstreamRef ? s.upstreamRef.replace(/^refs\/(remotes|heads)\//, '') : null,
            ahead: s.aheadOfOrigin,
            behind: s.behindOfOrigin,
            base: s.baseRef,
            aheadBase: s.aheadBehind?.ahead ?? null,
            behindBase: s.aheadBehind?.behind ?? null,
            dirty: s.isDirty,
            // Paseo looks for an origin: a checkout tracking another remote has one too
            hasRemote: s.hasRemote || Boolean(s.upstreamRef?.startsWith('refs/remotes/')),
            stashes: await stashesOf(cwd, s.currentBranch),
            via: 'paseo',
          };
        }
      } catch {}
    }
    return gitStatus(cwd);
  }

  async function lineCount(file: string) {
    const st = await fs.stat(file).catch(() => null);
    if (!st?.isFile() || st.size > MAX_TEXT) return { additions: 0, binary: !st?.isFile() };
    const buf = await fs.readFile(file);
    if (buf.subarray(0, 8192).includes(0)) return { additions: 0, binary: true };
    const text = buf.toString('utf8');
    return { additions: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, binary: false };
  }

  async function gitDiff(cwd: string): Promise<GitFile[]> {
    const head = (await read(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).ok ? 'HEAD' : EMPTY_TREE;
    const [ns, nu, others] = await Promise.all([
      read(cwd, ['diff', '-M', '--no-ext-diff', '--name-status', '-z', head]),
      read(cwd, ['diff', '-M', '--no-ext-diff', '--numstat', '-z', head]),
      read(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    if (!ns.ok || !nu.ok) throw new HttpError(409, `git diff: ${why(ns.ok ? nu : ns)}`);
    const tracked: GitFile[] = parseDiffFiles(ns.stdout, nu.stdout);
    const untracked = await Promise.all(others.stdout.split('\0').filter(Boolean).slice(0, MAX_PATHS).map(async (filename): Promise<GitFile> => ({ filename, status: 'added', deletions: 0, ...(await lineCount(path.join(cwd, filename))) })));
    return [...tracked, ...untracked];
  }

  async function diff(cwd: string): Promise<{ files: GitFile[]; via: 'paseo' | 'git' }> {
    const c = await sdk();
    if (c) {
      try {
        const d = await within(c.getCheckoutDiff(cwd, { mode: 'uncommitted' }), SDK_MS);
        if (!d.error && !d.diffTooLarge) {
          const files = d.files.map((f): GitFile => ({
            filename: f.path,
            status: f.isNew ? 'added' : f.isDeleted ? 'removed' : f.oldPath && f.oldPath !== f.path ? 'renamed' : 'modified',
            ...(f.oldPath && f.oldPath !== f.path ? { previous: f.oldPath } : {}),
            additions: f.additions,
            deletions: f.deletions,
            ...(f.status === 'binary' ? { binary: true } : {}),
          }));
          return { files, via: 'paseo' };
        }
      } catch {}
    }
    return { files: await gitDiff(cwd), via: 'git' };
  }

  // a changed file's two sides: HEAD (its old path when renamed) and the working tree
  async function fileTexts(cwd: string, q: URLSearchParams) {
    const p = checkPath(q.get('path'));
    const previous = q.get('previous') ? checkPath(q.get('previous')) : null;
    const abs = path.join(cwd, p);
    if (!abs.startsWith(path.resolve(cwd) + path.sep)) throw new HttpError(400, 'invalid path');
    const [old, cur] = await Promise.all([
      new Promise<Buffer | null>((resolve) => execFile('git', ['--no-optional-locks', 'show', `HEAD:${previous || p}`], { cwd, env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? null : out))),
      fs.lstat(abs).then((st): Promise<Buffer | 'large' | null> | 'large' | null => (!st.isFile() ? null : st.size > MAX_TEXT ? 'large' : fs.readFile(abs)), () => null),
    ]);
    if (cur === 'large' || (old?.length ?? 0) > MAX_TEXT) return { path: p, original: '', modified: '', tooLarge: true };
    const binary = [old, cur].some((b) => b && b.subarray(0, 8192).includes(0));
    const out: { path: string; original: string; modified: string; binary?: boolean; unified?: string } = { path: p, original: binary ? '' : (old?.toString('utf8') ?? ''), modified: binary ? '' : (cur?.toString('utf8') ?? ''), ...(binary ? { binary } : {}) };
    if (q.get('unified') === '1' && !binary) {
      const tracked = old !== null || (await read(cwd, ['ls-files', '--error-unmatch', '--', p])).ok;
      const r = tracked ? await read(cwd, ['diff', '-M', '--no-ext-diff', '--no-color', 'HEAD', '--', `:(literal)${p}`, ...(previous ? [`:(literal)${previous}`] : [])]) : await read(cwd, ['diff', '--no-index', '--no-color', '--', '/dev/null', p]);
      out.unified = r.stdout;
    }
    return out;
  }

  async function commits(cwd: string): Promise<{ commits: GitCommit[]; via: 'paseo' | 'git' }> {
    const c = await sdk();
    if (c) {
      try {
        const [r, branch] = await Promise.all([within(c.listCheckoutCommits(cwd), SDK_MS), read(cwd, ['branch', '--show-current'])]);
        // a feature branch's commits already on its base are not its to push; the base branch's own are
        const onBranch = Boolean(r.baseRef) && r.baseRef?.replace(/^(refs\/heads\/|origin\/)/, '') !== branch.stdout.trim();
        const list = r.commits.filter((x) => !x.isOnRemote && !(onBranch && x.isOnBase));
        // Paseo answers the 10 newest commits only: a full page may hide more, git lists them all
        if (r.commits.length < SDK_COMMITS || list.length < r.commits.length) return { commits: list.map((x) => ({ sha: x.sha, shortSha: x.shortSha, subject: x.subject, author: x.authorName, date: x.authorDate, files: x.files.length })), via: 'paseo' };
      } catch {}
    }
    const [base, branch] = await Promise.all([baseOf(cwd), read(cwd, ['branch', '--show-current'])]);
    const notBase = base && base !== branch.stdout.trim() ? [base] : [];
    const r = await read(cwd, ['log', `-n${MAX_COMMITS}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI', 'HEAD', '--not', '--remotes', ...notBase, '--']);
    if (!r.ok) return { commits: [], via: 'git' };
    const list = r.stdout.split('\n').filter(Boolean).map((l) => {
      const [sha, shortSha, subject, author, date] = l.split('\x1f');
      return { sha, shortSha, subject, author, date, files: null };
    });
    return { commits: list, via: 'git' };
  }

  const prs = new Map<string, { at: number; value: Promise<GitPr | null> }>();
  async function pr(cwd: string, fresh = false): Promise<{ pr: GitPr | null }> {
    const hit = prs.get(cwd);
    if (hit && !fresh && Date.now() - hit.at < 60000) return { pr: await hit.value };
    const value = (async (): Promise<GitPr | null> => {
      const c = await sdk();
      if (c) {
        try {
          const r = await within(c.checkoutPrStatus(cwd), SDK_MS);
          if (!r.error) return r.status ? { number: r.status.number ?? null, url: r.status.url, title: r.status.title, state: r.status.isMerged ? 'merged' : r.status.state.toLowerCase(), isDraft: Boolean(r.status.isDraft) } : null;
        } catch {}
      }
      const r = await run('gh', ['pr', 'view', '--json', 'number,url,title,state,isDraft'], cwd, 20000);
      if (!r.ok) return null;
      try {
        const d = JSON.parse(r.stdout) as { number: number; url: string; title: string; state: string; isDraft: boolean };
        return { number: d.number, url: d.url, title: d.title, state: d.state.toLowerCase(), isDraft: d.isDraft };
      } catch {
        return null;
      }
    })();
    prs.set(cwd, { at: Date.now(), value });
    return { pr: await value };
  }

  // one commit of the workspace against its parent, read from the workspace's own repo
  const coders = new Map<string, ReturnType<typeof createCode>>();
  const coderOf = (cwd: string) => {
    let c = coders.get(cwd);
    if (!c) {
      c = createCode({ REPO: cwd, works: { get: () => null, list: () => [] } });
      coders.set(cwd, c);
      if (coders.size > 20) coders.delete(coders.keys().next().value ?? '');
    }
    return c;
  };

  // ---- writes: each one a click of the owner

  const paths = (v: unknown, required: boolean) => {
    if (v === undefined && !required) return [];
    if (!Array.isArray(v) || (required && !v.length) || v.length > MAX_PATHS) throw new HttpError(400, `paths: a list of 1 to ${MAX_PATHS} files`);
    return [...new Set(v.map(checkPath))];
  };
  const text = (v: unknown, name: string, max: number, required = true) => {
    if (v === undefined && !required) return '';
    if (typeof v !== 'string' || (required && !v.trim()) || v.length > max) throw new HttpError(400, `${name}: ${required ? 'required, ' : ''}at most ${max} characters`);
    return v;
  };

  async function branchOf(cwd: string) {
    const r = await read(cwd, ['branch', '--show-current']);
    const b = r.stdout.trim();
    if (!b) throw new HttpError(409, 'HEAD is detached: check out a branch first');
    return b;
  }

  async function commit(cwd: string, body: Record<string, unknown>) {
    const message = text(body.message, 'message', 10000);
    const picked = paths(body.paths, false);
    const c = picked.length ? null : await sdk();
    if (c) refused(await c.checkoutCommit(cwd, { message, addAll: true }));
    else if (picked.length) {
      await must(git(cwd, ['add', '-A', '--', ...picked]));
      await must(git(cwd, ['commit', '-m', message, '--', ...picked]));
    } else {
      await must(git(cwd, ['add', '-A']));
      await must(git(cwd, ['commit', '-m', message]));
    }
    return { ok: true, sha: (await read(cwd, ['rev-parse', 'HEAD'])).stdout.trim() };
  }

  async function pull(cwd: string) {
    const c = await sdk();
    if (c) refused(await c.checkoutPull(cwd));
    else await must(git(cwd, ['pull', '--ff-only'], NET_MS));
    return { ok: true };
  }

  async function hasUpstream(cwd: string) {
    return (await read(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).ok;
  }

  async function push(cwd: string) {
    const c = await sdk();
    if (c) refused(await c.checkoutPush(cwd));
    else if (await hasUpstream(cwd)) await must(git(cwd, ['push'], NET_MS));
    else await must(git(cwd, ['push', '-u', 'origin', `HEAD:refs/heads/${await branchOf(cwd)}`], NET_MS));
    return { ok: true };
  }

  // a draft goes through gh (Paseo's create has no draft); a branch with no upstream is pushed first, as part of the same click
  async function createPr(cwd: string, body: Record<string, unknown>) {
    const title = text(body.title, 'title', 300);
    const description = text(body.body, 'body', 60000, false);
    const draft = body.draft === true;
    const base = body.base === undefined || body.base === '' ? null : String(body.base);
    if (base !== null && !BRANCH_RE.test(base)) throw new HttpError(400, 'base: a branch name');
    const c = draft ? null : await sdk();
    prs.delete(cwd);
    if (c) {
      const r = refused(await c.checkoutPrCreate(cwd, { title, body: description, ...(base ? { baseRef: base } : {}) }));
      return { ok: true, url: r.url, number: r.number };
    }
    const branch = await branchOf(cwd);
    if (!(await hasUpstream(cwd))) await must(git(cwd, ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], NET_MS));
    const r = await must(run('gh', ['pr', 'create', '--title', title, '--body', description, '--head', branch, ...(draft ? ['--draft'] : []), ...(base ? ['--base', base] : [])], cwd, NET_MS));
    const url = r.stdout.trim().split('\n').pop() || '';
    return { ok: true, url, number: Number(/\/pull\/(\d+)/.exec(url)?.[1]) || null };
  }

  async function discard(cwd: string, body: Record<string, unknown>) {
    const list = paths(body.paths, true);
    const c = await sdk();
    if (c) {
      refused(await c.checkoutDiscardChanges(cwd, { paths: list }));
      return { ok: true };
    }
    const others = new Set((await read(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...list])).stdout.split('\0').filter(Boolean));
    const tracked = list.filter((p) => !others.has(p));
    if (tracked.length) {
      const inHead = new Set((await read(cwd, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...tracked])).stdout.split('\0').filter(Boolean));
      const restore = tracked.filter((p) => inHead.has(p));
      const added = tracked.filter((p) => !inHead.has(p));
      if (restore.length) await must(git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...restore]));
      if (added.length) await must(git(cwd, ['rm', '-f', '-q', '--ignore-unmatch', '--', ...added]));
    }
    if (others.size) await must(git(cwd, ['clean', '-f', '-q', '--', ...others]));
    return { ok: true };
  }

  // the stash stack is shared by every worktree of the repo: pop takes the newest entry made on this branch, never stash@{0} blindly
  async function stash(cwd: string, body: Record<string, unknown>) {
    const branch = await branchOf(cwd);
    if (body.action === 'save') {
      const c = await sdk();
      if (c) refused(await c.stashSave(cwd, { branch }));
      else await must(git(cwd, ['stash', 'push', '-u', '-m', `coco: ${branch}`]));
      return { ok: true };
    }
    if (body.action !== 'pop') throw new HttpError(400, 'action: save or pop');
    const [mine] = await stashesOf(cwd, branch);
    if (!mine) throw new HttpError(409, `no stash made on ${branch}`);
    const c = await sdk();
    if (c) refused(await c.stashPop(cwd, mine.index));
    else await must(git(cwd, ['stash', 'pop', `stash@{${mine.index}}`]));
    return { ok: true };
  }

  // ---- live: one poll per watched directory, a `changed` event when its status, HEAD, stashes or a changed file's mtime move

  type Watch = { sinks: Set<Sink>; last: Promise<string>; busy: boolean; timer?: ReturnType<typeof setInterval> };
  const watched = new Map<string, Watch>();
  // porcelain v2 entries: the path follows 8 fields (1), 9 (2, a rename, its old path in the next entry), 10 (u) or 1 (? and !)
  const FIELDS: Record<string, number> = { '1': 8, '2': 9, u: 10, '?': 1, '!': 1 };
  async function fingerprint(cwd: string) {
    const [st, stash] = await Promise.all([read(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']), read(cwd, ['rev-parse', '-q', '--verify', 'refs/stash'])]);
    const entries = st.stdout.split('\0');
    const files: string[] = [];
    for (let i = 0; i < entries.length && files.length < MAX_PATHS; i++) {
      const n = FIELDS[entries[i][0]];
      if (n) files.push(entries[i].split(' ').slice(n).join(' '));
      if (entries[i][0] === '2') i++;
    }
    const times = await Promise.all(files.map((f) => fs.stat(path.join(cwd, f)).then((s) => `${s.mtimeMs}:${s.size}`, () => '-')));
    return `${st.stdout}\n${stash.stdout}\n${times.join(',')}`;
  }
  const notify = (cwd: string) => watched.get(cwd)?.sinks.forEach((s) => s.send(JSON.stringify({ type: 'changed' })));

  function poll(cwd: string): Watch {
    const w: Watch = { sinks: new Set(), last: fingerprint(cwd).catch(() => ''), busy: false };
    w.timer = setInterval(async () => {
      if (w.busy) return;
      w.busy = true;
      try {
        const next = await fingerprint(cwd);
        if (next !== (await w.last)) {
          w.last = Promise.resolve(next);
          notify(cwd);
        }
      } catch {
      } finally {
        w.busy = false;
      }
    }, pollMs);
    w.timer.unref?.();
    return w;
  }

  async function watch(sink: Sink, id: string) {
    const cwd = await dirOf(id);
    if (sink.closed) return;
    const w = watched.get(cwd) ?? poll(cwd);
    watched.set(cwd, w);
    w.sinks.add(sink);
    sink.send(JSON.stringify({ type: 'ready' }));
    sink.onClose(() => {
      w.sinks.delete(sink);
      if (w.sinks.size) return;
      clearInterval(w.timer);
      if (watched.get(cwd) === w) watched.delete(cwd);
    });
  }

  const WRITES: Record<string, (cwd: string, body: Record<string, unknown>) => Promise<unknown>> = { commit, pull, push, pr: createPr, discard, stash };

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [, id, , action, sub, subAction] = parts;
    try {
      if (!id || parts[2] !== 'git' || !action) throw new HttpError(404, 'no route');
      const q = new URL(req.url || '/', 'http://x').searchParams;
      if (req.method === 'GET') {
        if (action === 'commit') {
          if (!sub || !SHA_RE.test(sub)) throw new HttpError(400, 'bad sha');
          if (!['refs', 'file', 'diff'].includes(subAction)) throw new HttpError(404, 'no route');
          return send(res, 200, await coderOf(await dirOf(id)).commitRoute(sub, subAction, q));
        }
        const cwd = await dirOf(id);
        if (action === 'status') return send(res, 200, { cwd, ...(await status(cwd)) });
        if (action === 'diff' && sub === 'file') return send(res, 200, await fileTexts(cwd, q));
        if (action === 'diff' && !sub) return send(res, 200, await diff(cwd));
        if (action === 'commits') return send(res, 200, await commits(cwd));
        if (action === 'pr') return send(res, 200, await pr(cwd, q.get('fresh') === '1'));
        throw new HttpError(404, 'no route');
      }
      const write = WRITES[action];
      if (req.method !== 'POST' || !write || sub) throw new HttpError(404, 'no route');
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        throw new HttpError(400, 'the body is not JSON');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'the body must be an object');
      const cwd = await dirOf(id);
      const out = await write(cwd, body as Record<string, unknown>);
      notify(cwd);
      return send(res, 200, out);
    } catch (e) {
      return send(res, errorStatus(e), { error: errorMessage(e) });
    }
  }

  return { handle, watch, dirOf };
}
