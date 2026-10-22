// Code source: serves PR content from the local git clone of the repo (never the working tree).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { branchOf, findRow, isLocal, parseKey, rowKey } from './stack.mjs';

const SHA_RE = /^[0-9a-f]{7,40}$/;
const MAX_TEXT = 5 * 1024 * 1024;
const BLOB_LRU = 200;
const TREE_LRU = 4;
const INFO_TTL = 60000;
const FRESH_TTL = 10000;

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createCode({ REPO, config, works }) {
  const GITHUB = config?.repo?.github || '';
  const BRANCH = config?.repo?.defaultBranch || 'main';
  const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const headRefName = (n) => `refs/cocopilot/head/${n}`;
  const baseRefName = (n) => `refs/cocopilot/base/${n}`;

  const exec = (cmd, args, { buffer = false, timeout = 0, cwd } = {}) =>
    new Promise((resolve) => {
      execFile(cmd, args, { cwd, env: ENV, timeout, maxBuffer: 64 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
        resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout ?? (buffer ? Buffer.alloc(0) : ''), stderr: String(stderr || err?.message || '') });
      });
    });
  // git -C '' would run in the server's own cwd
  const git = (args, opts) => (REPO ? exec('git', ['-C', REPO, ...args], opts) : Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'no repo configured (repo.path)' }));

  let chain = Promise.resolve();
  const withLock = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const revParse = async (ref) => {
    const r = await git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
    return r.ok ? r.stdout.trim() : null;
  };
  const hasCommit = async (sha) => (await git(['cat-file', '-e', `${sha}^{commit}`])).ok;
  const setRef = async (ref, sha) => {
    const r = await git(['update-ref', ref, sha]);
    if (!r.ok) throw new HttpError(500, `update-ref ${ref}: ${r.stderr.trim()}`);
  };
  const fetchRef = async (refspec) => {
    const r = await git(['fetch', '--no-tags', '--quiet', '--no-write-fetch-head', 'origin', refspec], { timeout: 180000 });
    if (!r.ok) throw new HttpError(500, `git fetch ${refspec}: ${r.stderr.trim().slice(0, 300)}`);
  };

  const infoCache = new Map();
  async function prShas(number, fresh = false) {
    const hit = infoCache.get(number);
    if (hit && Date.now() - hit.at < (fresh ? FRESH_TTL : INFO_TTL)) return hit.promise;
    const promise = (async () => {
      if (!GITHUB) throw new HttpError(503, 'no GitHub repo configured (repo.github)');
      const r = await exec('gh', ['pr', 'view', String(number), '--repo', GITHUB, '--json', 'headRefOid,baseRefOid,baseRefName']);
      let d = null;
      try {
        d = JSON.parse(r.stdout);
      } catch {}
      if (!d?.headRefOid) throw new HttpError(/Could not resolve|not found/i.test(r.stderr) ? 404 : 500, `gh pr view ${number}: ${r.stderr.trim().slice(0, 200) || 'no data'}`);
      return { headSha: d.headRefOid, baseSha: d.baseRefOid, baseRef: d.baseRefName };
    })();
    infoCache.set(number, { at: Date.now(), promise });
    promise.catch(() => infoCache.delete(number));
    return promise;
  }

  const mergeBases = new Map();
  async function mergeBaseOf(baseSha, headSha) {
    const key = `${headSha}:${baseSha}`;
    if (mergeBases.has(key)) return mergeBases.get(key);
    const r = await git(['merge-base', baseSha, headSha]);
    if (!r.ok || !r.stdout.trim()) throw new HttpError(500, `merge-base ${baseSha.slice(0, 9)} ${headSha.slice(0, 9)}: ${r.stderr.trim().slice(0, 200) || 'none'}`);
    const mb = r.stdout.trim();
    mergeBases.set(key, mb);
    if (mergeBases.size > 200) mergeBases.delete(mergeBases.keys().next().value);
    return mb;
  }

  // a local row diffs its branch against the previous row's branch (first row: origin/<default branch>)
  async function localRefs(key) {
    const branch = branchOf(key);
    const headSha = await revParse(`refs/heads/${branch}`);
    if (!headSha) throw new HttpError(404, `branch ${branch} not found locally`);
    const found = findRow(works, key);
    if (!found) throw new HttpError(404, `no work has a row on ${branch}`);
    const parentKey = rowKey(found.parent);
    const baseSha = !found.parent ? (await revParse(`origin/${BRANCH}`)) || (await revParse(BRANCH)) : isLocal(parentKey) ? await revParse(`refs/heads/${branchOf(parentKey)}`) : (await ensureRefs(parentKey)).headSha;
    if (!baseSha) throw new HttpError(404, `no base for ${branch}`);
    return { number: key, branch, headSha, baseSha, mergeBase: await mergeBaseOf(baseSha, headSha) };
  }

  async function ensureRefs(number, opts = {}) {
    if (!REPO) throw new HttpError(503, 'no repo configured (repo.path)');
    if (isLocal(number)) return localRefs(number);
    number = Number(number);
    if (!Number.isInteger(number) || number <= 0) throw new HttpError(400, 'bad pr number');
    let { headSha, baseSha, baseRef } = opts;
    if (SHA_RE.test(headSha || '') && SHA_RE.test(baseSha || '')) infoCache.set(number, { at: Date.now(), promise: Promise.resolve({ headSha, baseSha, baseRef }) });
    const needGh = !SHA_RE.test(headSha || '') || !SHA_RE.test(baseSha || '') || (!baseRef && !(await hasCommit(baseSha)));
    if (needGh) {
      const info = await prShas(number, Boolean(opts.fresh));
      headSha = SHA_RE.test(headSha || '') ? headSha : info.headSha;
      baseSha = SHA_RE.test(baseSha || '') ? baseSha : info.baseSha;
      baseRef = baseRef || info.baseRef;
    }
    return withLock(async () => {
      if ((await revParse(headRefName(number))) !== headSha) {
        if (await hasCommit(headSha)) await setRef(headRefName(number), headSha);
        else {
          await fetchRef(`+pull/${number}/head:${headRefName(number)}`);
          const got = await revParse(headRefName(number));
          if (!got) throw new HttpError(500, `head ref missing after fetch for #${number}`);
          headSha = got;
        }
      }
      if (await hasCommit(baseSha)) {
        if ((await revParse(baseRefName(number))) !== baseSha) await setRef(baseRefName(number), baseSha);
      } else {
        if (!baseRef || !/^[\w][\w./-]*$/.test(baseRef)) throw new HttpError(500, `no usable base ref for #${number}`);
        await fetchRef(`+${baseRef.startsWith('refs/') ? baseRef : `refs/heads/${baseRef}`}:${baseRefName(number)}`);
        baseSha = (await hasCommit(baseSha)) ? baseSha : await revParse(baseRefName(number));
        if (!baseSha) throw new HttpError(500, `base ref missing after fetch for #${number}`);
      }
      return { number, headSha, baseSha, mergeBase: await mergeBaseOf(baseSha, headSha) };
    });
  }

  async function dropRefs(number) {
    number = Number(number);
    if (!Number.isInteger(number) || number <= 0) return { ok: false };
    const out = await Promise.all([headRefName(number), baseRefName(number)].map((ref) => git(['update-ref', '-d', ref])));
    infoCache.delete(number);
    filesCache.clear();
    return { ok: out.every((r) => r.ok) };
  }

  const STATUS = { A: 'added', M: 'modified', D: 'removed', T: 'modified', R: 'renamed', C: 'added' };
  const filesCache = new Map();
  async function filesBetween(mergeBase, headSha) {
    const key = `${mergeBase}:${headSha}`;
    if (filesCache.has(key)) return filesCache.get(key);
    const [ns, nu] = await Promise.all([git(['diff', '-M', '--no-ext-diff', '--name-status', '-z', mergeBase, headSha]), git(['diff', '-M', '--no-ext-diff', '--numstat', '-z', mergeBase, headSha])]);
    if (!ns.ok || !nu.ok) throw new HttpError(500, `git diff: ${(ns.stderr || nu.stderr).trim().slice(0, 200)}`);
    const counts = new Map();
    const nt = nu.stdout.split('\0');
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
    const files = [];
    const st = ns.stdout.split('\0');
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
    filesCache.set(key, files);
    if (filesCache.size > 50) filesCache.delete(filesCache.keys().next().value);
    return files;
  }
  async function prFilesFromGit(number, opts) {
    const refs = await ensureRefs(number, opts);
    return filesBetween(refs.mergeBase, refs.headSha);
  }

  const lru = (map, key, value, max) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > max) map.delete(map.keys().next().value);
  };
  const touch = (map, key) => {
    if (!map.has(key)) return undefined;
    const v = map.get(key);
    map.delete(key);
    map.set(key, v);
    return v;
  };

  const trees = new Map();
  async function treeOf(sha) {
    const hit = touch(trees, sha);
    if (hit) return hit;
    const r = await git(['ls-tree', '-r', '--name-only', '-z', sha]);
    if (!r.ok) throw new HttpError(404, `tree ${sha.slice(0, 9)}: ${r.stderr.trim().slice(0, 200)}`);
    const files = r.stdout.split('\0').filter(Boolean);
    lru(trees, sha, files, TREE_LRU);
    return files;
  }

  const checkPath = (p) => {
    if (!p || typeof p !== 'string') throw new HttpError(400, 'path required');
    if (p.startsWith('/') || p.endsWith('/') || p.includes('\0') || p.includes('\n') || p.split('/').some((s) => s === '..' || s === '' || s === '.')) throw new HttpError(400, 'invalid path');
    return p;
  };

  const blobs = new Map();
  async function readFile(sha, p) {
    const key = `${sha}:${p}`;
    const hit = touch(blobs, key);
    if (hit) return hit;
    const ls = await git(['ls-tree', '-l', '-z', sha, '--', p]);
    if (!ls.ok) throw new HttpError(404, `not found: ${p}`);
    const m = ls.stdout.split('\0')[0].match(/^(\d+) (\w+) [0-9a-f]+\s+([\d-]+)\t(.*)$/s);
    if (!m || m[2] !== 'blob' || m[4] !== p) throw new HttpError(404, `not in tree: ${p}`);
    const size = Number(m[3]);
    let value;
    if (size > MAX_TEXT) value = { sha, path: p, text: '', size, binary: false, tooLarge: true };
    else {
      const r = await git(['show', `${sha}:${p}`], { buffer: true });
      if (!r.ok) throw new HttpError(404, `not found: ${p}`);
      const buf = r.stdout;
      const binary = buf.subarray(0, 8192).includes(0);
      value = { sha, path: p, text: binary ? '' : buf.toString('utf8'), size: buf.length, binary };
    }
    lru(blobs, key, value, BLOB_LRU);
    return value;
  }

  const moduleRel = (p) => {
    const rel = `/${p}`.startsWith(`${REPO}/`) ? `/${p}`.slice(REPO.length + 1) : p;
    return rel.split('/').includes('node_modules') && /\.([cm]?[jt]sx?|json)$/.test(rel) ? rel : null;
  };
  async function readModule(p) {
    const rel = moduleRel(p);
    const st = rel && (await fs.stat(path.join(REPO, rel)).catch(() => null));
    if (!st?.isFile()) throw new HttpError(404, `not found: ${p}`);
    if (st.size > MAX_TEXT) return { sha: null, path: rel, text: '', size: st.size, binary: false, tooLarge: true, external: true };
    return { sha: null, path: rel, text: await fs.readFile(path.join(REPO, rel), 'utf8'), size: st.size, binary: false, external: true };
  }

  async function diffOf(refs, p, previous) {
    const spec = [`:(literal)${p}`, ...(previous ? [`:(literal)${previous}`] : [])];
    const r = await git(['diff', '-M', '--no-ext-diff', '--no-color', refs.mergeBase, refs.headSha, '--', ...spec]);
    if (!r.ok) throw new HttpError(500, `git diff: ${r.stderr.trim().slice(0, 200)}`);
    return r.stdout;
  }

  function grep(sha, q, max) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['-C', REPO, 'grep', '-n', '-I', '-F', '--max-depth', '-1', '-e', q, sha, '--', ':!*.lock', ':!*.min.js'], { env: ENV });
      const hits = [];
      let truncated = false;
      let buf = '';
      let err = '';
      const prefix = `${sha}:`;
      const take = (line) => {
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
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          take(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stderr.on('data', (c) => (err += c));
      child.on('error', reject);
      child.on('close', (code) => {
        if (buf) take(buf);
        if (!truncated && code > 1) return reject(new HttpError(500, `git grep: ${err.trim().slice(0, 200)}`));
        resolve({ hits, truncated });
      });
    });
  }

  async function resolveRef(refs, ref) {
    if (!ref || ref === 'head') return refs.headSha;
    if (ref === 'base') return refs.mergeBase;
    if (SHA_RE.test(ref)) {
      const r = await git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
      if (!r.ok) throw new HttpError(404, `unknown sha ${ref}`);
      return r.stdout.trim();
    }
    throw new HttpError(400, 'ref must be head, base or a sha');
  }

  async function handle(req, res, parts, readBody, send) {
    try {
      const [root, kind, n, action] = parts;
      const number = parseKey(n);
      if (root !== 'code' || kind !== 'pr' || req.method !== 'GET' || !number || !['refs', 'tree', 'file', 'diff', 'search'].includes(action)) return send(res, 404, { error: 'no route' });
      const q = new URL(req.url, 'http://x').searchParams;
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
      return send(res, e instanceof HttpError ? e.code : 500, { error: e.message });
    }
  }

  return { handle, ensureRefs, prFilesFromGit, dropRefs };
}
