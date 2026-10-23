import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createComments } from './comments.mjs';
import { createReviewAgent } from './review-agent.mjs';
import { DEFAULTS } from './config.mjs';

const config = { ...DEFAULTS, owner: { name: 'Alice', login: 'alice' }, repo: { ...DEFAULTS.repo, github: 'acme/widgets', defaultBranch: 'main' } };

const SLUG = 'demo';
const N = 102;
const SHA = 'a'.repeat(40);
const C1 = 'c'.repeat(40);
const C2 = 'd'.repeat(40);

const comment = (id, over = {}) => ({ id, path: 'src/a.ts', side: 'head', sha: SHA, startLine: 10, endLine: 11, snippet: 'const a = 1;\nconst b = 2;', ctxBefore: ['// before'], ctxAfter: ['// after'], body: `fix ${id}`, author: 'alice', createdAt: 'x', updatedAt: 'x', status: 'open', runId: null, resolution: null, githubReviewCommentId: null, ...over });

function setup({ comments: list = [], execImpl, stack } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-agent-test-'));
  const DATA = path.join(tmp, 'data');
  const PERSONAS = path.join(tmp, 'personas');
  fs.mkdirSync(path.join(DATA, 'works', SLUG, 'comments'), { recursive: true });
  fs.mkdirSync(PERSONAS);
  fs.writeFileSync(path.join(DATA, 'works', SLUG, 'comments', `pr-${N}.json`), JSON.stringify({ number: N, headSha: SHA, mergeBase: null, comments: list }));
  let work = { slug: SLUG, title: 'Demo', notes: 'Rule one\n```\nfenced\n```', timeline: [], stack: stack || [{ number: 101, personas: [] }, { number: N, personas: ['bob'] }, { number: 103, personas: [] }] };
  const works = { get: (s) => (s === SLUG ? structuredClone(work) : null), save: (w) => ((work = structuredClone(w)), w) };
  const calls = [];
  const envs = [];
  const exec = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    envs.push(opts?.env);
    return execImpl ? execImpl(cmd, args) : { ok: true, stdout: '', stderr: '' };
  };
  const comments = createComments({ DATA, REPO: tmp, config });
  const started = [];
  const agents = { start: async (opts) => (started.push(opts), { agentId: '12345678-1234-1234-1234-123456789abc', workspaceId: 'wks_thing', createdWorkspace: opts.worktree ? 'wks_new' : null }) };
  const agent = createReviewAgent({ DATA, REPO: '/repo', config, works, comments, PERSONAS, exec, agents });
  return { tmp, DATA, PERSONAS, work: () => work, calls, envs, comments, agent, started };
}

const pr = { number: N, title: 'Add thing', url: 'https://github.com/x/y/pull/102', base: 'feat/base', head: 'feat/thing', sha: SHA, body: 'Body text\n# Heading inside' };
const stackPrs = [{ number: 101, state: 'MERGED' }, { number: N, state: 'OPEN', isDraft: true }, { number: 103, state: 'OPEN', isDraft: true }];

test('buildBrief has every section in order, the stack line and the persona excerpt', () => {
  const { agent, PERSONAS } = setup();
  const lines = Array.from({ length: 30 }, (_, i) => `- check ${i + 1}`).join('\n');
  fs.writeFileSync(path.join(PERSONAS, 'bob.md'), `# Bob\n\n## What he checks\n\n${lines}\n\n## What he avoids\n\n- avoid-me\n`);
  const text = agent.buildBrief({
    work: { slug: SLUG, notes: 'Work note verbatim' },
    pr,
    index: 1,
    stackPrs,
    comments: [comment('bbb', { path: 'src/z.ts', startLine: 3, endLine: 3, snippet: 'z' }), comment('aaa')],
    personas: ['bob', 'ghost'],
    options: { commits: 'one', runId: 'r1', resultPath: '/abs/pr-102-run-r1-result.json' },
  });
  const headings = ['## Hard rules', '## PR', '## PR body', '## Work rules', '## Owner personas', '## Comments to address', '## How to report'];
  const at = headings.map((h) => text.indexOf(`\n${h}\n`));
  assert.ok(at.every((i) => i > 0), `missing heading in ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.match(text, /PR 2 of 3: #101 ✓ merged → \*\*#102\*\* → #103 draft/);
  assert.match(text, /NEVER `git push`/);
  assert.match(text, /Head sha: `a{40}`/);
  assert.match(text, /Body text\n# Heading inside/);
  assert.match(text, /Work note verbatim/);
  assert.match(text, /- check 20\n/);
  assert.doesNotMatch(text, /check 21\b/);
  assert.doesNotMatch(text, /avoid-me/);
  assert.ok(text.indexOf('### aaa · src/a.ts:10-11 (head)') < text.indexOf('### bbb · src/z.ts:3-3 (head)'));
  assert.match(text, /Read `AGENTS\.md` and `CLAUDE\.md`, then follow the rules/);
  assert.doesNotMatch(text, /commit messages follow/);
  assert.match(text, /Alice reviews the commits/);
  assert.match(text, /  \/\/ before\n> const a = 1;\n> const b = 2;\n  \/\/ after/);
  assert.match(text, /Cc-Comment: <id>/);
  assert.match(text, /\/abs\/pr-102-run-r1-result\.json/);
});

test('buildBrief squash wording, no persona file, 30 cap', () => {
  const { agent } = setup();
  const base = { work: { slug: SLUG, notes: '' }, pr, index: 1, stackPrs, personas: ['ghost'], options: { commits: 'squash', runId: 'r1' } };
  const text = agent.buildBrief({ ...base, comments: [comment('aaa')] });
  assert.match(text, /One single commit/);
  assert.match(text, /## Owner personas\n\n\(none\)/);
  const many = Array.from({ length: 31 }, (_, i) => comment(`id${i}`));
  assert.throws(() => agent.buildBrief({ ...base, comments: many }), (e) => e.status === 400 && /30/.test(e.message));
});

function seedRun(ctx, over = {}) {
  const dir = path.join(ctx.DATA, 'works', SLUG, 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const run = { runId: 'abcd1234', number: N, slug: SLUG, startedAt: new Date(Date.now() - 60000).toISOString(), agentId: 'agent-1', mode: 'cwd', cwd: '/wt', commentIds: ['c1', 'c2', 'c3'], commits: 'one', provider: 'p', status: 'running', remoteHeadBefore: 'r0', prSha: SHA, briefPath: '/b.md', resultPath: path.join(dir, `pr-${N}-run-abcd1234-result.json`), ...over };
  fs.writeFileSync(path.join(dir, `pr-${N}-run-${run.runId}.json`), JSON.stringify(run));
  return run;
}
const sent = (id) => comment(id, { status: 'sent', runId: 'abcd1234' });

test('ingest applies a hand-written result file onto comments', async () => {
  const ctx = setup({ comments: [sent('c1'), sent('c2'), sent('c3')], execImpl: (cmd, args) => (args[0] === 'ls' ? { ok: true, stdout: '[]' } : { ok: true, stdout: 'r0\trefs/pull/x' }) });
  const run = seedRun(ctx);
  fs.writeFileSync(run.resultPath, JSON.stringify([{ id: 'c1', status: 'fixed', commit: C1, note: 'renamed' }, { id: 'c2', status: 'declined', commit: null, note: 'out of scope' }, { id: 'zzz', status: 'fixed', commit: C2, note: 'unknown id' }]));
  const { runs } = await ctx.agent.ingest(SLUG, N);
  const byId = Object.fromEntries(ctx.comments.list(SLUG, N).comments.map((c) => [c.id, c]));
  assert.equal(byId.c1.status, 'fixed');
  assert.match(JSON.stringify(byId.c1.resolution), /renamed/);
  assert.equal(byId.c2.status, 'declined');
  assert.match(JSON.stringify(byId.c2.resolution), /out of scope/);
  assert.equal(byId.c3.status, 'sent');
  assert.equal(runs[0].status, 'done');
  assert.match(ctx.work().timeline[0].text, /^review #102: 1 fixed, 1 declined \(abcd1234\)$/);
  assert.equal((await ctx.agent.ingest(SLUG, N)).runs[0].status, 'done');
  assert.equal(ctx.work().timeline.length, 1);
});

test('ingest falls back to Cc-Comment trailers from two commits and waits for an idle agent', async () => {
  let agentStatus = 'running';
  const log = `${C1}\nfix: first\n\nCc-Comment: c1\n\0\n${C2}\nfix: second\n\nbody\n\nCc-Comment: c2\nCc-Comment: nope\n\0`;
  const ctx = setup({
    comments: [sent('c1'), sent('c2'), sent('c3')],
    execImpl: (cmd, args) => {
      if (cmd === 'paseo') return { ok: true, stdout: JSON.stringify([{ id: 'agent-1', status: agentStatus, cwd: '/wt' }]) };
      if (args.includes('log')) return { ok: true, stdout: log };
      return { ok: true, stdout: 'r0\trefs/pull/x' };
    },
  });
  seedRun(ctx);
  let { runs } = await ctx.agent.ingest(SLUG, N);
  let byId = Object.fromEntries(ctx.comments.list(SLUG, N).comments.map((c) => [c.id, c]));
  assert.equal(byId.c1.status, 'fixed');
  assert.equal(byId.c2.status, 'fixed');
  assert.equal(byId.c3.status, 'sent');
  assert.match(JSON.stringify(byId.c1.resolution), new RegExp(C1.slice(0, 11)));
  assert.match(JSON.stringify(byId.c2.resolution), new RegExp(C2.slice(0, 11)));
  assert.equal(runs[0].status, 'running');
  assert.ok(ctx.calls.some((c) => c.includes(`${SHA}..HEAD`)));
  agentStatus = 'idle';
  runs = (await ctx.agent.ingest(SLUG, N)).runs;
  assert.equal(runs[0].status, 'done');
  assert.equal(ctx.comments.list(SLUG, N).comments.find((c) => c.id === 'c3').status, 'sent');
});

test('push guard warns once when the remote head moved, not when the user pushed', async () => {
  const exec = (cmd, args) => (cmd === 'paseo' ? { ok: true, stdout: JSON.stringify([{ id: 'agent-1', status: 'running', cwd: '/wt' }]) } : args.includes('ls-remote') ? { ok: true, stdout: 'r1\trefs/pull/x' } : { ok: true, stdout: '' });
  const moved = setup({ comments: [sent('c1')], execImpl: exec });
  seedRun(moved);
  await moved.agent.ingest(SLUG, N);
  await moved.agent.ingest(SLUG, N);
  const warnings = moved.work().timeline.filter((t) => t.kind === 'warning');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].text, 'review #102: remote head moved during run abcd1234');

  const pushed = setup({ comments: [sent('c1')], execImpl: exec });
  seedRun(pushed, { pushedByUser: true });
  await pushed.agent.ingest(SLUG, N);
  assert.equal(pushed.work().timeline.filter((t) => t.kind === 'warning').length, 0);
});

const ghJson = JSON.stringify({ number: N, title: 'Add thing', url: 'u', state: 'OPEN', isDraft: true, headRefName: 'feat/thing', baseRefName: 'feat/base', headRefOid: SHA, body: 'b' });
const startExec = ({ worktree, agents }) => (cmd, args) => {
  if (cmd === 'gh') return { ok: true, stdout: ghJson };
  if (cmd === 'git' && args.includes('worktree')) return { ok: true, stdout: worktree ? `worktree /repo\nHEAD x\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD y\nbranch refs/heads/feat/thing\n` : 'worktree /repo\nHEAD x\nbranch refs/heads/main\n' };
  if (cmd === 'git') return { ok: true, stdout: `${'9'.repeat(40)}\trefs/pull/${N}/head\n` };
  if (args[0] === 'ls') return { ok: true, stdout: JSON.stringify(agents || []) };
  if (args[0] === 'send') return { ok: true, stdout: 'sent' };
  return { ok: true, stdout: 'Agent 12345678-1234-1234-1234-123456789abc started' };
};

test('start picks the runner by the plan rule and records the run', async () => {
  const wt = path.join(os.homedir(), '.paseo/worktrees/p/thing');
  const open = (extra) => [comment('c1'), comment('c2'), comment('old', { status: 'outdated' }), ...(extra || [])];

  const a = setup({ comments: open(), execImpl: startExec({ worktree: wt, agents: [{ id: 'closed-1', status: 'closed', cwd: '~/.paseo/worktrees/p/thing' }, { id: 'live-1', status: 'idle', cwd: '~/.paseo/worktrees/p/thing' }] }) });
  const runA = await a.agent.start(SLUG, N, { commentIds: ['c1', 'c2', 'old'], commits: 'squash' });
  assert.equal(runA.mode, 'send');
  assert.equal(runA.agentId, 'live-1');
  assert.deepEqual(runA.commentIds, ['c1', 'c2']);
  assert.equal(runA.remoteHeadBefore, '9'.repeat(40));
  assert.ok(a.calls.some((c) => c[0] === 'paseo' && c[1] === 'send' && c[2] === 'live-1' && c[3].startsWith('Read ') && c[3].includes(runA.briefPath)));
  const relabel = a.calls.find((c) => c[0] === 'paseo' && c[1] === 'agent' && c[2] === 'update');
  assert.ok(relabel.includes('live-1') && relabel.includes(`run=${runA.runId}`) && relabel.includes('kind=review') && relabel.includes('comments=2'));
  assert.ok(fs.existsSync(runA.briefPath));
  assert.match(fs.readFileSync(runA.briefPath, 'utf8'), /One single commit/);
  const stored = a.comments.list(SLUG, N).comments;
  assert.deepEqual(stored.map((c) => [c.id, c.status, c.runId]), [['c1', 'sent', runA.runId], ['c2', 'sent', runA.runId], ['old', 'outdated', null]]);
  assert.equal(a.work().timeline[0].kind, 'agent');
  assert.equal(a.work().timeline[0].text, `review #${N}: sent 2 comments to send agent live-1`);
  assert.equal(a.agent.list(SLUG, N).length, 1);
  await assert.rejects(a.agent.start(SLUG, N, { commentIds: ['c1'] }), (e) => e.status === 400);

  const b = setup({ comments: open(), execImpl: startExec({ worktree: wt, agents: [] }) });
  const requester = 'aaaaaaaa-1234-1234-1234-123456789abc';
  const runB = await b.agent.start(SLUG, N, { commentIds: ['c1'], commits: 'one', requestedBy: requester });
  assert.equal(runB.mode, 'cwd');
  assert.equal(runB.cwd, wt);
  assert.equal(runB.agentId, '12345678-1234-1234-1234-123456789abc');
  const [startB] = b.started;
  assert.equal(startB.cwd, wt);
  assert.equal(startB.worktree, null);
  assert.equal(startB.title, 'Fix review #102 (1)');
  assert.deepEqual(startB.labels, { source: 'cocopilot', kind: 'review', run: runB.runId, work: SLUG, pr: String(N), comments: 1, 'paseo.parent-agent-id': requester });

  const c = setup({ comments: open(), execImpl: startExec({ worktree: null }) });
  const runC = await c.agent.start(SLUG, N, { commentIds: ['c1'], commits: 'one' });
  assert.equal(runC.mode, 'checkout-pr');
  const [startC] = c.started;
  assert.equal(startC.cwd, '/repo');
  assert.deepEqual(startC.worktree, { mode: 'checkout-pr', prNumber: N });
  assert.ok(!('paseo.parent-agent-id' in startC.labels));
  assert.ok(c.work().timeline.some((t) => t.text === 'new checkout-pr worktree: created workspace wks_new'));

  const d = setup({ comments: open(), execImpl: startExec({ worktree: null }) });
  await assert.rejects(d.agent.start(SLUG, N, { commentIds: ['old'] }), (e) => e.status === 400);
  await assert.rejects(d.agent.start(SLUG, N, { commentIds: [] }), (e) => e.status === 400);
  assert.equal(d.comments.list(SLUG, N).comments[0].status, 'open');
});
