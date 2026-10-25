// Feature flags a PR needs switched on to be tested: the work lists them (`betaFlags: [{ code, why, prs? }]`), and an optional
// provider module (config.featureFlags.provider) tells what the repo says about each: createFeatureFlags({ config, REPO }) → { forRow, known }.
import { pathToFileURL } from 'node:url';
import type { Config } from './config.ts';

export interface FeatureFlag {
  code: string;
  name?: string;
  why?: string;
  enable?: string;
  [key: string]: unknown;
}

export interface FeatureFlags {
  forRow: (work: Record<string, unknown>, key: string | number | null) => FeatureFlag[];
  known: (...args: unknown[]) => Map<string, unknown>;
}

const NONE: FeatureFlags = { forRow: () => [], known: () => new Map() };

export function createFeatureFlags({ config, REPO }: { config?: Partial<Config> | null; REPO: string }): FeatureFlags & { ready: Promise<unknown> } {
  const file = config?.featureFlags?.provider;
  if (!file) return { ...NONE, ready: Promise.resolve() };
  let impl = NONE;
  const ready = import(pathToFileURL(file).href)
    .then((m) => (impl = m.createFeatureFlags({ config, REPO }) as FeatureFlags))
    .catch((e: Error) => console.error(`feature flags provider ${file}: ${e.message}`));
  return { forRow: (...a) => impl.forRow(...a), known: (...a) => impl.known(...a), ready };
}
