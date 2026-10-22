// Feature flags a PR needs switched on to be tested: the work lists them (`betaFlags: [{ code, why, prs? }]`), and an optional
// provider module (config.featureFlags.provider) tells what the repo says about each: createFeatureFlags({ config, REPO }) → { forRow, known }.
import { pathToFileURL } from 'node:url';

const NONE = { forRow: () => [], known: () => new Map() };

export function createFeatureFlags({ config, REPO }) {
  const file = config?.featureFlags?.provider;
  if (!file) return { ...NONE, ready: Promise.resolve() };
  let impl = NONE;
  const ready = import(pathToFileURL(file).href)
    .then((m) => (impl = m.createFeatureFlags({ config, REPO })))
    .catch((e) => console.error(`feature flags provider ${file}: ${e.message}`));
  return { forRow: (...a) => impl.forRow(...a), known: (...a) => impl.known(...a), ready };
}
