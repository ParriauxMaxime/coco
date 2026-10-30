import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLanding, fastForward, landReady } from './landed.ts';

type Reply = { ok?: boolean; stdout?: string; stderr?: string };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'land-'));
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

// a git that answers from a script by argument prefix, and records every call it was asked
function fakeGit(answers: Record<string, Reply | Reply[]>) {
  const calls: string[][] = [];
  const queued = new Map(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const git = async (args: string[]) => {
    calls.push(args);
    const asked = args.join(' ');
    for (const [prefix, replies] of queued) {
      if (!asked.startsWith(prefix)) continue;
      const reply = replies.length > 1 ? (replies.shift() as Reply) : replies[0];
      return { ok: reply.ok ?? true, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  return { git, calls };
}

const clean = {
  'status --porcelain': { stdout: '' },
  'rev-parse --abbrev-ref HEAD': { stdout: 'main' },
  'rev-parse --verify': { stdout: 'abc' },
  'merge-base --is-ancestor': { ok: true },
  'merge --ff-only': { ok: true },
};

test('a landing refuses a dirty checkout, naming the paths, and a branch that is not a fast-forward, naming the rebase', async () => {
  const dirty = fakeGit({ ...clean, 'status --porcelain': { stdout: ' M server/cards.ts\n?? notes.md\n' } });
  await assert.rejects(landReady(dirty.git, { base: 'main', branch: 'retro/x' }), /the app checkout is dirty: commit or stash server\/cards\.ts, notes\.md/);
  const diverged = fakeGit({ ...clean, 'merge-base --is-ancestor': { ok: false } });
  await assert.rejects(landReady(diverged.git, { base: 'main', branch: 'retro/x' }), /retro\/x is not a fast-forward of main: rebase retro\/x onto main first/);
  const elsewhere = fakeGit({ ...clean, 'rev-parse --abbrev-ref HEAD': { stdout: 'retro/x' } });
  await assert.rejects(landReady(elsewhere.git, { base: 'main', branch: 'retro/x' }), /the app checkout is on retro\/x: check out main/);
  const missing = fakeGit({ ...clean, 'rev-parse --verify': { ok: false } });
  await assert.rejects(landReady(missing.git, { base: 'main', branch: 'retro/x' }), /no branch retro\/x in the app checkout/);
  // a row that ships straight on the default branch has no branch to check out
  const ok = fakeGit(clean);
  await landReady(ok.git, { base: 'main', branch: 'retro/x' });
  await landReady(ok.git, { base: 'main', branch: null });
});

test('the merge is --ff-only: a divergence is refused rather than merged behind a commit of its own', async () => {
  const ok = fakeGit(clean);
  await fastForward(ok.git, { base: 'main', branch: 'retro/x' });
  assert.deepEqual(ok.calls[0], ['merge', '--ff-only', 'refs/heads/retro/x']);
  const refused = fakeGit({ ...clean, 'merge --ff-only': { ok: false, stderr: 'fatal: Not possible to fast-forward' } });
  await assert.rejects(fastForward(refused.git, { base: 'main', branch: 'retro/x' }), /main cannot fast-forward onto retro\/x: fatal: Not possible to fast-forward/);
});

// a landing whose checkout fast-forwards from SHA1 to SHA2, and whatever the boot afterwards reports
function landing({ gitRunning = SHA2, how = 'auto', data = tmp(), restarts = [] as number[], marked = [] as string[] } = {}) {
  const app = fakeGit({ ...clean, 'log -1 --format=%H %cI': [{ stdout: `${SHA1} 2026-10-30T10:00:00+00:00` }, { stdout: `${SHA2} 2026-10-30T10:01:00+00:00` }] });
  const landing = createLanding({
    DATA: data,
    APP: '/app-that-does-not-exist',
    url: 'http://127.0.0.1:9',
    gitOf: () => ({ git: app.git, base: 'main', land: how }),
    stackOf: () => [{ planned: { order: 6, title: 'Renderings on a choice card' } }],
    restart: async () => void restarts.push(1),
    running: async () => gitRunning,
    marked: async (rec) => void marked.push(rec.label),
    waitMs: 1,
  });
  return { landing, app, restarts, marked, data };
}

test("a landing fast-forwards, journals and restarts; the boot that answers on the row's sha marks it, one on another commit undoes it", async () => {
  const first = landing();
  const rec = await first.landing.land('retro', { row: 6, by: 'agent' });
  assert.deepEqual([rec.sha, rec.previous, rec.state, rec.by, rec.base, rec.branch], [SHA2, SHA1, 'landing', 'agent', 'main', null]);
  assert.deepEqual([first.restarts.length, first.app.calls.some((c) => c[0] === 'merge')], [1, false]);
  await first.landing.settle();
  assert.deepEqual([first.marked, first.landing.of('retro')?.state], [['Renderings on a choice card'], 'landed']);

  // the same landing read by a boot on the commit it came from: fast-forwarded back and restarted on it
  const second = landing({ gitRunning: SHA1 });
  await second.landing.land('retro', { row: 6, by: 'owner' });
  await second.landing.settle();
  const undone = second.landing.of('retro');
  assert.deepEqual([undone?.state, undone?.detail], ['rolled-back', `coco runs ${SHA1.slice(0, 7)}, not ${SHA2.slice(0, 7)}: fast-forwarded back to ${SHA1.slice(0, 7)} and restarted`]);
  assert.deepEqual([second.marked, second.app.calls.filter((c) => c[0] === 'reset').map((c) => c[2])], [[], [SHA1]]);
  assert.equal(second.restarts.length, 2, 'the landing restart, then the one back on the old commit');
});

test('a row with a PR, or a repo that ships rows as PRs, is refused before git is touched', async () => {
  const shipsPrs = landing({ how: 'pr' });
  await assert.rejects(shipsPrs.landing.land('retro', { row: 6, by: 'owner' }), /this repo ships rows as PRs: set its settings.land to "auto"/);
  const withPr = createLanding({
    DATA: tmp(),
    APP: '/nope',
    url: 'http://127.0.0.1:9',
    gitOf: () => ({ git: fakeGit(clean).git, base: 'main', land: 'auto' }),
    stackOf: () => [{ number: 12, planned: { order: 12, title: 'A row with a PR' } }],
    restart: async () => {},
    running: async () => SHA2,
    marked: async () => {},
  });
  await assert.rejects(withPr.land('retro', { row: 12, by: 'agent' }), /#12 has a PR: GitHub lands it, coco does not/);
  await assert.rejects(withPr.land('retro', { row: 99, by: 'agent' }), /no row 99 in this work/);
});
