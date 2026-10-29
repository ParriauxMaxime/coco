import type { PrKey, RefFile } from '../types.ts';

// a stack row key: a PR number, or `b:<branch with / as :>` for a local branch
const KEY = '(\\d+|b:[\\w][\\w.:-]*)';
const toKey = (s: string): PrKey => (/^\d+$/.test(s) ? Number(s) : s);

export const isLocalKey = (k: PrKey) => String(k).startsWith('b:');
export const keyLabel = (k: PrKey) => (isLocalKey(k) ? String(k).slice(2).replaceAll(':', '/') : `#${k}`);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// a tab id naming row `from` (as `-<key>` or in a thread key `c.<file key>.`) names `to` instead
export const rekeyTab = (id: string, from: string, to: string) =>
  id.replace(new RegExp(`-${esc(from)}(?=$|~)`), `-${to}`).replace(new RegExp(`([cp]\\.)${esc(from.replaceAll(':', '~'))}(?=$|[.~])`), `$1${to}`);

export const parseCodeTab =(id: string | null | undefined) => {
  const m = new RegExp(`^(diff|file)-${KEY}~(.+)$`).exec(id || '');
  return m ? { kind: m[1] === 'diff' ? 'diff' : 'file', n: toKey(m[2]), path: m[3] } : null;
};

export const reviewKeyOfTab = (id: string | null | undefined) => {
  const m = new RegExp(`^review-${KEY}$`).exec(id || '');
  return m ? toKey(m[1]) : null;
};

export const findingsKeyOfTab = (id: string | null | undefined) => {
  const m = new RegExp(`^findings-${KEY}$`).exec(id || '');
  return m ? toKey(m[1]) : null;
};

export const prOfTab = (id: string | null | undefined) => {
  const code = parseCodeTab(id);
  if (code) return code.n;
  const m = new RegExp(`^(?:review|pr)-${KEY}$`).exec(id || '');
  return m ? toKey(m[1]) : null;
};

// an agent's suggested commit: `commit-<thread key>~<message id>`
export const commitTabId = (threadKey: string, msgId: string) => `commit-${threadKey}~${msgId}`;
export const parseCommitTab = (id: string | null | undefined) => {
  const m = /^commit-(.+)~([0-9a-f]+)$/.exec(id || '');
  return m ? { threadKey: m[1], msgId: m[2] } : null;
};

// a commit of an agent's workspace (its Changes panel): `gitcommit-<workspace id>~<sha>`; a workspace's Changes panel: `git-<workspace id>`
export const workspaceCommitTabId = (wsId: string, sha: string) => `gitcommit-${wsId}~${sha}`;
export const parseWorkspaceCommitTab = (id: string | null | undefined) => {
  const m = /^gitcommit-([\w.-]+)~([0-9a-f]{7,40})$/.exec(id || '');
  return m ? { wsId: m[1], sha: m[2] } : null;
};
export const changesTabId = (wsId: string) => `git-${wsId}`;
export const parseChangesTab = (id: string | null | undefined) => /^git-([\w.-]+)$/.exec(id || '')?.[1] ?? null;
// a file of a workspace (its Files view) in its own tab: `wsfile-<workspace id>~<path>`
export const wsFileTabId = (wsId: string, path: string) => `wsfile-${wsId}~${path}`;
export const parseWsFileTab = (id: string | null | undefined) => {
  const m = /^wsfile-([\w.-]+)~(.+)$/.exec(id || '');
  return m ? { wsId: m[1], path: m[2] } : null;
};
// a workspace's terminals and scripts: `term-<workspace id>`
export const terminalTabId = (wsId: string) => `term-${wsId}`;
export const parseTerminalTab = (id: string | null | undefined) => /^term-([\w.-]+)$/.exec(id || '')?.[1] ?? null;

export const codeTabId =(n: PrKey, path: string, files: Pick<RefFile, 'filename'>[] = []) => `${files.some((f) => f.filename === path) ? 'diff' : 'file'}-${n}~${path}`;

export const baseName = (path: string) => path.split('/').pop() ?? path;
