// Settings: defaults below, overlaid by the JSON at $COCO_CONFIG or <app>/coco.config.json (gitignored).
// Values that point at code (featureFlags.provider) are paths to local ES modules, so team-specific logic stays out of this repo.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const home = (p) => (typeof p === 'string' && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

export const DEFAULTS = {
  owner: { name: 'the user', login: 'me' },
  repo: {
    path: '',
    github: '',
    defaultBranch: '',
    tsconfig: 'tsconfig.json',
    rules: ['AGENTS.md', 'CLAUDE.md'],
    reviewsDir: '.claude/reviews',
    commitConvention: '',
  },
  baseUrl: 'http://127.0.0.1:8777',
  dataDir: '',
  briefsDir: path.join(os.tmpdir(), 'cocopilot-handoffs'),
  skillsDir: '~/.claude/skills',
  skillPrefix: '',
  methodSkill: '',
  methodNotes: '',
  personasDir: '',
  // files in personasDir that are not personas: exact names, and `<login>-<suffix>.md` companions of a persona
  personaFiles: { ignore: ['README', 'CHANGELOG'], companionSuffixes: [] },
  kitBody: { maxChars: 0, mustMatch: '' },
  models: { default: 'claude/claude-opus-5-5', fast: 'claude/claude-sonnet-5-5' },
  importRoots: ['/tmp', '/private/tmp', '~/.paseo/worktrees'],
  kitKinds: ['body', 'diagram', 'video'],
  gateSkills: { 'self-review': [], history: [], 'kit-body': [], 'kit-diagram': [], 'kit-video': [], 'review-pr': [] },
  fileLayers: null,
  botGroups: { sentry: 'sentry' },
  seedRules: [],
  // [{ kind, label, hint, fields: ['login'|'pr'|'paths'|'text'], title, prompt }]; title and prompt fill {field}, {a|b}, {briefsDir}, {owner}
  rituals: [],
  featureFlags: null,
};

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const merge = (base, over) => {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
};

export function loadConfig({ APP, file = process.env.COCO_CONFIG || path.join(APP, 'coco.config.json') } = {}) {
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const c = merge(DEFAULTS, raw);
  c.repo.path = home(process.env.COCO_REPO || c.repo.path);
  c.dataDir = home(process.env.COCO_DATA || c.dataDir || path.join(APP, 'data'));
  c.skillsDir = home(c.skillsDir);
  c.personasDir = home(c.personasDir || path.join(c.dataDir, 'personas'));
  c.briefsDir = home(c.briefsDir);
  c.importRoots = c.importRoots.map(home);
  if (c.featureFlags?.provider) c.featureFlags.provider = home(c.featureFlags.provider);
  c.file = fs.existsSync(file) ? file : null;
  if (c.repo.path) {
    c.repo.github ||= sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], c.repo.path);
    c.repo.defaultBranch ||= sh('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], c.repo.path).replace(/^origin\//, '') || 'main';
  }
  return c;
}

export function personaLogins(files, { ignore = [], companionSuffixes = [] } = {}) {
  const companion = companionSuffixes.length ? new RegExp(`-(${companionSuffixes.join('|')})\\.md$`) : null;
  return files
    .filter((f) => f.endsWith('.md') && !companion?.test(f))
    .map((f) => f.replace(/\.md$/, ''))
    .filter((n) => !ignore.includes(n));
}

function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}
