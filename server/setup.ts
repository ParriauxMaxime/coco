// Setup checklist for a first install or an update: what is installed and configured, derived from disk, gh and paseo; an agent can finish it from docs/setup.md.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createPaseoAgents, launcherEnv } from './paseo-agent.ts';
import type { ExecFileOptions } from 'node:child_process';
import { skillFor } from './config.ts';
import type { Config } from './config.ts';
import type { ReadBody, Req, Res, RunResult, Send } from './core-types.ts';

interface SetupFacts {
  config: boolean;
  repoPath: string;
  repo: boolean;
  gh: boolean;
  paseo: boolean;
  plugin: { path: string; enabled: boolean } | null;
  pluginSource: string;
  shippedSkills: string[];
  missingSkills: string[];
  changedSkills: string[];
  personas: number;
  works: number;
}

interface SetupStep {
  id: string;
  label: string;
  done: boolean;
  optional: boolean;
  hint: string;
  command: string;
}

type SetupExec = (cmd: string, args: string[], opts?: ExecFileOptions) => Promise<RunResult>;

interface SetupAgents {
  start(opts: { title: string; provider: string; thinking: string; cwd: string; labels: Record<string, string>; prompt: string }): Promise<{ agentId: string; createdWorkspace: string | null }>;
}

const STARTED = Date.now();
const defaultExec: SetupExec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') }));
  });
const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const files = (dir: string, rel = ''): string[] =>
  fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(dir, path.join(rel, e.name)) : e.isFile() && !e.name.endsWith('.bak') ? [path.join(rel, e.name)] : []));
// installed holds every shipped file byte for byte; extra installed files are the user's
export const sameSkill = (shipped: string, installed: string) => {
  if (real(shipped) === real(installed)) return true;
  return files(shipped).every((f) => {
    const to = path.join(installed, f);
    return fs.existsSync(to) && fs.readFileSync(to).equals(fs.readFileSync(path.join(shipped, f)));
  });
};
const copySkills = (names: string[], { APP, skillsDir }: { APP: string; skillsDir: string }) => `mkdir -p ${skillsDir} && ${names.map((s) => `cp -R ${APP}/skills/${s} ${skillsDir}/`).join(' && ')}`;

function pluginStep(f: SetupFacts, APP: string): SetupStep {
  const install = `(cd ${APP}/paseo-plugin && npm ci) && paseo plugin install ${APP}/paseo-plugin`;
  const step: SetupStep = { id: 'paseo', label: 'Paseo plugin', done: false, optional: false, hint: 'Links Paseo workspaces to works.', command: install };
  if (!f.paseo) return { ...step, hint: 'Install Paseo first: https://paseo.sh', command: '' };
  if (!f.plugin) return step;
  if (f.plugin.path !== f.pluginSource) return { ...step, hint: `Installed from ${f.plugin.path}, not from this checkout.`, command: `paseo plugin remove cocopilot && ${install}` };
  if (!f.plugin.enabled) return { ...step, hint: 'Installed but disabled.', command: 'paseo plugin enable cocopilot' };
  return { ...step, done: true };
}

export function setupSteps(f: SetupFacts, { APP, skillsDir }: { APP: string; skillsDir: string }): SetupStep[] {
  const installable = f.missingSkills.filter((s) => f.shippedSkills.includes(s));
  return [
    { id: 'config', label: 'Config file', done: f.config, optional: false, hint: 'Owner, repo, gates and models. Every key: docs/configuration.md.', command: `cp ${APP}/coco.config.example.json ${APP}/coco.config.json` },
    { id: 'repo', label: 'Repository', done: f.repo, optional: false, hint: f.repoPath ? `${f.repoPath} is not a git repository.` : 'Set repo.path in the config, or start with COCO_REPO=<path>.', command: '' },
    { id: 'gh', label: 'GitHub CLI logged in', done: f.gh, optional: false, hint: 'PR state, CI and reviews come from gh.', command: 'gh auth login' },
    pluginStep(f, APP),
    { id: 'skills', label: 'Agent skills', done: f.missingSkills.length === 0, optional: false, hint: f.missingSkills.length ? `Missing in ${skillsDir}: ${f.missingSkills.join(', ')}.` : 'Agents report findings and decisions through them.', command: installable.length ? copySkills(installable, { APP, skillsDir }) : '' },
    { id: 'skills-current', label: 'Skills match this version', done: f.changedSkills.length === 0, optional: true, hint: `${f.changedSkills.join(', ')} ${f.changedSkills.length > 1 ? 'differ' : 'differs'} from ${APP}/skills: an older copy, or your own edits. Diff, then copy over an older copy, or keep yours with \`"skillOverrides": { "<name>": "<name>" }\` in the config.`, command: f.changedSkills.length ? f.changedSkills.map((s) => `diff -r ${APP}/skills/${s} ${skillsDir}/${s}`).join('; ') : '' },
    { id: 'personas', label: 'Reviewer personas', done: f.personas > 0, optional: true, hint: 'Optional. One markdown file per reviewer, format in docs/examples/personas/alice.md.', command: '' },
    { id: 'work', label: 'First work', done: f.works > 0, optional: false, hint: 'A feature shipped as one PR or a stack. Attach a Paseo project, or turn a link into a work from the Inbox.', command: '' },
  ];
}

export function createSetup({ APP, config, works, personaCount, exec = defaultExec, agents = createPaseoAgents() }: { APP: string; config: Config; works: { list(): unknown[] }; personaCount: () => number; exec?: SetupExec; agents?: SetupAgents }) {
  const configFile = config.file || process.env.COCO_CONFIG || path.join(APP, 'coco.config.json');
  const shipped = () => (fs.existsSync(path.join(APP, 'skills')) ? fs.readdirSync(path.join(APP, 'skills')).filter((d) => fs.existsSync(path.join(APP, 'skills', d, 'SKILL.md'))) : []);
  const installed = (s: string) => fs.existsSync(path.join(config.skillsDir, s, 'SKILL.md'));

  async function facts(): Promise<SetupFacts> {
    const repoPath = config.repo.path;
    const [repo, gh, plugins] = await Promise.all([
      repoPath ? exec('git', ['-C', repoPath, 'rev-parse', '--git-dir']) : { ok: false },
      exec('gh', ['auth', 'status']),
      exec('paseo', ['plugin', 'ls', '--json'], { env: launcherEnv() }),
    ]);
    let plugin: SetupFacts['plugin'] = null;
    try {
      const installedPlugins: { id: string; path: string; enabled: boolean }[] = JSON.parse(plugins.stdout);
      const p = installedPlugins.find((x) => x.id === 'cocopilot');
      if (p) plugin = { path: real(p.path), enabled: p.enabled };
    } catch {}
    const shippedSkills = shipped();
    // an overridden skill only has to exist; it is the user's on purpose, never compared with the shipped one
    const overridden = (s: string) => s in (config.skillOverrides || {}) || skillFor(config, s) !== s;
    return {
      config: fs.existsSync(configFile),
      repoPath,
      repo: repo.ok,
      gh: gh.ok,
      paseo: plugins.ok,
      plugin,
      pluginSource: real(path.join(APP, 'paseo-plugin')),
      shippedSkills,
      missingSkills: shippedSkills.map((s) => skillFor(config, s)).filter((s) => !installed(s)),
      changedSkills: shippedSkills.filter((s) => !overridden(s) && installed(s) && !sameSkill(path.join(APP, 'skills', s), path.join(config.skillsDir, s))),
      personas: personaCount(),
      works: works.list().length,
    };
  }

  async function status() {
    const steps = setupSteps(await facts(), { APP, skillsDir: config.skillsDir });
    const restart = fs.existsSync(configFile) && fs.statSync(configFile).mtimeMs > STARTED;
    return { steps, done: steps.every((s) => s.done || s.optional), restart, guide: path.join(APP, 'docs/setup.md') };
  }

  async function startAgent() {
    const { steps, guide } = await status();
    const todo = steps.filter((s) => !s.done && s.id !== 'work').map((s) => `- ${s.label}${s.hint ? `: ${s.hint}` : ''}`);
    const prompt = [`Finish setting up cocopilot by following ${guide}. cocopilot is already cloned in ${APP} and its server runs: treat it as an existing install.`, todo.length ? `Still open:\n${todo.join('\n')}` : 'Every step is ticked: only check the result.'].join('\n\n');
    const { agentId, createdWorkspace } = await agents.start({ title: 'Set up cocopilot', provider: config.models.default, thinking: 'high', cwd: APP, labels: { source: 'cocopilot', kind: 'setup' }, prompt });
    return { agentId, createdWorkspace };
  }

  async function handle(req: Req, res: Res, parts: string[], _readBody: ReadBody, send: Send) {
    if (req.method === 'POST' && parts[1] === 'agent') return send(res, 200, await startAgent());
    if (req.method === 'GET' && !parts[1]) return send(res, 200, await status());
    return send(res, 404, { error: 'no route' });
  }
  return { handle, status };
}
