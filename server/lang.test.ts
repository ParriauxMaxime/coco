import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createLang } from './lang.ts';
import { loadConfig } from './config.ts';

// typescript from the app's deps, else from the configured repo
const findTs = () => {
  try {
    return createRequire(import.meta.url).resolve('typescript');
  } catch {
    const repo = loadConfig({ APP: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }).repo.path;
    const file = repo && path.join(repo, 'node_modules/typescript/lib/typescript.js');
    return file && fs.existsSync(file) ? file : null;
  }
};
const TS = findTs();
let dir, lang, sha;
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const call = async (op, q) => {
  const out = {};
  const url = `/api/code/pr/1/${op}?${new URLSearchParams({ sha, ...q })}`;
  const parts = new URL(url, 'http://x').pathname.split('/').filter(Boolean).slice(1);
  await lang.handle({ method: 'GET', url }, {}, parts, null, (_res, status, body) => Object.assign(out, { status, body }));
  return out;
};

const skip = !TS && 'typescript not found';

before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-test-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const w = (f, c) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  };
  w('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, allowImportingTsExtensions: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022', paths: { '/*': ['./*'] } }, include: ['./**/*.ts'] }));
  w('lib/b.ts', '/** Doubles n. */\nexport function foo(n: number): number {\n  return n * 2;\n}\n');
  w('a.ts', "import { foo } from '/lib/b.ts';\n\nexport const x = foo(21);\n");
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  sha = git('rev-parse', 'HEAD');
  lang = createLang({ REPO: dir, tsPath: TS });
  const first = await call('definition', { path: 'a.ts', line: 3, col: 18 });
  assert.equal(first.status, 202);
  assert.equal(first.body.status, 'indexing');
  const init = await lang.ensure(sha);
  assert.ok(init.result, init.error);
});

after(() => {
  lang?.shutdown();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('definition of an imported symbol lands in the declaring file', { skip }, async () => {
  const r = await call('definition', { path: 'a.ts', line: 3, col: 18 });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.result.map(({ path: p, line, col }) => ({ path: p, line, col })),
    [{ path: 'lib/b.ts', line: 2, col: 17 }],
  );
  assert.match(r.body.result[0].preview, /export function foo/);
});

test('references finds the declaration and the usages in both files', { skip }, async () => {
  const r = await call('references', { path: 'lib/b.ts', line: 2, col: 18 });
  assert.equal(r.status, 200);
  const where = r.body.result.map((x) => `${x.path}:${x.line}`).sort();
  assert.deepEqual(where, ['a.ts:1', 'a.ts:3', 'lib/b.ts:2']);
});

test('hover shows the signature and the documentation', { skip }, async () => {
  const r = await call('hover', { path: 'a.ts', line: 3, col: 19 });
  assert.equal(r.status, 200);
  assert.match(r.body.result.contents, /foo\(n: number\): number/);
  assert.match(r.body.result.contents, /Doubles n\./);
  assert.deepEqual(r.body.result.range, { line: 3, col: 18, endLine: 3, endCol: 21 });
});

test('an unknown path is an error', { skip }, async () => {
  const r = await call('definition', { path: 'nope.ts', line: 1, col: 1 });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /unknown path/);
});
