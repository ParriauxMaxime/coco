// TypeScript language service over a git sha. JSON lines on stdin/stdout. Run with --max-old-space-size.
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const SNAPSHOT_LRU = Number(process.env.LANG_SNAPSHOT_LRU) || 20000;
const GREP_CAP = 300;
const GREP_ROOTS_MAX = 1000;
const PREFETCH_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const PREFETCH_MAX_BYTES = 3 * 1024 * 1024;
const NM = `${path.sep}node_modules${path.sep}`;

let ts;
let S = null;

const reply = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

function readTree(repo, sha) {
  const out = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '-z', '-l', sha], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' });
  const files = new Map();
  const dirs = new Map([['', { files: [], directories: [] }]]);
  const parentOf = (p) => (path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p));
  const addDir = (d) => {
    let e = dirs.get(d);
    if (e) return e;
    dirs.set(d, (e = { files: [], directories: [] }));
    addDir(parentOf(d)).directories.push(path.posix.basename(d));
    return e;
  };
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [, type, oid, size] = entry.slice(0, tab).split(/\s+/);
    if (type !== 'blob') continue;
    const rel = entry.slice(tab + 1);
    files.set(rel, { oid, size: Number(size) || 0 });
    addDir(parentOf(rel)).files.push(path.posix.basename(rel));
  }
  return { files, dirs };
}

function prefetch(repo, files) {
  const wanted = [];
  for (const [rel, { oid, size }] of files) if (PREFETCH_RE.test(rel) && size <= PREFETCH_MAX_BYTES) wanted.push([rel, oid]);
  const blobs = new Map();
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = Buffer.alloc(0);
    let i = 0;
    child.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const header = buf.subarray(0, nl).toString();
        const size = Number(header.split(' ')[2]);
        if (header.endsWith(' missing') || Number.isNaN(size)) {
          buf = buf.subarray(nl + 1);
          i++;
          continue;
        }
        if (buf.length < nl + 1 + size + 1) return;
        blobs.set(wanted[i][0], Buffer.from(buf.subarray(nl + 1, nl + 1 + size)));
        buf = buf.subarray(nl + 2 + size);
        i++;
      }
    });
    child.on('error', reject);
    child.on('close', () => resolve(blobs));
    child.stdin.end(wanted.map(([, oid]) => oid).join('\n') + '\n');
  });
}

function createState({ repo, sha, tsconfig }) {
  const R = path.resolve(repo);
  const t0 = Date.now();
  const tree = readTree(R, sha);
  const toRel = (abs) => (abs.startsWith(R + path.sep) && !`${abs}${path.sep}`.includes(NM) ? abs.slice(R.length + 1) : null);
  const isExternal = (abs) => toRel(abs) === null;
  const st = { R, sha, tree, toRel, t0, blobs: new Map(), snapshots: new Map(), openFiles: new Set(), grepRoots: new Set(), dtsRoots: [], version: 0, misses: 0 };

  const readRel = (rel) => {
    const hit = st.blobs.get(rel);
    if (hit) return hit.toString('utf8');
    const f = tree.files.get(rel);
    if (!f) return undefined;
    st.misses++;
    return execFileSync('git', ['-C', R, 'cat-file', 'blob', f.oid], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  };
  const readFile = (abs) => {
    const rel = toRel(abs);
    if (rel === null) return ts.sys.readFile(abs);
    const text = readRel(rel);
    return text?.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  };
  const fileExists = (abs) => {
    const rel = toRel(abs);
    return rel === null ? ts.sys.fileExists(abs) : tree.files.has(rel);
  };
  const dirRel = (abs) => (abs === R ? '' : toRel(abs));
  const directoryExists = (abs) => {
    const rel = dirRel(abs);
    return rel === null ? ts.sys.directoryExists(abs) : tree.dirs.has(rel);
  };
  const getDirectories = (abs) => {
    const rel = dirRel(abs);
    return rel === null ? ts.sys.getDirectories(abs) : [...(tree.dirs.get(rel)?.directories || [])];
  };
  const getEntries = (abs) => {
    const rel = dirRel(abs);
    if (rel === null) {
      const files = [];
      const directories = [];
      for (const d of ts.sys.readDirectory(abs, undefined, undefined, undefined, 1)) files.push(path.basename(d));
      return { files, directories: ts.sys.getDirectories(abs) };
    }
    return tree.dirs.get(rel) || { files: [], directories: [] };
  };
  const readDirectory = (rootDir, extensions, excludes, includes, depth) =>
    ts.matchFiles(rootDir, extensions, excludes, includes, true, R, depth, getEntries, (p) => p);

  const configRel = tree.files.has(tsconfig) ? tsconfig : 'tsconfig.json';
  const configAbs = path.join(R, configRel);
  const parseHost = { useCaseSensitiveFileNames: true, readDirectory, fileExists, readFile };
  const raw = ts.readConfigFile(configAbs, readFile);
  if (raw.error) throw new Error(`tsconfig: ${ts.flattenDiagnosticMessageText(raw.error.messageText, '\n')}`);
  const parsed = ts.parseJsonConfigFileContent(raw.config, parseHost, path.dirname(configAbs), undefined, configAbs);
  const options = { ...parsed.options, skipLibCheck: true, noEmit: true, incremental: false, tsBuildInfoFile: undefined, disableSourceOfProjectReferenceRedirect: true };
  st.dtsRoots = parsed.fileNames.filter((f) => f.endsWith('.d.ts'));
  const pathsBase = options.pathsBasePath || path.dirname(configAbs);
  const targets = Object.values(options.paths || {}).flat().map((t) => path.resolve(pathsBase, t.split('*')[0]));
  const scopes = [...new Set([path.dirname(configAbs), ...targets].map((a) => (a === R ? '' : toRel(a.replace(/\/$/, '')))))];
  st.grepScopes = scopes.includes('') ? [''] : scopes.filter((x) => x !== null);
  const configDir = path.posix.dirname(configRel);
  st.nestedProjects = [...tree.files.keys()]
    .filter((f) => path.posix.basename(f) === 'tsconfig.json')
    .map((f) => path.posix.dirname(f))
    .filter((d) => d !== '.' && d !== configDir && !(configDir === '.' ? false : `${configDir}/`.startsWith(`${d}/`)));
  st.config = { path: configRel, errors: parsed.errors.length, fileNames: parsed.fileNames.length };

  const getSnapshot = (abs) => {
    const hit = st.snapshots.get(abs);
    if (hit) {
      st.snapshots.delete(abs);
      st.snapshots.set(abs, hit);
      return hit;
    }
    const text = readFile(abs);
    if (text === undefined) return undefined;
    const snap = ts.ScriptSnapshot.fromString(text);
    st.snapshots.set(abs, snap);
    if (st.snapshots.size > SNAPSHOT_LRU) st.snapshots.delete(st.snapshots.keys().next().value);
    return snap;
  };

  const host = {
    getCompilationSettings: () => options,
    getProjectVersion: () => String(st.version),
    getScriptFileNames: () => [...st.dtsRoots, ...st.openFiles, ...st.grepRoots],
    getScriptVersion: () => '1',
    getScriptSnapshot: getSnapshot,
    getCurrentDirectory: () => R,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists,
    readFile,
    readDirectory,
    directoryExists,
    getDirectories,
    realpath: (p) => (isExternal(p) && ts.sys.realpath ? ts.sys.realpath(p) : p),
    useCaseSensitiveFileNames: () => true,
  };
  st.options = options;
  st.host = host;
  st.service = ts.createLanguageService(host, ts.createDocumentRegistry(true, R));
  return st;
}

const lineStarts = (text) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 && text.charCodeAt(i + 1) === 10) continue;
    if (c === 10 || c === 13) starts.push(i + 1);
  }
  return starts;
};
const textOf = (abs) => S.host.getScriptSnapshot(abs)?.getText(0, S.host.getScriptSnapshot(abs).getLength());
const toLineCol = (starts, offset) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - starts[lo] + 1 };
};

function location(fileName, span, extra = {}) {
  const text = textOf(fileName) ?? '';
  const starts = lineStarts(text);
  const a = toLineCol(starts, span.start);
  const b = toLineCol(starts, span.start + span.length);
  const lineEnd = starts[a.line] ?? text.length;
  const preview = text.slice(starts[a.line - 1], lineEnd).replace(/\r?\n$/, '').trim().slice(0, 200);
  const rel = S.toRel(fileName);
  return { path: rel ?? fileName, line: a.line, col: a.col, endLine: b.line, endCol: b.col, preview, ...(rel === null ? { external: true } : {}), ...extra };
}

function openPath(rel) {
  if (typeof rel !== 'string' || !S.tree.files.has(rel)) throw new Error(`unknown path: ${rel}`);
  const abs = path.join(S.R, rel);
  if (!S.openFiles.has(abs)) {
    S.openFiles.add(abs);
    S.grepRoots.delete(abs);
    S.version++;
  }
  return abs;
}

function offsetAt(abs, line, col) {
  const text = textOf(abs);
  const starts = lineStarts(text);
  if (!(line >= 1 && line <= starts.length)) throw new Error(`line out of range: ${line}`);
  return Math.min(starts[line - 1] + Math.max(0, col - 1), text.length);
}

function wordAt(text, offset) {
  const re = /[A-Za-z0-9_$]/;
  let a = offset;
  let b = offset;
  while (a > 0 && re.test(text[a - 1])) a--;
  while (b < text.length && re.test(text[b])) b++;
  const w = text.slice(a, b);
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(w) ? w : null;
}

function grepCandidates(word) {
  let out = '';
  try {
    const specs = S.grepScopes.flatMap((d) => ['*.ts', '*.tsx', '*.js'].map((x) => (d ? `${d}/${x}` : x)));
    out = execFileSync('git', ['-C', S.R, 'grep', '-l', '-w', '-F', '-e', word, S.sha, '--', ...specs], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e;
  }
  const prefix = `${S.sha}:`;
  const rels = out
    .split('\n')
    .filter(Boolean)
    .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l))
    .filter((r) => !S.nestedProjects.some((d) => r.startsWith(`${d}/`)));
  const rank = (r) => (/\.d\.ts$/.test(r) ? 2 : /\.tsx?$/.test(r) ? 0 : 1);
  rels.sort((x, y) => rank(x) - rank(y));
  return { total: rels.length, rels: rels.slice(0, GREP_CAP) };
}

const ops = {
  async init({ sha, repo, tsPath, tsconfig }) {
    ts = (await import(pathToFileURL(tsPath || path.join(repo, 'node_modules/typescript/lib/typescript.js')).href)).default;
    S = createState({ repo, sha, tsconfig });
    const tPrefetch = Date.now();
    S.blobs = await prefetch(S.R, S.tree.files);
    const prefetchMs = Date.now() - tPrefetch;
    const tProgram = Date.now();
    const program = S.service.getProgram();
    return { ts: ts.version, config: S.config, roots: S.dtsRoots.length, programFiles: program.getSourceFiles().length, prefetched: S.blobs.size, prefetchMs, programMs: Date.now() - tProgram, ms: Date.now() - S.t0 };
  },
  open({ path: rel }) {
    openPath(rel);
    const t = Date.now();
    const n = S.service.getProgram().getSourceFiles().length;
    return { programFiles: n, ms: Date.now() - t };
  },
  definition({ path: rel, line, col }) {
    const abs = openPath(rel);
    const defs = S.service.getDefinitionAtPosition(abs, offsetAt(abs, line, col)) || [];
    return defs.map((d) => location(d.fileName, d.textSpan, { kind: d.kind, name: d.name }));
  },
  references({ path: rel, line, col }) {
    const abs = openPath(rel);
    const offset = offsetAt(abs, line, col);
    const word = wordAt(textOf(abs), offset);
    if (word) {
      if (S.grepRoots.size > GREP_ROOTS_MAX) S.grepRoots.clear();
      const before = S.grepRoots.size;
      const cand = grepCandidates(word);
      S.lastGrep = { word, total: cand.total, used: cand.rels.length };
      for (const r of cand.rels) {
        const a = path.join(S.R, r);
        if (!S.openFiles.has(a)) S.grepRoots.add(a);
      }
      if (S.grepRoots.size !== before) S.version++;
    }
    const seen = new Set();
    const out = [];
    for (const sym of S.service.findReferences(abs, offset) || []) {
      for (const r of sym.references) {
        const key = `${r.fileName}:${r.textSpan.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(location(r.fileName, r.textSpan, { isDefinition: !!r.isDefinition }));
      }
    }
    return out;
  },
  hover({ path: rel, line, col }) {
    const abs = openPath(rel);
    const info = S.service.getQuickInfoAtPosition(abs, offsetAt(abs, line, col));
    if (!info) return null;
    const sig = ts.displayPartsToString(info.displayParts);
    const doc = ts.displayPartsToString(info.documentation);
    const tags = (info.tags || []).map((t) => `*@${t.name}*${t.text ? ` ${ts.displayPartsToString(t.text)}` : ''}`).join('\n\n');
    const contents = ['```typescript\n' + sig + '\n```', doc, tags].filter(Boolean).join('\n\n');
    const loc = location(abs, info.textSpan);
    return { contents, range: { line: loc.line, col: loc.col, endLine: loc.endLine, endCol: loc.endCol } };
  },
  stats({ gc }) {
    if (gc) globalThis.gc?.();
    const m = process.memoryUsage();
    const program = S?.service.getProgram();
    return {
      sha: S?.sha ?? null,
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
      roots: S ? S.dtsRoots.length + S.openFiles.size + S.grepRoots.size : 0,
      dtsRoots: S?.dtsRoots.length ?? 0,
      openFiles: S?.openFiles.size ?? 0,
      grepRoots: S?.grepRoots.size ?? 0,
      programFiles: program?.getSourceFiles().length ?? 0,
      snapshots: S?.snapshots.size ?? 0,
      prefetched: S?.blobs.size ?? 0,
      gitMisses: S?.misses ?? 0,
      lastGrep: S?.lastGrep ?? null,
      grepScopes: S?.grepScopes ?? null,
    };
  },
  diagnose({ path: rel }) {
    const program = S.service.getProgram();
    const unresolved = new Map();
    const ambient = program.getTypeChecker().getAmbientModules().map((m) => m.getName().replace(/^"|"$/g, ''));
    const exact = new Set(ambient.filter((n) => !n.includes('*')));
    const wild = ambient.filter((n) => n.includes('*')).map((n) => new RegExp(`^${n.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`));
    const isAmbient = (n) => exact.has(n) || exact.has(n.replace(/^node:/, '')) || wild.some((re) => re.test(n));
    let imports = 0;
    let files = 0;
    for (const sf of program.getSourceFiles()) {
      if (S.toRel(sf.fileName) === null) continue;
      files++;
      for (const imp of ts.preProcessFile(sf.text, true, true).importedFiles) {
        imports++;
        const r = ts.resolveModuleName(imp.fileName, sf.fileName, S.options, S.host);
        if (!r.resolvedModule && !isAmbient(imp.fileName)) unresolved.set(imp.fileName, (unresolved.get(imp.fileName) || 0) + 1);
      }
    }
    const byCode = {};
    const samples = [];
    if (rel) {
      const abs = openPath(rel);
      for (const d of [...S.service.getSyntacticDiagnostics(abs), ...S.service.getSemanticDiagnostics(abs)]) {
        byCode[d.code] = (byCode[d.code] || 0) + 1;
        if (samples.length < 8) samples.push(`TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 160)}`);
      }
    }
    const top = [...unresolved].sort((a, b) => b[1] - a[1]).slice(0, 15);
    return { repoFiles: files, imports, unresolvedSpecifiers: unresolved.size, unresolvedImports: [...unresolved.values()].reduce((a, b) => a + b, 0), top, fileDiagnostics: byCode, samples };
  },
};

let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  queue = queue.then(async () => {
    try {
      const op = ops[msg.op];
      if (!op) throw new Error(`unknown op: ${msg.op}`);
      if (msg.op !== 'init' && msg.op !== 'stats' && !S) throw new Error('not initialized');
      reply({ id: msg.id, result: await op(msg) });
    } catch (e) {
      reply({ id: msg.id, error: String(e?.message || e) });
    }
  });
});
process.stdin.on('end', () => process.exit(0));
