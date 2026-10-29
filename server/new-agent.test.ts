import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_NOTE, createNewAgent, freshBranch } from './new-agent.ts';
import { DEFAULTS } from './config.ts';
import { checkMode } from './models.ts';
import type { Catalog } from './models.ts';
import type { Config } from './config.ts';
import type { Work } from './core-types.ts';

const AGENT = '12345678-1234-1234-1234-123456789abc';
const repo = (id: string, path: string) => ({ ...DEFAULTS.repo, id, name: id, path, github: `acme/${id}`, defaultBranch: 'main', settings: {} });
const config: Config = { ...DEFAULTS, repos: [repo('widgets', '/src/widgets'), repo('cocopilot', '/src/coco')], baseUrl: 'http://127.0.0.1:8777' };

function setup() {
  const work: Work = { slug: 'csv', title: 'CSV export', repo: 'widgets', timeline: [], stack: [{ number: 101 }, { planned: { title: 'Docs', branch: 'feat/csv-docs' } }] };
  const old: Work = { slug: 'old', title: 'Old', repo: 'widgets', timeline: [], stack: [], archived: { at: '2026-10-01', reason: 'merged' } };
  const all = [work, old];
  const placed: unknown[] = [];
  const started: Record<string, unknown>[] = [];
  const linked: unknown[] = [];
  const agent = createNewAgent({
    config,
    works: { get: (s) => all.find((w) => w.slug === s) ?? null, list: () => all },
    placement: {
      place: async (scope) => (placed.push(scope), { workspaceId: 'wks_1', cwd: '/tmp/x' }),
      freshWorkspace: async (repoId, opts) => (placed.push({ fresh: repoId, ...opts }), { workspaceId: 'wks_new', cwd: '/tmp/new' }),
      appRepoId: () => 'cocopilot',
    },
    agents: { start: async (opts) => (started.push(opts), { agentId: AGENT, workspaceId: String(opts.workspaceId) }) },
    briefs: { context: async () => ({ work, index: 0, pr: { head: 'feat/csv', base: 'main', title: 'Export' }, worktree: null, config }) },
    link: { linkAgent: async (a) => void linked.push(a), briefed: (id) => linked.push(`briefed ${id}`) },
  });
  return { agent, placed, started, linked };
}

const status = (re: RegExp) => (e: Error & { status?: number }) => e.status === 400 && re.test(e.message);

test('a place coco does not know is refused before anything starts', async () => {
  const { agent, placed, started } = setup();
  for (const place of [undefined, null, 'repo:widgets', { kind: 'repo', repoId: 'nope' }, { kind: 'fresh' }, { kind: 'work', slug: 'nope' }, { kind: 'work', slug: 'old' }, { kind: 'disk', path: '/' }]) {
    await assert.rejects(agent.start({ place, prompt: 'hi' }), status(/unknown place/), JSON.stringify(place));
  }
  await assert.rejects(agent.start({ place: { kind: 'row', slug: 'csv', key: 999 }, prompt: 'hi' }), status(/999 is not in csv/));
  await assert.rejects(agent.start({ place: { kind: 'row', slug: 'csv' }, prompt: 'hi' }), status(/unknown place/));
  assert.deepEqual(placed, []);
  assert.deepEqual(started, []);
});

test('an empty message is refused', async () => {
  const { agent, started } = setup();
  for (const prompt of [undefined, '', '   \n ', 42]) await assert.rejects(agent.start({ place: { kind: 'repo', repoId: 'widgets' }, prompt }), status(/needs a message/));
  assert.deepEqual(started, []);
});

test('a work agent starts in its Plan workspace with the owner’s words first, then the work’s facts, labelled with the work', async () => {
  const { agent, placed, started } = setup();
  const out = await agent.start({ place: { kind: 'work', slug: 'csv' }, prompt: 'Why is the export slow?\nLook at the query.' });
  assert.deepEqual(out, { agentId: AGENT, workspaceId: 'wks_1', cwd: '/tmp/x', title: 'Why is the export slow?' });
  assert.deepEqual(placed, [{ kind: 'work', slug: 'csv' }]);
  const msg = String(started[0].prompt);
  assert.ok(msg.startsWith('Why is the export slow?\nLook at the query.'));
  assert.match(msg, /The brief below is context[\s\S]*# CSV export/);
  assert.doesNotMatch(msg, /Read-only/);
  assert.deepEqual(started[0].labels, { source: 'cocopilot', kind: 'agent', work: 'csv' });
});

test('a PR agent runs in the row’s worktree, is linked to the row and counted as briefed; a repo or fresh one gets no brief', async () => {
  const { agent, placed, started, linked } = setup();
  await agent.start({ place: { kind: 'row', slug: 'csv', key: '101' }, prompt: 'Fix it' });
  assert.deepEqual(placed[0], { kind: 'row', slug: 'csv', key: 101, edits: true });
  assert.deepEqual(started[0].labels, { source: 'cocopilot', kind: 'agent', work: 'csv', pr: '101' });
  assert.match(String(started[0].prompt), /Worktree: `\/tmp\/x`/);
  assert.deepEqual(linked, [{ agentId: AGENT, workspaceId: 'wks_1', cwd: '/tmp/x', title: 'Fix it' }, `briefed ${AGENT}`]);
  await agent.start({ place: { kind: 'fresh', repoId: 'cocopilot' }, prompt: 'Add a button' });
  assert.match(String((placed[1] as { branch: string }).branch), /^agent\/add-a-button-[0-9a-f]{4}$/);
  assert.equal(started[1].prompt, 'Add a button');
  assert.deepEqual(started[1].labels, { source: 'cocopilot', kind: 'agent' });
});

test('places list every repo with coco’s own marked, the live works, and a work’s rows on request', async () => {
  const { agent } = setup();
  const p = await agent.places('csv');
  assert.equal(p.app, 'cocopilot');
  assert.deepEqual(p.repos.map((r) => [r.id, r.app]), [['widgets', false], ['cocopilot', true]]);
  assert.deepEqual(p.works.map((w) => w.slug), ['csv']);
  assert.deepEqual(p.rows, [{ key: '101', label: '#101', title: '' }, { key: 'b:feat:csv-docs', label: 'feat/csv-docs', title: 'Docs' }]);
  assert.match(APP_NOTE, /commit it on main[\s\S]*restart_coco[\s\S]*screenshot/);
  assert.match(freshBranch('!!!'), /^agent\/agent-[0-9a-f]{4}$/);
});

test('a mode is one Paseo lists for the provider; none picked is the provider’s default', () => {
  const cat: Catalog = { mode: 'auto', defaults: { default: 'claude/opus', fast: 'claude/sonnet' }, providers: [{ id: 'claude', models: [], error: null, modes: [{ id: 'plan', label: 'Plan', description: null, tier: null }, { id: 'auto', label: 'Auto', description: null, tier: null }], defaultMode: 'auto' }, { id: 'opencode', models: [], error: null }] };
  assert.equal(checkMode(cat, 'claude/opus', undefined), 'auto');
  assert.equal(checkMode(cat, 'claude/opus', 'plan'), 'plan');
  assert.equal(checkMode(cat, 'opencode/x', ''), undefined);
  assert.throws(() => checkMode(cat, 'claude/opus', 'bypassPermissions'), status(/claude has no mode bypassPermissions/));
  assert.throws(() => checkMode(cat, 'opencode/x', 'build'), status(/no mode list/));
});
