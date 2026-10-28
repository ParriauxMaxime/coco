// Code source: serves PR content from the local git clone of the repo (never the working tree); a PR's head is its local branch tip when that is ahead of GitHub.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { branchOf, findRow, isLocal, parseKey, rowKey } from './stack.ts';
import { errorMessage } from './core-types.ts';
import type { PrFile, ReadBody, Refs, RefsOptions, Req, Res, RowKey, Send, Works } from './core-types.ts';

type GitResult<T extends string | Buffer = string> = { ok: boolean; code: string | number; stdout: T; stderr: string };
type GitOptions = { timeout?: number; cwd?: string };
type PrShas = { headSha: string; baseSha: string; baseRef?: string; headRef?: string };
type FileBlob = { sha: string | null; path: string; text: string; size: number; binary: boolean; tooLarge?: boolean; external?: boolean };
type Deps = { REPO: string; config?: { repo?: { github?: string; defaultBranch?: string } }; works: Pick<Works, 'get' | 'list'> };

const SHA_RE = /^[0-9a-f]{7,40}$/;
const MAX_TEXT = 5 * 1024 * 1024;
const BLOB_LRU = 200;
const TREE_LRU = 4;
const INFO_TTL = 60000;
const FRESH_TTL = 10000;

class HttpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const STATUS: Record<string, string> = { A: 'added', M: 'modified', D: 'removed', T: 'modified', R: 'renamed', C: 'added' };
// `git diff -z --name-status` and `--numstat` outputs as files with their counts (a binary file counts 0)
export function parseDiffFiles(nameStatus: string, numstat: string): PrFile[] {
  const counts = new Map<string, { additions: number; deletions: number }>();
  const nt = numstat.split('\0');
  for (let i = 0; i < nt.length; i++) {
    const m = nt[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    let name = m[3];
    if (name === '') {
      name = nt[i + 2];
      i += 2;
    }
    counts.set(name, { additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) });
  }
  const files: PrFile[] = [];
  const st = nameStatus.split('\0');
  for (let i = 0; i < st.length; i++) {
    const code = st[i];
    if (!code) continue;
    const kind = code[0];
    if (kind === 'R' || kind === 'C') {
      const previous = st[i + 1];
      const filename = st[i + 2];
      i += 2;
      files.push({ filename, status: STATUS[kind], ...(kind === 'R' ? { previous } : {}), ...(counts.get(filename) || { additions: 0, deletions: 0 }) });
    } else {
      const filename = st[++i];
      files.push({ filename, status: STATUS[kind] || 'modified', ...(counts.get(filename) || { additions: 0, deletions: 0 }) });
    }
  }
  return files;
}

// a repo-relative file path: no absolute path, no `..`, `.` or empty segment
export function checkPath(p: unknown): string {
  if (!p || typeof p !== 'string') throw new HttpError(400, 'path required');
  if (p.startsWith('/') || p.endsWith('/') || p.includes('\0') || p.includes('\n') || p.split('/').some((s) => s === '..' || s === '' || s === '.')) throw new HttpError(400, 'invalid path');
  return p;
}

export function createCode({ REPO, config, works }: Deps) {
  const GITHUB = config?.repo?.github || '';
  const BRANCH = config?.repo?.defaultBranch || 'main';
  const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const headRefName = (n: RowKey) => `refs/cocopilot/head/${n}`;
  const baseRefName = (n: RowKey) => `refs/cocopilot/base/${n}`;

  const exec = (cmd: string, args: string[], { timeout = 0, cwd }: GitOptions = {}) =>
    new Promise<GitResult>((resolve) => {
      execFile(cmd, args, { cwd, env: ENV, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout ?? '', stderr: String(stderr || err?.message || '') });
      });
    });
  const execBuffer = (cmd: string, args: string[]) =>
    new Promise<GitResult<Buffer>>((resolve) => {
      execFile(cmd, args, { env: ENV, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
        resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout ?? Buffer.alloc(0), stderr: String(stderr || err?.message || '') });
      });
    });
  // git -C '' would run in the server's own cwd
  const git = (args: string[], opts?: GitOptions): Promise<GitResult> => (REPO ? exec('git', ['-C', REPO, ...args], opts) : Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'no repo configured (repo.path)' }));
  const gitBuffer = (args: string[]): Promise<GitResult<Buffer>> => (REPO ? execBuffer('git', ['-C', REPO, ...args]) : Promise.resolve({ ok: false, code: 1, stdout: Buffer.alloc(0), stderr: 'no repo configured (repo.path)' }));

  let chain: Promise<unknown> = Promise.resolve();
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const revParse = async (ref: string) => {
    const r = await git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
    return r.ok ? r.stdout.trim() : null;
  };
  const hasCommit = async (sha: string) => (await git(['cat-file', '-e', `${sha}^{commit}`])).ok;
  const setRef = async (ref: string, sha: string) => {
    const r = await git(['update-ref', ref, sha]);
    if (!r.ok) throw new HttpError(500, `update-ref ${ref}: ${r.stderr.trim()}`);
  };
  const fetchRef = async (refspec: string) => {
    const r = await git(['fetch', '--no-tags', '--quiet', '--no-write-fetch-head', 'origin', refspec], { timeout: 180000 });
    if (!r.ok) throw new HttpError(500, `git fetch ${refspec}: ${r.stderr.trim().slice(0, 300)}`);
  };

  const infoCache = new Map<number, { at: number; promise: Promise<PrShas> }>();
  const refreshingShas = new Set<number>();
  async function prShas(number: number, fresh = false): Promise<PrShas> {
    const hit = infoCache.get(number);
    if (hit && Date.now() - hit.at < (fresh ? FRESH_TTL : INFO_TTL)) return hit.promise;
    // past INFO_TTL a plain read keeps the old shas while gh is asked again
    if (hit && !fresh) {
      if (!refreshingShas.has(number)) {
        refreshingShas.add(number);
        const next = loadShas(number);
        next.then(() => infoCache.get(number) === hit && infoCache.set(number, { at: Date.now(), promise: next }), () => {}).finally(() => refreshingShas.delete(number));
      }
      return hit.promise;
    }
    const promise = loadShas(number);
    infoCache.set(number, { at: Date.now(), promise });
    promise.catch(() => infoCache.delete(number));
    return promise;
  }
  function loadShas(number: number): Promise<PrShas> {
    return (async (): Promise<PrShas> => {
      if (!GITHUB) throw new HttpError(503, 'no GitHub repo configured (repo.github)');
      const r = await exec('gh', ['pr', 'view', String(number), '--repo', GITHUB, '--json', 'headRefOid,headRefName,baseRefOid,baseRefName']);
      let d: { headRefOid?: string; headRefName?: string; baseRefOid: string; baseRefName: string } | null = null;
      try {
        d = JSON.parse(r.stdout);
      } catch {}
      if (!d?.headRefOid) throw new HttpError(/Could not resolve|not found/i.test(r.stderr) ? 404 : 500, `gh pr view ${number}: ${r.stderr.trim().slice(0, 200) || 'no data'}`);
      return { headSha: d.headRefOid, baseSha: d.baseRefOid, baseRef: d.baseRefName, headRef: d.headRefName };
    })();
  }

  const mergeBases = new Map<string, string>();
  async function mergeBaseOf(baseSha: string, headSha: string): Promise<string> {
    const key = `${headSha}:${baseSha}`;
    const known = mergeBases.get(key);
    if (known !== undefined) return known;
    const r = await git(['merge-base', baseSha, headSha]);
    if (!r.ok || !r.stdout.trim()) throw new HttpError(500, `merge-base ${baseSha.slice(0, 9)} ${headSha.slice(0, 9)}: ${r.stderr.trim().slice(0, 200) || 'none'}`);
    const mb = r.stdout.trim();
    mergeBases.set(key, mb);
    if (mergeBases.size > 200) mergeBases.delete(mergeBases.keys().next().value ?? '');
    return mb;
  }

  // a local row diffs its branch against the previous row's branch (first row: origin/<default branch>)
  async function localRefs(key: string): Promise<Refs> {
    const branch = branchOf(key);
    const headSha = await revParse(`refs/heads/${branch}`);
    if (!headSha) throw new HttpError(404, `branch ${branch} not found locally`);
    const found = findRow(works, key);
    if (!found) throw new HttpError(404, `no work has a row on ${branch}`);
    const parentKey = rowKey(found.parent);
    const baseSha = !found.parent ? (await revParse(`origin/${BRANCH}`)) || (await revParse(BRANCH)) : isLocal(parentKey) ? await revParse(`refs/heads/${branchOf(parentKey)}`) : (await ensureRefs(parentKey ?? '')).headSha;
    if (!baseSha) throw new HttpError(404, `no base for ${branch}`);
    return { number: key, branch, headSha, baseSha, mergeBase: await mergeBaseOf(baseSha, headSha) };
  }

  // commits made in the PR's worktree and not pushed yet
  async function localAhead(branch: string, remote: string) {
    if (!/^[\w][\w./-]*$/.test(branch)) return null;
    const tip = await revParse(`refs/heads/${branch}`);
    return tip && tip !== remote && (await git(['merge-base', '--is-ancestor', remote, tip])).ok ? tip : null;
  }

  async function ensureRefs(key: RowKey, opts: RefsOptions = {}): Promise<Refs> {
    if (!REPO) throw new HttpError(503, 'no repo configured (repo.path)');
    if (isLocal(key)) return localRefs(key);
    const number = Number(key);
    if (!Number.isInteger(number) || number <= 0) throw new HttpError(400, 'bad pr number');
    let { headSha, baseSha, baseRef, headRef } = opts;
    if (headSha && baseSha && SHA_RE.test(headSha) && SHA_RE.test(baseSha)) infoCache.set(number, { at: Date.now(), promise: Promise.resolve({ headSha, baseSha, baseRef, headRef }) });
    const needGh = !SHA_RE.test(headSha || '') || !SHA_RE.test(baseSha || '') || (!baseRef && !(await hasCommit(baseSha ?? '')));
    if (needGh) {
      const info = await prShas(number, Boolean(opts.fresh));
      headSha = SHA_RE.test(headSha || '') ? headSha : info.headSha;
      baseSha = SHA_RE.test(baseSha || '') ? baseSha : info.baseSha;
      baseRef = baseRef || info.baseRef;
      headRef = headRef || info.headRef;
    }
    return withLock(async () => {
      let head = headSha ?? '';
      let base: string | null = baseSha ?? '';
      if (headRef && (await hasCommit(head))) head = (await localAhead(headRef, head)) || head;
      if ((await revParse(headRefName(number))) !== head) {
        if (await hasCommit(head)) await setRef(headRefName(number), head);
        else {
          await fetchRef(`+pull/${number}/head:${headRefName(number)}`);
          const got = await revParse(headRefName(number));
          if (!got) throw new HttpError(500, `head ref missing after fetch for #${number}`);
          head = got;
        }
      }
      if (await hasCommit(base)) {
        if ((await revParse(baseRefName(number))) !== base) await setRef(baseRefName(number), base);
      } else {
        if (!baseRef || !/^[\w][\w./-]*$/.test(baseRef)) throw new HttpError(500, `no usable base ref for #${number}`);
        await fetchRef(`+${baseRef.startsWith('refs/') ? baseRef : `refs/heads/${baseRef}`}:${baseRefName(number)}`);
        base = (await hasCommit(base)) ? base : await revParse(baseRefName(number));
        if (!base) throw new HttpError(500, `base ref missing after fetch for #${number}`);
      }
      return { number, headSha: head, baseSha: base, mergeBase: await mergeBaseOf(base, head) };
    });
  }

  async function dropRefs(key: RowKey) {
    const number = Number(key);
    if (!Number.isInteger(number) || number <= 0) return { ok: false };
    const out = await Promise.all([headRefName(number), baseRefName(number)].map((ref) => git(['update-ref', '-d', ref])));
    infoCache.delete(number);
    filesCache.clear();
    return { ok: out.every((r) => r.ok) };
  }

  const filesCache = new Map<string, PrFile[]>();
  async function filesBetween(mergeBase: string, headSha: string): Promise<PrFile[]> {
    const key = `${mergeBase}:${headSha}`;
    const cached = filesCache.get(key);
    if (cached) return cached;
    const [ns, nu] = await Promise.all([git(['diff', '-M', '--no-ext-diff', '--name-status', '-z', mergeBase, headSha]), git(['diff', '-M', '--no-ext-diff', '--numstat', '-z', mergeBase, headSha])]);
    if (!ns.ok || !nu.ok) throw new HttpError(500, `git diff: ${(ns.stderr || nu.stderr).trim().slice(0, 200)}`);
    const files = parseDiffFiles(ns.stdout, nu.stdout);
    filesCache.set(key, files);
    if (filesCache.size > 50) filesCache.delete(filesCache.keys().next().value ?? '');
    return files;
  }
  async function prFilesFromGit(number: RowKey, opts?: RefsOptions) {
    const refs = await ensureRefs(number, opts);
    return filesBetween(refs.mergeBase, refs.headSha);
  }

  const lru = <V>(map: Map<string, V>, key: string, value: V, max: number) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > max) map.delete(map.keys().next().value ?? '');
  };
  const touch = <V>(map: Map<string, V>, key: string): V | undefined => {
    const v = map.get(key);
    if (v === undefined) return undefined;
    map.delete(key);
    map.set(key, v);
    return v;
  };

  const trees = new Map<string, string[]>();
  async function treeOf(sha: string) {
    const hit = touch(trees, sha);
    if (hit) return hit;
    const r = await git(['ls-tree', '-r', '--name-only', '-z', sha]);
    if (!r.ok) throw new HttpError(404, `tree ${sha.slice(0, 9)}: ${r.stderr.trim().slice(0, 200)}`);
    const files = r.stdout.split('\0').filter(Boolean);
    lru(trees, sha, files, TREE_LRU);
    return files;
  }

  const blobs = new Map<string, FileBlob>();
  async function readFile(sha: string, p: string): Promise<FileBlob> {
    const key = `${sha}:${p}`;
    const hit = touch(blobs, key);
    if (hit) return hit;
    const ls = await git(['ls-tree', '-l', '-z', sha, '--', p]);
    if (!ls.ok) throw new HttpError(404, `not found: ${p}`);
    const m = ls.stdout.split('\0')[0].match(/^(\d+) (\w+) [0-9a-f]+\s+([\d-]+)\t(.*)$/s);
    if (!m || m[2] !== 'blob' || m[4] !== p) throw new HttpError(404, `not in tree: ${p}`);
    const size = Number(m[3]);
    let value: FileBlob;
    if (size > MAX_TEXT) value = { sha, path: p, text: '', size, binary: false, tooLarge: true };
    else {
      const r = await gitBuffer(['show', `${sha}:${p}`]);
      if (!r.ok) throw new HttpError(404, `not found: ${p}`);
      const buf = r.stdout;
      const binary = buf.subarray(0, 8192).includes(0);
      value = { sha, path: p, text: binary ? '' : buf.toString('utf8'), size: buf.length, binary };
    }
    lru(blobs, key, value, BLOB_LRU);
    return value;
  }

  const moduleRel = (p: string) => {
    const rel = `/${p}`.startsWith(`${REPO}/`) ? `/${p}`.slice(REPO.length + 1) : p;
    return rel.split('/').includes('node_modules') && /\.([cm]?[jt]sx?|json)$/.test(rel) ? rel : null;
  };
  async function readModule(p: string): Promise<FileBlob> {
    const rel = moduleRel(p);
    const st = rel ? await fs.stat(path.join(REPO, rel)).catch(() => null) : null;
    if (!rel || !st?.isFile()) throw new HttpError(404, `not found: ${p}`);
    if (st.size > MAX_TEXT) return { sha: null, path: rel, text: '', size: st.size, binary: false, tooLarge: true, external: true };
    return { sha: null, path: rel, text: await fs.readFile(path.join(REPO, rel), 'utf8'), size: st.size, binary: false, external: true };
  }

  async function diffOf(refs: Pick<Refs, 'mergeBase' | 'headSha'>, p: string, previous: string | null) {
    const spec = [`:(literal)${p}`, ...(previous ? [`:(literal)${previous}`] : [])];
    const r = await git(['diff', '-M', '--no-ext-diff', '--no-color', refs.mergeBase, refs.headSha, '--', ...spec]);
    if (!r.ok) throw new HttpError(500, `git diff: ${r.stderr.trim().slice(0, 200)}`);
    return r.stdout;
  }

  function grep(sha: string, q: string, max: number) {
    return new Promise<{ hits: { path: string; line: number; text: string }[]; truncated: boolean }>((resolve, reject) => {
      const child = spawn('git', ['-C', REPO, 'grep', '-n', '-I', '-F', '--max-depth', '-1', '-e', q, sha, '--', ':!*.lock', ':!*.min.js'], { env: ENV });
      const hits: { path: string; line: number; text: string }[] = [];
      let truncated = false;
      let buf = '';
      let err = '';
      const prefix = `${sha}:`;
      const take = (line: string) => {
        if (!line.startsWith(prefix) || truncated) return;
        const m = line.slice(prefix.length).match(/^(.+?):(\d+):(.*)$/s);
        if (!m) return;
        if (hits.length >= max) {
          truncated = true;
          child.kill();
          return;
        }
        hits.push({ path: m[1], line: Number(m[2]), text: m[3].slice(0, 300) });
      };
      child.stdout.on('data', (c) => {
        buf += c.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          take(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stderr.on('data', (c) => (err += c));
      child.on('error', reject);
      child.on('close', (code) => {
        if (buf) take(buf);
        if (!truncated && (code ?? 0) > 1) return reject(new HttpError(500, `git grep: ${err.trim().slice(0, 200)}`));
        resolve({ hits, truncated });
      });
    });
  }

  async function resolveRef(refs: Refs, ref: string | null) {
    if (!ref || ref === 'head') return refs.headSha;
    if (ref === 'base') return refs.mergeBase;
    if (SHA_RE.test(ref)) {
      const r = await git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
      if (!r.ok) throw new HttpError(404, `unknown sha ${ref}`);
      return r.stdout.trim();
    }
    throw new HttpError(400, 'ref must be head, base or a sha');
  }

  // one commit against its parent: an agent's suggested commit, reviewed before it lands on the PR branch
  async function commitRoute(rawSha: string, action: string, q: URLSearchParams) {
    if (!SHA_RE.test(rawSha)) throw new HttpError(400, 'bad sha');
    const headSha = await revParse(rawSha);
    if (!headSha) throw new HttpError(404, `unknown commit ${rawSha}`);
    const mergeBase = await revParse(`${headSha}^`);
    if (!mergeBase) throw new HttpError(400, `${rawSha.slice(0, 9)} has no parent`);
    if (action === 'refs') return { headSha, mergeBase, subject: (await git(['log', '-1', '--format=%s', headSha])).stdout.trim(), files: await filesBetween(mergeBase, headSha) };
    const p = checkPath(q.get('path'));
    if (action === 'file') return readFile(q.get('ref') === 'base' ? mergeBase : headSha, p);
    if (action === 'diff') return { path: p, mergeBase, headSha, unified: await diffOf({ mergeBase, headSha }, p, q.get('previous') ? checkPath(q.get('previous')) : null) };
    throw new HttpError(404, 'no route');
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      const [root, kind, n, action] = parts;
      if (root === 'code' && kind === 'commit' && req.method === 'GET') return send(res, 200, await commitRoute(n, action, new URL(req.url || '/', 'http://x').searchParams));
      const number = parseKey(n);
      if (root !== 'code' || kind !== 'pr' || req.method !== 'GET' || !number || !['refs', 'tree', 'file', 'diff', 'search'].includes(action)) return send(res, 404, { error: 'no route' });
      const q = new URL(req.url || '/', 'http://x').searchParams;
      const refs = await ensureRefs(number, { fresh: action === 'refs' && q.get('fresh') === '1' });
      if (action === 'refs') return send(res, 200, { ...refs, files: await filesBetween(refs.mergeBase, refs.headSha) });
      if (action === 'tree') {
        const sha = await resolveRef(refs, q.get('ref') || 'head');
        return send(res, 200, { sha, files: await treeOf(sha) });
      }
      if (action === 'file') {
        const rawRef = q.get('ref') || 'head';
        const sha = await resolveRef(refs, rawRef);
        const p = checkPath(q.get('path'));
        const value = await readFile(sha, p).catch((e) => (moduleRel(p) ? readModule(p) : Promise.reject(e)));
        if (!SHA_RE.test(rawRef)) return send(res, 200, value);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=3600' });
        return res.end(JSON.stringify(value));
      }
      if (action === 'diff') {
        const p = checkPath(q.get('path'));
        const previous = q.get('previous') ? checkPath(q.get('previous')) : null;
        return send(res, 200, { path: p, mergeBase: refs.mergeBase, headSha: refs.headSha, unified: await diffOf(refs, p, previous) });
      }
      const term = q.get('q') || '';
      if (term.length < 2 || term.length > 200 || /[\0\n]/.test(term)) return send(res, 400, { error: 'q must be 2 to 200 characters' });
      const max = Math.min(Math.max(Number(q.get('max')) || 200, 1), 1000);
      const sha = await resolveRef(refs, q.get('ref') || 'head');
      return send(res, 200, { q: term, ...(await grep(sha, term, max)) });
    } catch (e) {
      return send(res, e instanceof HttpError ? e.code : 500, { error: errorMessage(e) });
    }
  }

  return { handle, ensureRefs, prFilesFromGit, dropRefs, commitRoute };
}
