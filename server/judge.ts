// The judge: one seam for coco's small no-tool decisions. It runs on models.judge, falls back to models.fast when that model fails
// or answers nothing parseable, and logs each answer to data/judge-log.jsonl, so a smaller or local model can be graded before it takes over.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from './core-types.ts';
import type { Config } from './config.ts';

type RunOpts = { title: string; prompt: string; provider: string; labels: Record<string, unknown>; workspaceId: string; cwd: string; timeoutMs: number };
type RunOut = { status: string; error?: string | null; finalText: string };
export type Ask<T> = Omit<RunOpts, 'provider'> & { kind: string; parse: (text: string) => T | null };
export type Decision = { at: string; kind: string; model: string; input: string; output: unknown; ms: number; error?: string };
export type Judge = { decide<T>(ask: Ask<T>): Promise<T> };

export const judgeModels = (models: Config['models']) => [...new Set([models.judge || models.fast || models.default, models.fast || models.default])];

export function createJudge({ DATA, config, agents, now = Date.now }: { DATA: string; config: Pick<Config, 'models'>; agents: { run(opts: RunOpts): Promise<RunOut> }; now?: () => number }): Judge {
  const logFile = path.join(DATA, 'judge-log.jsonl');
  const log = (d: Decision) => {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify(d) + '\n');
  };

  async function decide<T>({ kind, parse, ...run }: Ask<T>): Promise<T> {
    const input = crypto.createHash('sha256').update(run.prompt).digest('hex').slice(0, 16);
    let error = '';
    for (const model of judgeModels(config.models)) {
      const start = now();
      const out: RunOut = await agents.run({ ...run, provider: model }).catch((e: unknown) => ({ status: 'error', error: errorMessage(e), finalText: '' }));
      const output = out.status === 'done' ? parse(out.finalText) : null;
      error = output !== null ? '' : out.status === 'done' ? `${model} answered nothing parseable` : out.error || `${model} ended ${out.status}`;
      log({ at: new Date(start).toISOString(), kind, model, input, output, ms: now() - start, ...(error ? { error } : {}) });
      if (output !== null) return output;
    }
    throw new Error(error);
  }

  return { decide };
}
