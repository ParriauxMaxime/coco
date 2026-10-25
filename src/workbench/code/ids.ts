import type { PrKey, RefFile } from '../types.ts';

// a stack row key: a PR number, or `b:<branch with / as :>` for a local branch
const KEY = '(\\d+|b:[\\w][\\w.:-]*)';
const toKey = (s: string): PrKey => (/^\d+$/.test(s) ? Number(s) : s);

export const isLocalKey = (k: PrKey) => String(k).startsWith('b:');
export const keyLabel = (k: PrKey) => (isLocalKey(k) ? String(k).slice(2).replaceAll(':', '/') : `#${k}`);

export const parseCodeTab = (id: string | null | undefined) => {
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

export const codeTabId = (n: PrKey, path: string, files: Pick<RefFile, 'filename'>[] = []) => `${files.some((f) => f.filename === path) ? 'diff' : 'file'}-${n}~${path}`;

export const baseName = (path: string) => path.split('/').pop() ?? path;
