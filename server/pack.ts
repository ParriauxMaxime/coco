// Team pack: personas, skills, team config and the feature-flag provider zipped for teammates, then previewed and merged on import.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { isObject, merge, personaLogins } from './config.ts';

export const PERSONAL_KEYS = ['owner', 'dataDir', 'briefsDir', 'skillsDir', 'personasDir', 'baseUrl', 'importRoots', 'repo.path', 'file'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data']);
const MAX_BYTES = 200 * 1024 * 1024;
const ID = /^[a-f0-9]{12}$/;
const NAME = /^(?!\.\.?$)[\w.@-]+$/;

const fail = (status, message) => Object.assign(new Error(message), { status });
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, ...opts }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout))));
  });
const readJson = (file) => (file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const getPath = (o, key) => key.split('.').reduce((v, k) => (isObject(v) ? v[k] : undefined), o);
const setPath = (o, key, value) => {
  const keys = key.split('.');
  const last = keys.pop();
  let cur = o;
  for (const k of keys) cur = isObject(cur[k]) ? cur[k] : (cur[k] = {});
  cur[last] = value;
};
const delPath = (o, key) => {
  const keys = key.split('.');
  const last = keys.pop();
  const parent = keys.reduce((v, k) => (isObject(v) ? v[k] : undefined), o);
  if (isObject(parent)) delete parent[last];
};
const inside = (root, rel) => {
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw fail(400, `${rel} escapes ${root}`);
  return full;
};

// relative file paths under root, without symlinks, *.bak, build/vcs/data dirs, or dirs listed in skip (real paths)
export function walk(root, skip = []) {
  const out = [];
  const visit = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink() || e.name === '.DS_Store') continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !skip.includes(real(full))) visit(full, r);
      } else if (e.isFile() && !e.name.endsWith('.bak')) out.push(r);
    }
  };
  if (fs.existsSync(root)) visit(root, '');
  return out.sort();
}

export function teamConfig(raw, { provider = null } = {}) {
  const out = clone(raw || {});
  for (const k of PERSONAL_KEYS) delPath(out, k);
  if (isObject(out.featureFlags)) {
    if (provider) out.featureFlags.provider = `providers/${provider}`;
    else delete out.featureFlags.provider;
  }
  return out;
}

// team values fill in and override; the user's personal keys and, when the pack ships none, their provider always win
export function mergeConfig(user, team, { provider = null } = {}) {
  const out = merge(clone(user || {}), clone(team || {}));
  for (const k of PERSONAL_KEYS) {
    const v = getPath(user, k);
    if (v === undefined) delPath(out, k);
    else setPath(out, k, clone(v));
  }
  const own = getPath(user, 'featureFlags.provider');
  if (provider || own) setPath(out, 'featureFlags.provider', provider || own);
  else if (isObject(out.featureFlags)) delete out.featureFlags.provider;
  return out;
}

export function configDiff(user, merged) {
  const u = user || {};
  const keys = Object.keys(merged);
  return {
    added: keys.filter((k) => u[k] === undefined),
    changed: keys.filter((k) => u[k] !== undefined && JSON.stringify(u[k]) !== JSON.stringify(merged[k])),
    kept: PERSONAL_KEYS.filter((k) => getPath(u, k) !== undefined),
  };
}

// names from `unzip -Z1`, long lines from `unzip -Z`: absolute paths, `..` segments and symlinks are refused
export function zipProblems(names, longLines = []) {
  const bad = names.filter((n) => n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split(/[\\/]/).includes('..')).map((n) => `unsafe path ${n}`);
  const links = longLines.filter((l) => /^l[rwxsStT-]{9}/.test(l)).map((l) => `symlink ${l.trim().split(/\s+/).pop()}`);
  return [...bad, ...links];
}

const readBytes = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(fail(413, `larger than ${MAX_BYTES / 1024 / 1024} MB`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

export function createPack({ APP, DATA, config }) {
  const SKILLS = config.skillsDir;
  const PERSONAS = config.personasDir;
  const PROVIDER = config.featureFlags?.provider || null;
  const STAGING = path.join(DATA, 'pack-staging');
  const BACKUPS = path.join(DATA, 'pack-backups');
  const configTarget = () => config.file || process.env.COCO_CONFIG || path.join(APP, 'coco.config.json');

  function personaGroups() {
    if (!PERSONAS || !fs.existsSync(PERSONAS)) return [];
    const files = fs
      .readdirSync(PERSONAS, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.endsWith('.bak'))
      .map((e) => e.name)
      .sort();
    const logins = personaLogins(files, config.personaFiles).sort((a, b) => b.length - a.length);
    const groups = new Map();
    for (const f of files) {
      const login = logins.find((l) => f.startsWith(`${l}.`) || f.startsWith(`${l}-`)) ?? null;
      if (!groups.has(login)) groups.set(login, []);
      groups.get(login).push(f);
    }
    const named = [...groups.keys()].filter((l) => l !== null).sort((a, b) => a.localeCompare(b));
    return [...named, ...(groups.has(null) ? [null] : [])].map((login) => ({ login, files: groups.get(login) }));
  }

  function offeredSkills() {
    if (!SKILLS || !fs.existsSync(SKILLS)) return [];
    const named = new Set([config.methodSkill, ...Object.values(config.skillOverrides || {})]);
    if (config.skillPrefix) for (const d of fs.readdirSync(SKILLS)) if (d.startsWith(config.skillPrefix)) named.add(d);
    for (const list of Object.values(config.gateSkills || {})) for (const s of list || []) named.add(typeof s === 'string' ? s : s?.name);
    for (const r of config.rituals || []) for (const m of String(r.prompt || '').matchAll(/(?:^|\s)\/([\w:-]+)/g)) named.add(m[1]);
    const skip = [real(APP), ...(PERSONAS ? [real(PERSONAS)] : [])];
    return [...named]
      .filter((n) => n && NAME.test(n) && fs.existsSync(path.join(SKILLS, n, 'SKILL.md')))
      .sort()
      .map((name) => {
        const files = walk(path.join(SKILLS, name), skip);
        return { name, files, bytes: files.reduce((sum, f) => sum + fs.statSync(path.join(SKILLS, name, f)).size, 0) };
      });
  }

  function contents() {
    return {
      personas: personaGroups(),
      skills: offeredSkills(),
      config: Boolean(config.file && fs.existsSync(config.file)),
      provider: PROVIDER && fs.existsSync(PROVIDER) ? path.basename(PROVIDER) : null,
    };
  }

  async function exportZip({ personas = [], skills = [], config: withConfig = false, provider: withProvider = false } = {}) {
    const c = contents();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-pack-'));
    const root = path.join(tmp, 'pack');
    const put = (rel, src) => {
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    };
    try {
      fs.mkdirSync(root);
      const personaFiles = c.personas.filter((g) => personas.includes(g.login)).flatMap((g) => g.files);
      for (const f of personaFiles) put(`personas/${f}`, path.join(PERSONAS, f));
      const skillList = c.skills.filter((s) => skills.includes(s.name));
      for (const s of skillList) for (const f of s.files) put(`skills/${s.name}/${f}`, path.join(SKILLS, s.name, f));
      const providerName = withProvider && c.provider ? c.provider : null;
      if (providerName) put(`providers/${providerName}`, PROVIDER);
      const withCfg = Boolean(withConfig && c.config);
      if (withCfg) fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(teamConfig(readJson(config.file), { provider: providerName }), null, 2) + '\n');
      const manifest = { format: 1, createdAt: new Date().toISOString(), by: config.owner?.login || null, contents: { personas: personaFiles, skills: skillList.map((s) => s.name), provider: providerName, config: withCfg } };
      fs.writeFileSync(path.join(root, 'coco-pack.json'), JSON.stringify(manifest, null, 2) + '\n');
      const out = path.join(tmp, 'pack.zip');
      await run('zip', ['-q', '-r', '-X', out, '.'], { cwd: root });
      return fs.readFileSync(out);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  function plan(id) {
    if (!ID.test(id || '')) throw fail(400, 'bad pack id');
    const dir = path.join(STAGING, id);
    if (!fs.existsSync(dir)) throw fail(404, 'no such staged pack');
    const manifest = readJson(path.join(dir, 'coco-pack.json'));
    const status = (src, dest) => (!fs.existsSync(dest) ? 'new' : fs.readFileSync(src).equals(fs.readFileSync(dest)) ? 'same' : 'changed');
    const files = [];
    const add = (kind, group, rel, src, destRoot) => {
      const dest = inside(destRoot, rel);
      files.push({ kind, group, rel, src, dest, backup: `${kind === 'skill' ? `skills/${group}` : `${kind}s`}/${rel}`, status: status(src, dest) });
    };
    const pDir = path.join(dir, 'personas');
    if (fs.existsSync(pDir)) for (const e of fs.readdirSync(pDir, { withFileTypes: true })) if (e.isFile() && NAME.test(e.name)) add('persona', null, e.name, path.join(pDir, e.name), PERSONAS);
    const sDir = path.join(dir, 'skills');
    if (fs.existsSync(sDir))
      for (const e of fs.readdirSync(sDir, { withFileTypes: true }))
        if (e.isDirectory() && NAME.test(e.name)) for (const f of walk(path.join(sDir, e.name))) add('skill', e.name, f, path.join(sDir, e.name, f), path.join(SKILLS, e.name));
    const providerName = manifest.contents?.provider;
    const providerSrc = providerName && NAME.test(providerName) ? path.join(dir, 'providers', providerName) : null;
    if (providerSrc && fs.existsSync(providerSrc)) add('provider', null, providerName, providerSrc, path.join(DATA, 'providers'));
    const provider = files.find((f) => f.kind === 'provider') || null;
    const team = readJson(path.join(dir, 'config.json'));
    let cfg = null;
    if (team) {
      const target = configTarget();
      const user = readJson(target) || {};
      const merged = mergeConfig(user, team, { provider: provider?.dest });
      cfg = { target, user, merged, diff: configDiff(user, merged) };
    }
    return { dir, manifest, files, provider, config: cfg };
  }

  function preview(id) {
    const p = plan(id);
    const skills = new Map();
    for (const f of p.files.filter((x) => x.kind === 'skill')) {
      if (!skills.has(f.group)) skills.set(f.group, []);
      skills.get(f.group).push({ file: f.rel, status: f.status });
    }
    return {
      id,
      by: p.manifest.by || null,
      createdAt: p.manifest.createdAt || null,
      personas: p.files.filter((f) => f.kind === 'persona').map((f) => ({ file: f.rel, status: f.status })),
      skills: [...skills].map(([name, files]) => ({ name, files })),
      provider: p.provider ? { file: p.provider.rel, status: p.provider.status } : null,
      config: p.config?.diff || null,
    };
  }

  async function stage(bytes) {
    const id = crypto.randomBytes(6).toString('hex');
    const dir = path.join(STAGING, id);
    const zip = path.join(STAGING, `${id}.zip`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(zip, bytes);
    try {
      let names, long;
      try {
        names = (await run('unzip', ['-Z1', zip])).split('\n').filter(Boolean);
        long = (await run('unzip', ['-Z', zip])).split('\n');
      } catch {
        throw fail(400, 'not a zip file');
      }
      const problems = zipProblems(names, long);
      if (problems.length) throw fail(400, `refused: ${problems.slice(0, 5).join(', ')}`);
      await run('unzip', ['-q', '-o', zip, '-d', dir]);
      const manifest = readJson(path.join(dir, 'coco-pack.json'));
      if (manifest?.format !== 1) throw fail(400, 'not a coco pack: coco-pack.json with format 1 is missing');
      return preview(id);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e.status ? e : fail(400, e.message);
    } finally {
      fs.rmSync(zip, { force: true });
    }
  }

  function apply(id) {
    const p = plan(id);
    const backupDir = path.join(BACKUPS, new Date().toISOString().replace(/[:.]/g, '-'));
    let backedUp = 0;
    const backup = (src, rel) => {
      const dest = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      backedUp += 1;
    };
    const applied = { personas: 0, skills: 0, provider: 0, config: 0 };
    for (const f of p.files) {
      if (f.status === 'same') continue;
      if (f.status === 'changed') backup(f.dest, f.backup);
      fs.mkdirSync(path.dirname(f.dest), { recursive: true });
      fs.copyFileSync(f.src, f.dest);
      applied[f.kind === 'provider' ? 'provider' : `${f.kind}s`] += 1;
    }
    if (p.config && JSON.stringify(p.config.user) !== JSON.stringify(p.config.merged)) {
      const { target, merged } = p.config;
      if (fs.existsSync(target)) backup(target, `config/${path.basename(target)}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(merged, null, 2) + '\n');
      applied.config = 1;
    }
    fs.rmSync(p.dir, { recursive: true, force: true });
    return { applied, backup: backedUp ? backupDir : null, restart: true };
  }

  function discard(id) {
    if (!ID.test(id || '')) throw fail(400, 'bad pack id');
    fs.rmSync(path.join(STAGING, id), { recursive: true, force: true });
    return { ok: true };
  }

  // GET contents · POST export (JSON) → zip · POST import (raw zip) → preview · GET|DELETE import/<id> · POST import/<id>/apply
  async function handle(req, res, parts, readBody, send) {
    const [, a, id, action] = parts;
    try {
      if (a === 'contents' && req.method === 'GET') return send(res, 200, contents());
      if (a === 'export' && req.method === 'POST') {
        const zip = await exportZip(JSON.parse((await readBody(req)) || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="coco-pack-${new Date().toISOString().slice(0, 10)}.zip"`, 'Content-Length': zip.length, 'Cache-Control': 'no-store' });
        return res.end(zip);
      }
      if (a === 'import' && !id && req.method === 'POST') {
        const bytes = await readBytes(req);
        if (!bytes.length) return send(res, 400, { error: 'empty body' });
        return send(res, 200, await stage(bytes));
      }
      if (a === 'import' && id && action === 'apply' && req.method === 'POST') return send(res, 200, apply(id));
      if (a === 'import' && id && !action && req.method === 'GET') return send(res, 200, preview(id));
      if (a === 'import' && id && !action && req.method === 'DELETE') return send(res, 200, discard(id));
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, e.status || 500, { error: String(e.message || e) });
    }
  }

  return { handle, contents, exportZip, stage, preview, apply, discard };
}
