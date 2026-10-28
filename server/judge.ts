// The judge: one seam for coco's small no-tool decisions. It runs on models.judge, falls back to models.fast when that model fails
// or answers nothing parseable, and logs each answer to data/judge-log.jsonl, so a smaller or local model can be graded before it takes over.
// models.judgeShadow answers the same prompt in the background, logged and never acted on; a decision the user later undoes
// (a dropped lesson) is labelled in data/judge-labels.jsonl. stats() sums both per kind and model.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from './core-types.ts';
import type { Config } from './config.ts';

type RunOpts = { title: string; prompt: string; provider: string; labels: Record<string, unknown>; workspaceId: string; cwd: string; timeoutMs: number; mcp?: boolean };
type RunOut = { status: string; error?: string | null; finalText: string };
export type Ask<T> = Omit<RunOpts, 'provider' | 'mcp'> & { kind: string; repo?: string; parse: (text: string) => T | null };
export type Decision = { id: string; at: string; kind: string; repo?: string; model: string; shadowOf?: string; input: string; output: unknown; ms: number; error?: string };
type Label = { at: string; decision: string; dropped: string };
export type JudgeStat = { kind: string; model: string; role: 'judge' | 'shadow'; decisions: number; failed: number; items: number; dropped: number; agree: number };
export type Judge = {
  decide<T>(ask: Ask<T>): Promise<{ output: T; id: string }>;
  drop(decision: string, text: string): void;
  stats(repo?: string): JudgeStat[];
  settled(): Promise<void>;
};

export const judgeModels = (models: Config['models']) => [...new Set([models.judge || models.fast || models.default, models.fast || models.default])];

const readJsonl = <T>(file: string): T[] => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
};

// the same call: a list judged empty or not by both, anything else equal as JSON
export const sameCall = (a: unknown, b: unknown) => (Array.isArray(a) && Array.isArray(b) ? !a.length === !b.length : JSON.stringify(a) === JSON.stringify(b));

export function createJudge({ DATA, config, agents, now = Date.now }: { DATA: string; config: Pick<Config, 'models'>; agents: { run(opts: RunOpts): Promise<RunOut> }; now?: () => number }): Judge {
  const logFile = path.join(DATA, 'judge-log.jsonl');
  const labelsFile = path.join(DATA, 'judge-labels.jsonl');
  const append = (file: string, entry: unknown) => {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  };
  const pending = new Set<Promise<unknown>>();

  async function attempt<T>(model: string, { kind, repo, parse, ...run }: Ask<T>, input: string, shadowOf?: string) {
    const start = now();
    const out: RunOut = await agents.run({ ...run, provider: model, mcp: false }).catch((e: unknown) => ({ status: 'error', error: errorMessage(e), finalText: '' }));
    const output = out.status === 'done' ? parse(out.finalText) : null;
    const error = output !== null ? '' : out.status === 'done' ? `${model} answered nothing parseable` : out.error || `${model} ended ${out.status}`;
    const id = crypto.randomBytes(4).toString('hex');
    append(logFile, { id, at: new Date(start).toISOString(), kind, ...(repo ? { repo } : {}), model, ...(shadowOf ? { shadowOf } : {}), input, output, ms: now() - start, ...(error ? { error } : {}) } satisfies Decision);
    return { id, output, error };
  }

  async function decide<T>(ask: Ask<T>) {
    const input = crypto.createHash('sha256').update(ask.prompt).digest('hex').slice(0, 16);
    const models = judgeModels(config.models);
    let error = '';
    for (const model of models) {
      const tried = await attempt(model, ask, input);
      if (tried.output === null) {
        error = tried.error;
        continue;
      }
      const shadow = config.models.judgeShadow;
      if (shadow && !models.includes(shadow)) {
        const p = attempt(shadow, { ...ask, title: `${ask.title} · shadow` }, input, tried.id).catch((e) => console.error(`judge shadow ${shadow}: ${errorMessage(e)}`));
        pending.add(p);
        void p.finally(() => pending.delete(p));
      }
      return { output: tried.output, id: tried.id };
    }
    throw new Error(error);
  }

  const drop = (decision: string, text: string) => append(labelsFile, { at: new Date(now()).toISOString(), decision, dropped: text } satisfies Label);

  function stats(repo?: string): JudgeStat[] {
    const log = readJsonl<Decision>(logFile).filter((d) => !repo || d.repo === repo);
    const byId = new Map(log.map((d) => [d.id, d]));
    const dropped = new Map<string, number>();
    for (const l of readJsonl<Label>(labelsFile)) dropped.set(l.decision, (dropped.get(l.decision) || 0) + 1);
    const rows = new Map<string, JudgeStat>();
    for (const d of log) {
      const role = d.shadowOf ? 'shadow' : 'judge';
      const key = `${d.kind} ${d.model} ${role}`;
      const row = rows.get(key) || { kind: d.kind, model: d.model, role, decisions: 0, failed: 0, items: 0, dropped: 0, agree: 0 };
      row.decisions++;
      if (d.error) row.failed++;
      if (Array.isArray(d.output)) row.items += d.output.length;
      row.dropped += dropped.get(d.id) || 0;
      const main = d.shadowOf ? byId.get(d.shadowOf) : null;
      if (main && !d.error && sameCall(main.output, d.output)) row.agree++;
      rows.set(key, row);
    }
    return [...rows.values()];
  }

  return { decide, drop, stats, settled: async () => void (await Promise.all(pending)) };
}
