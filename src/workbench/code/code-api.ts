import type { PrKey } from '../types.ts';

const json = async (res: Response) => {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
};

const base = (n: PrKey) => `/api/code/pr/${n}`;
const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const codeApi = {
  refs: (n: PrKey, fresh?: boolean) => fetch(`${base(n)}/refs${fresh ? '?fresh=1' : ''}`).then(json),
  file: (n: PrKey, ref: string, path: string) => fetch(`${base(n)}/file?${qs({ ref, path })}`).then(json),
  tree: (n: PrKey, ref = 'head') => fetch(`${base(n)}/tree?${qs({ ref })}`).then(json),
  diff: (n: PrKey, path: string, previous?: string) => fetch(`${base(n)}/diff?${qs(previous ? { path, previous } : { path })}`).then(json),
  search: (n: PrKey, q: string) => fetch(`${base(n)}/search?${qs({ q })}`).then(json),
};

export const isDesktop = () => typeof matchMedia === 'function' && matchMedia('(min-width: 900px) and (pointer: fine)').matches;

export const loadMonaco = () => import('./monaco.ts');
