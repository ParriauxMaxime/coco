// A planned row got its PR: what a work keeps on disk under the row's branch key moves to the number.
// Files an agent was handed by absolute path (thread replies and cards, review run briefs and results) keep their name and path.
import fs from 'node:fs';
import path from 'node:path';
import { fileKey } from './stack.ts';
import type { RowKey } from './core-types.ts';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// a JSON value with every `from` key, and every thread key on it, naming `to`
export function rekeyValue<T>(value: T, from: RowKey, to: RowKey): T {
  const thread = new RegExp(`^([cp])\\.${esc(fileKey(from))}(?=\\.|$)`);
  const walk = (v: unknown): unknown => {
    if (v === from) return to;
    if (typeof v === 'string') return v.replace(thread, `$1.${fileKey(to)}`);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export function rekeyWorkFiles(DATA: string, slug: string, from: RowKey, to: RowKey) {
  const root = path.join(DATA, 'works', slug);
  const f = esc(fileKey(from));
  const t = fileKey(to);
  // the files named after the row, by folder: [pattern, rewrite the JSON inside]
  const named: Record<string, [RegExp, boolean][]> = {
    comments: [[new RegExp(`^pr-${f}(\\.json)$`), true]],
    reviews: [[new RegExp(`^pr-${f}(-plan\\.json|-plan-context\\.json|-run-[\\w-]+(?<!-result)\\.json)$`), true]],
    threads: [[new RegExp(`^([cp])\\.${f}((?:\\.[0-9a-f]+)?\\.json)$`), true], [new RegExp(`^([cp])\\.${f}((?:\\.[0-9a-f]+)?\\.activity\\.jsonl)$`), false]],
    'artifacts/briefs': [[new RegExp(`^pr-${f}(-\\d{4}-\\d{2}-\\d{2}.*\\.md)$`), false]],
  };
  const rewrite = (file: string) => {
    const text = fs.readFileSync(file, 'utf8');
    const next = JSON.stringify(rekeyValue(JSON.parse(text), from, to), null, 1);
    if (next !== JSON.stringify(JSON.parse(text), null, 1)) fs.writeFileSync(file, next);
  };
  for (const [sub, rules] of Object.entries(named)) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      for (const [re, json] of rules) {
        const m = re.exec(name);
        if (!m) continue;
        const target = path.join(dir, m.length > 2 ? `${m[1]}.${t}${m[2]}` : `pr-${t}${m[1]}`);
        if (fs.existsSync(target)) break;
        fs.renameSync(path.join(dir, name), target);
        if (json) rewrite(target);
        break;
      }
    }
  }
  // what names the row inside: groups and their commit turns, stack runs, kit pieces
  for (const sub of ['groups', 'reviews']) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) if (sub === 'groups' ? name.endsWith('.json') : /^stack-run-.+\.json$/.test(name)) rewrite(path.join(dir, name));
  }
  const meta = path.join(root, 'artifacts', '.meta.json');
  if (fs.existsSync(meta)) {
    const all: Record<string, { pr?: string | number | null }> = JSON.parse(fs.readFileSync(meta, 'utf8'));
    for (const m of Object.values(all)) if (m.pr != null && String(m.pr) === String(from)) m.pr = String(to);
    fs.writeFileSync(meta, JSON.stringify(all, null, 1));
  }
  fs.rmSync(path.join(root, 'findings-cache'), { recursive: true, force: true });
}
