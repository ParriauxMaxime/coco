// a stack row key: a PR number, or `b:<branch with / as :>` for a local branch
const KEY = '(\\d+|b:[\\w][\\w.:-]*)';
const toKey = (s) => (/^\d+$/.test(s) ? Number(s) : s);

export const isLocalKey = (k) => String(k).startsWith('b:');
export const keyLabel = (k) => (isLocalKey(k) ? String(k).slice(2).replaceAll(':', '/') : `#${k}`);

export const parseCodeTab = (id) => {
  const m = new RegExp(`^(diff|file)-${KEY}~(.+)$`).exec(id || '');
  return m ? { kind: m[1], n: toKey(m[2]), path: m[3] } : null;
};

export const reviewKeyOfTab = (id) => {
  const m = new RegExp(`^review-${KEY}$`).exec(id || '');
  return m ? toKey(m[1]) : null;
};

export const findingsKeyOfTab = (id) => {
  const m = new RegExp(`^findings-${KEY}$`).exec(id || '');
  return m ? toKey(m[1]) : null;
};

export const prOfTab = (id) => {
  const code = parseCodeTab(id);
  if (code) return code.n;
  const m = new RegExp(`^(?:review|pr)-${KEY}$`).exec(id || '');
  return m ? toKey(m[1]) : null;
};

export const codeTabId = (n, path, files = []) => `${files.some((f) => f.filename === path) ? 'diff' : 'file'}-${n}~${path}`;

export const baseName = (path) => path.split('/').pop();
