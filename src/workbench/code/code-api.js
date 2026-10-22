const json = async (res) => {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
};

const base = (n) => `/api/code/pr/${n}`;
const qs = (params) => new URLSearchParams(params).toString();

export const codeApi = {
  refs: (n, fresh) => fetch(`${base(n)}/refs${fresh ? '?fresh=1' : ''}`).then(json),
  file: (n, ref, path) => fetch(`${base(n)}/file?${qs({ ref, path })}`).then(json),
  tree: (n, ref = 'head') => fetch(`${base(n)}/tree?${qs({ ref })}`).then(json),
  diff: (n, path, previous) => fetch(`${base(n)}/diff?${qs(previous ? { path, previous } : { path })}`).then(json),
  search: (n, q) => fetch(`${base(n)}/search?${qs({ q })}`).then(json),
};

export const isDesktop = () => typeof matchMedia === 'function' && matchMedia('(min-width: 900px) and (pointer: fine)').matches;

export const loadMonaco = () => import('./monaco.js');
