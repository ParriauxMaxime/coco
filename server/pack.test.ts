import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPack, mergeConfig, teamConfig, zipProblems } from './pack.ts';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file) => fs.readFileSync(file, 'utf8');

test('team config drops personal keys and points the provider inside the pack', () => {
  const raw = {
    owner: { name: 'Alice', login: 'alice' },
    repo: { path: '~/code/widgets', github: 'acme/widgets' },
    dataDir: '~/.cocopilot/data',
    baseUrl: 'http://127.0.0.1:8777',
    importRoots: ['/tmp'],
    skillPrefix: 'coco-',
    featureFlags: { provider: '~/.cocopilot/widgets-flags.mjs' },
  };
  const team = teamConfig(raw, { provider: 'widgets-flags.mjs' });
  assert.deepEqual(team, { repo: { github: 'acme/widgets' }, skillPrefix: 'coco-', featureFlags: { provider: 'providers/widgets-flags.mjs' } });
  assert.equal(teamConfig(raw).featureFlags.provider, undefined);
});

test('zip entries with an absolute path, a .. segment or a symlink are refused', async () => {
  const problems = zipProblems(['coco-pack.json', '../evil.md', '/etc/passwd', 'skills/a/../../x', 'skills/a/ok.md']);
  assert.equal(problems.length, 3);
  const src = tmp('pack-src-');
  write(path.join(src, 'coco-pack.json'), '{"format":1}');
  fs.symlinkSync('/etc', path.join(src, 'escape'));
  const zip = path.join(tmp('pack-zip-'), 'x.zip');
  execFileSync('zip', ['-q', '-r', '-y', zip, '.'], { cwd: src });
  const DATA = tmp('pack-data-');
  const pack = createPack({ APP: path.join(DATA, 'app'), DATA, config: { skillsDir: path.join(DATA, 'skills'), personasDir: path.join(DATA, 'personas') } });
  await assert.rejects(pack.stage(fs.readFileSync(zip)), /symlink escape/);
  assert.deepEqual(fs.readdirSync(path.join(DATA, 'pack-staging')), []);
  for (const d of [src, path.dirname(zip), DATA]) fs.rmSync(d, { recursive: true, force: true });
});

test('merge keeps the user owner and repo path and takes the team gate skills', () => {
  const user = { owner: { name: 'Bob', login: 'bob' }, repo: { path: '/src/widgets', github: 'acme/widgets' }, gateSkills: { 'self-review': ['old'] } };
  const team = { owner: { name: 'Alice', login: 'alice' }, repo: { path: '~/code/widgets', defaultBranch: 'main' }, gateSkills: { 'self-review': ['coco-review'] } };
  const merged = mergeConfig(user, team);
  assert.deepEqual(merged.owner, user.owner);
  assert.deepEqual(merged.repo, { path: '/src/widgets', github: 'acme/widgets', defaultBranch: 'main' });
  assert.deepEqual(merged.gateSkills['self-review'], ['coco-review']);
});

test('export then import reproduces the files, keeps local extras and backs up a changed one', async () => {
  const alice = tmp('pack-alice-');
  const skills = path.join(alice, 'skills');
  const method = path.join(skills, 'coco-work');
  const APP = path.join(method, 'app');
  const personas = path.join(method, 'personas');
  write(path.join(method, 'SKILL.md'), '# coco-work\n');
  write(path.join(method, 'notes.md'), 'team notes\n');
  write(path.join(method, 'old.md.bak'), 'backup');
  write(path.join(method, 'node_modules/x/index.js'), '');
  write(path.join(APP, 'server/index.ts'), '');
  fs.symlinkSync(APP, path.join(method, 'plugin'));
  write(path.join(skills, 'other/SKILL.md'), '# other\n');
  write(path.join(personas, 'alice.md'), '# Alice\n');
  write(path.join(personas, 'alice.json'), '{}');
  write(path.join(personas, 'alice-notes.md'), 'notes');
  write(path.join(personas, 'README.md'), 'readme');
  write(path.join(alice, 'flags.mjs'), 'export const createFeatureFlags = () => ({});\n');
  const aliceFile = path.join(alice, 'coco.config.json');
  write(aliceFile, JSON.stringify({ owner: { name: 'Alice', login: 'alice' }, repo: { path: '~/code/widgets', github: 'acme/widgets' }, gateSkills: { 'self-review': ['coco-review'] }, featureFlags: { provider: path.join(alice, 'flags.mjs') } }));
  const aliceConfig = { owner: { login: 'alice' }, file: aliceFile, skillsDir: skills, personasDir: personas, skillPrefix: 'coco-', personaFiles: { ignore: ['README'], companionSuffixes: ['notes'] }, featureFlags: { provider: path.join(alice, 'flags.mjs') } };
  const out = createPack({ APP, DATA: path.join(alice, 'data'), config: aliceConfig });

  const c = out.contents();
  assert.deepEqual(c.personas, [{ login: 'alice', files: ['alice-notes.md', 'alice.json', 'alice.md'] }, { login: null, files: ['README.md'] }]);
  assert.deepEqual(c.skills.map((s) => [s.name, s.files]), [['coco-work', ['SKILL.md', 'notes.md']]]);
  const zip = await out.exportZip({ personas: ['alice'], skills: ['coco-work'], config: true, provider: true });
  const zipFile = path.join(alice, 'pack.zip');
  fs.writeFileSync(zipFile, zip);
  const entries = execFileSync('unzip', ['-Z1', zipFile], { encoding: 'utf8' }).split('\n').filter((e) => e && !e.endsWith('/')).sort();
  assert.deepEqual(entries, ['coco-pack.json', 'config.json', 'personas/alice-notes.md', 'personas/alice.json', 'personas/alice.md', 'providers/flags.mjs', 'skills/coco-work/SKILL.md', 'skills/coco-work/notes.md']);

  const bob = tmp('pack-bob-');
  const bobSkills = path.join(bob, 'skills');
  write(path.join(bobSkills, 'coco-work/notes.md'), 'my old notes\n');
  write(path.join(bobSkills, 'coco-work/extra.md'), 'mine\n');
  const bobFile = path.join(bob, 'coco.config.json');
  write(bobFile, JSON.stringify({ owner: { name: 'Bob', login: 'bob' }, repo: { path: '/src/widgets' } }));
  const DATA = path.join(bob, 'data');
  const into = createPack({ APP: path.join(bob, 'app'), DATA, config: { file: bobFile, skillsDir: bobSkills, personasDir: path.join(bob, 'personas') } });

  const preview = await into.stage(zip);
  assert.equal(preview.by, 'alice');
  assert.deepEqual(preview.skills, [{ name: 'coco-work', files: [{ file: 'SKILL.md', status: 'new' }, { file: 'notes.md', status: 'changed' }] }]);
  assert.deepEqual(preview.provider, { file: 'flags.mjs', status: 'new' });
  assert.deepEqual(preview.config, { added: ['gateSkills', 'featureFlags'], changed: ['repo'], kept: ['owner', 'repo.path'] });

  const done = into.apply(preview.id);
  assert.deepEqual(done.applied, { personas: 3, skills: 2, provider: 1, config: 1 });
  assert.equal(read(path.join(bobSkills, 'coco-work/notes.md')), 'team notes\n');
  assert.equal(read(path.join(bobSkills, 'coco-work/extra.md')), 'mine\n');
  assert.equal(read(path.join(bob, 'personas/alice.md')), '# Alice\n');
  assert.equal(read(path.join(done.backup, 'skills/coco-work/notes.md')), 'my old notes\n');
  const merged = JSON.parse(read(bobFile));
  assert.deepEqual(merged.owner, { name: 'Bob', login: 'bob' });
  assert.deepEqual(merged.repo, { path: '/src/widgets', github: 'acme/widgets' });
  assert.equal(merged.featureFlags.provider, path.join(DATA, 'providers/flags.mjs'));
  assert.ok(fs.existsSync(merged.featureFlags.provider));
  assert.deepEqual(fs.readdirSync(path.join(DATA, 'pack-staging')), []);
  for (const d of [alice, bob]) fs.rmSync(d, { recursive: true, force: true });
});
