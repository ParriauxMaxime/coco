// Settings: defaults below, overlaid by the JSON at $COCO_CONFIG or <app>/coco.config.json (gitignored).
// Values that point at code (featureFlags.provider) are paths to local ES modules, so team-specific logic stays out of this repo.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const HOME = os.homedir();
const home = (p: string) => (typeof p === 'string' && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

export interface Ritual {
  kind: string;
  label?: string;
  hint?: string;
  fields?: string[];
  title?: string;
  prompt: string;
  // 'repo' (default): runs in the repo's coco workspace; 'global': not about one repo, runs in the global coco workspace
  scope?: 'repo' | 'global';
}

export interface FileLayers {
  wiring?: [string, string][];
  layers?: [string, string][];
  other?: [string, string][];
}

export type RepoIdentity = { path: string; github: string; defaultBranch: string; tsconfig: string; rules: string[]; reviewsDir: string; commitConvention: string };
// settings that belong to a repo; one left out falls back to the top-level value
export const REPO_SETTINGS = ['gateSkills', 'kitKinds', 'fileLayers', 'seedRules', 'featureFlags', 'importRoots', 'botGroups', 'kitBody'] as const;
export type RepoSettings = Partial<Pick<Config, (typeof REPO_SETTINGS)[number]>>;
export type RepoConfig = RepoIdentity & { id: string; name: string; settings: RepoSettings };

export interface Config {
  owner: { name: string; login: string };
  // the default repo: the first of `repos`
  repo: RepoIdentity;
  repos: RepoConfig[];
  baseUrl: string;
  dataDir: string;
  briefsDir: string;
  skillsDir: string;
  skillPrefix: string;
  methodSkill: string;
  methodNotes: string;
  skillOverrides: Record<string, string>;
  personasDir: string;
  personaFiles: { ignore: string[]; companionSuffixes: string[] };
  kitBody: { maxChars: number; mustMatch: string };
  models: { default: string; fast: string };
  importRoots: string[];
  kitKinds: string[];
  gateSkills: Record<string, (string | { name: string; ask?: string })[]>;
  fileLayers: FileLayers | null;
  botGroups: Record<string, string>;
  seedRules: [string, string?][];
  rituals: Ritual[];
  featureFlags: { provider?: string } | null;
  // where a repo added by its GitHub slug is looked for, then cloned; empty: the folder holding the default repo's clone
  cloneDir: string;
  devServers?: { api?: { bind?: string; port?: number } };
  file?: string | null;
}

export const DEFAULTS: Config = {
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
  repos: [],
  baseUrl: 'http://127.0.0.1:8777',
  dataDir: '',
  briefsDir: path.join(os.tmpdir(), 'cocopilot-handoffs'),
  skillsDir: '~/.claude/skills',
  skillPrefix: '',
  methodSkill: '',
  methodNotes: '',
  // shipped skill → your skill that replaces it; the same name keeps your edited copy of the shipped one
  skillOverrides: {},
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
  cloneDir: '',
};

export const skillFor = (config: Partial<Pick<Config, 'skillOverrides' | 'methodSkill'>> | null | undefined, name: string): string => config?.skillOverrides?.[name] || (name === 'coco-work' && config?.methodSkill) || name;

export const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
export const merge = (base: unknown, over: unknown): unknown => {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
};

export function loadConfig({ APP, file = process.env.COCO_CONFIG || path.join(APP, 'coco.config.json') }: { APP: string; file?: string }): Config {
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const c = merge(DEFAULTS, raw) as Config;
  c.repo.path = home(process.env.COCO_REPO || c.repo.path);
  // outside the checkout so a `git clean` cannot take the works; `<app>/data` stays for installs that already have it
  const legacyData = path.join(APP, 'data');
  c.dataDir = home(process.env.COCO_DATA || c.dataDir || (fs.existsSync(legacyData) ? legacyData : '~/.cocopilot/data'));
  c.skillsDir = home(c.skillsDir);
  c.personasDir = home(c.personasDir || path.join(c.dataDir, 'personas'));
  c.briefsDir = home(c.briefsDir);
  c.importRoots = c.importRoots.map(home);
  if (c.featureFlags?.provider) c.featureFlags.provider = home(c.featureFlags.provider);
  c.file = fs.existsSync(file) ? file : null;
  c.repos = loadRepos(c, raw, APP);
  const { id: _id, name: _name, settings: _settings, ...first } = c.repos[0];
  c.repo = first;
  c.cloneDir = home(c.cloneDir) || path.dirname(first.path || APP);
  return c;
}

const identify = (r: RepoIdentity) => {
  r.path = home(r.path);
  if (!r.path) return r;
  r.github ||= sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], r.path);
  r.defaultBranch ||= sh('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], r.path).replace(/^origin\//, '') || 'main';
  return r;
};
export const repoId = (p: string, used: Set<string>) => {
  const base = path.basename(p || 'repo').toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'repo';
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  used.add(id);
  return id;
};

// `repos` from the config, else the single `repo` of older configs; coco's own folder always closes the list, as the repo the global Ask coco runs in
function loadRepos(c: Config, raw: { repos?: (Partial<RepoConfig> & { path: string })[] }, APP: string): RepoConfig[] {
  const used = new Set<string>();
  const listed = Array.isArray(raw.repos) && raw.repos.length ? raw.repos : [{ ...c.repo, path: process.env.COCO_REPO || c.repo.path }];
  const repos = listed.map((r): RepoConfig => {
    const ident = identify({ ...DEFAULTS.repo, ...r } as RepoIdentity);
    return { id: r.id || repoId(ident.path, used), name: r.name || path.basename(ident.path || 'repo'), ...ident, settings: r.settings || {} };
  });
  for (const r of repos) used.add(r.id);
  if (!repos.some((r) => r.path && path.resolve(r.path) === path.resolve(APP))) {
    repos.push({ ...identify({ ...DEFAULTS.repo, path: APP }), id: used.has('cocopilot') ? repoId(APP, used) : 'cocopilot', name: 'cocopilot', settings: {} });
  }
  return repos;
}

// a repo's value for a repo-shaped setting, the top-level one when the repo has none
export const repoSetting = <K extends (typeof REPO_SETTINGS)[number]>(config: Config, repo: RepoConfig | null | undefined, key: K): Config[K] => (repo?.settings[key] ?? config[key]) as Config[K];

export function personaLogins(files: string[], { ignore = [], companionSuffixes = [] }: { ignore?: string[]; companionSuffixes?: string[] } = {}): string[] {
  const companion = companionSuffixes.length ? new RegExp(`-(${companionSuffixes.join('|')})\\.md$`) : null;
  return files
    .filter((f) => f.endsWith('.md') && !companion?.test(f))
    .map((f) => f.replace(/\.md$/, ''))
    .filter((n) => !ignore.includes(n));
}

export type RepoEntry = Partial<RepoConfig> & { id: string; name: string; path: string };

const skipString = (t: string, i: number) => {
  for (i++; i < t.length; i++) {
    if (t[i] === '\\') i++;
    else if (t[i] === '"') return i + 1;
  }
  return i;
};
const valueEnd = (t: string, i: number) => {
  if (t[i] === '"') return skipString(t, i);
  if (t[i] !== '{' && t[i] !== '[') return i + (/^[^,}\]\s]*/.exec(t.slice(i))?.[0].length || 0);
  for (let depth = 0; i < t.length; i++) {
    if (t[i] === '"') i = skipString(t, i) - 1;
    else if (t[i] === '{' || t[i] === '[') depth++;
    else if ((t[i] === '}' || t[i] === ']') && --depth === 0) return i + 1;
  }
  return i;
};
// where the value of a top-level key sits in JSON text, [start, end)
const topLevelSpan = (t: string, key: string): [number, number] | null => {
  let i = t.indexOf('{') + 1;
  while (i > 0 && i < t.length) {
    while (/[\s,]/.test(t[i] || '')) i++;
    if (t[i] !== '"') return null;
    const end = skipString(t, i);
    const k = JSON.parse(t.slice(i, end));
    i = t.indexOf(':', end) + 1;
    while (/\s/.test(t[i] || '')) i++;
    const v = valueEnd(t, i);
    if (k === key) return [i, v];
    i = v;
  }
  return null;
};
const inline = (v: unknown): string => (Array.isArray(v) ? `[${v.map(inline).join(', ')}]` : isObject(v) ? (Object.keys(v).length ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}') : JSON.stringify(v));

// the config file's text with `entry` appended to `repos`, every other key and line kept as written; a config with only `repo` gets `repos` listing `first` (that repo) ahead, so it stays the default
export function withRepo(text: string, entry: RepoEntry, first: RepoEntry | null): string {
  const raw = text.trim() ? JSON.parse(text) : {};
  const listed = Array.isArray(raw.repos) && raw.repos.length > 0;
  const seed = listed || !first ? [] : [{ ...first, ...(isObject(raw.repo) ? raw.repo : {}) }];
  const added = [...seed, entry];
  const expected = { ...raw, repos: [...(listed ? raw.repos : []), ...added] };
  const indent = /\n([ \t]+)"/.exec(text)?.[1] || '  ';
  const items = (list: unknown[]) => list.map((v) => `\n${indent}${indent}${inline(v)}`).join(',');
  let out = '';
  const span = text.trim() ? topLevelSpan(text, 'repos') : null;
  if (span && Array.isArray(raw.repos)) {
    const [s, e] = span;
    const inner = text.slice(s + 1, e - 1);
    out = listed ? `${text.slice(0, s + 1)}${inner.replace(/\s*$/, '')},${items(added)}\n${indent}]${text.slice(e)}` : `${text.slice(0, s)}[${items(added)}\n${indent}]${text.slice(e)}`;
  } else if (text.trim() && !('repos' in raw)) {
    const close = text.lastIndexOf('}');
    const before = text.slice(0, close).replace(/\s*$/, '');
    out = `${before}${before.endsWith('{') ? '' : ','}\n${indent}"repos": [${items(added)}\n${indent}]\n${text.slice(close)}`;
  }
  try {
    if (out && isDeepStrictEqual(JSON.parse(out), expected)) return out;
  } catch {}
  return `${JSON.stringify(expected, null, 2)}\n`;
}

// written to a temporary file then renamed, so a crash never leaves half a config
export function addRepoToConfigFile(file: string, entry: RepoEntry, first: RepoEntry | null) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const out = withRepo(text, entry, first);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
}

function sh(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}
