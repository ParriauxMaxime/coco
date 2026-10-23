import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderValue, type ProjectConfig } from "./config.ts";
import { errnoOf, isUnder } from "./proc.ts";
import { writeJsonAtomic } from "./store.ts";

export type JsonObject = { [key: string]: unknown };

export type SettingsContext = {
  project: string;
  worktree: string;
  appDir: string;
  file: string;
  port: number;
  logDir: string;
  services: string[];
  dedicatedDb: boolean;
  base: JsonObject;
};

export type Provider = { settingsOverlay?: (ctx: SettingsContext) => unknown };

export class SettingsError extends Error {}

export type SettingsRequest = { id: string; project: ProjectConfig; worktree: string; port: number; logDir: string; services: string[]; dedicatedDb: boolean };
export type SettingsOutcome = { file: string; folded?: { backup: string } };

type Ledger = { worktree: string; file: string; existed: boolean; generated: string | null };

const isObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const asText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// Objects merge key by key; anything else, null included, replaces.
export function deepMerge(target: JsonObject, source: JsonObject): JsonObject {
  const output: JsonObject = { ...target };
  for (const [key, value] of Object.entries(source)) output[key] = isObject(value) && isObject(output[key]) ? deepMerge(output[key], value) : value;
  return output;
}

// Replays on the base what a hand edit changed in the generated file: added or changed keys are copied, removed keys are dropped.
export function foldEdit(base: JsonObject, generated: JsonObject, edited: JsonObject): JsonObject {
  const output: JsonObject = { ...base };
  for (const key of new Set([...Object.keys(generated), ...Object.keys(edited)])) {
    if (!(key in edited)) delete output[key];
    else if (!(key in generated)) output[key] = edited[key];
    else if (isObject(generated[key]) && isObject(edited[key])) {
      const inner = foldEdit(isObject(base[key]) ? base[key] : {}, generated[key], edited[key]);
      if (key in base || Object.keys(inner).length) output[key] = inner;
    } else if (!sameJson(generated[key], edited[key])) output[key] = edited[key];
  }
  return output;
}

const providers = new Map<string, Promise<Provider>>();

export const loadProvider = (file: string): Promise<Provider> => {
  let loaded = providers.get(file);
  if (!loaded) {
    loaded = import(pathToFileURL(file).href) as Promise<Provider>;
    providers.set(file, loaded);
    loaded.catch(() => providers.delete(file));
  }
  return loaded;
};

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return null;
    throw error;
  }
}

const parseObject = (text: string, what: string): JsonObject => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SettingsError(`${what} is not plain JSON (${(error as Error).message}); comments and trailing commas are not supported`);
  }
  if (!isObject(value)) throw new SettingsError(`${what} must hold a JSON object`);
  return value;
};

// The settings file is generated as the user's own content (kept under stateDir/base) plus the overlay; restore puts the user's content back.
export function createSettingsFiles({ stateDir, onWarning = console.warn }: { stateDir: string; onWarning?: (message: string) => void }) {
  const dir = path.join(stateDir, "base");
  const baseFile = (id: string) => path.join(dir, `${id}.json`);
  const ledgerFile = (id: string) => path.join(dir, `${id}.state.json`);

  const targetOf = (worktree: string, file: string) => {
    const target = path.resolve(worktree, file);
    if (!isUnder(target, path.resolve(worktree))) throw new SettingsError(`settings.file ${file} points outside the worktree`);
    return target;
  };

  const readLedger = async (id: string): Promise<Ledger | null> => {
    const text = await readText(ledgerFile(id));
    return text === null ? null : (JSON.parse(text) as Ledger);
  };

  // What the user owns now: the live file when we have not generated it, else the kept base with any hand edit folded in after a backup.
  const currentBase = async (id: string, target: string, ledger: Ledger | null): Promise<{ text: string | null; existed: boolean; backup?: string }> => {
    const live = await readText(target);
    if (!ledger || ledger.generated === null) return { text: live, existed: live !== null };
    const kept = ledger.existed ? await readText(baseFile(id)) : null;
    if (live === null || live === ledger.generated || live === kept) return { text: kept, existed: ledger.existed };
    const backup = path.join(dir, `${id}.edited-${new Date().toISOString().replaceAll(":", "-")}.json`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(backup, live, { mode: 0o600 });
    const edited = parseObject(live, `${target} (edited by hand, copy kept at ${backup})`);
    const folded = foldEdit(kept === null ? {} : parseObject(kept, baseFile(id)), parseObject(ledger.generated, "the last generated settings"), edited);
    onWarning(`${target} was edited by hand; the edit is kept in the base settings (copy of the edited file at ${backup})`);
    return { text: asText(folded), existed: true, backup };
  };

  const saveBase = async (id: string, text: string | null) => {
    if (text === null) return fs.rm(baseFile(id), { force: true });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(baseFile(id), text, { mode: 0o600 });
  };

  const overlayFor = async ({ project, worktree, port, logDir, services, dedicatedDb }: SettingsRequest, file: string, base: JsonObject) => {
    const overlay = renderValue(project.settings?.overlay ?? {}, { port, logDir, worktree, services }) as JsonObject;
    if (!project.provider) return overlay;
    const provider = await loadProvider(project.provider);
    if (typeof provider.settingsOverlay !== "function") return overlay;
    const extra = await provider.settingsOverlay({
      project: project.id,
      worktree,
      appDir: project.appDir,
      file,
      port,
      logDir,
      services,
      dedicatedDb,
      base: structuredClone(base),
    });
    if (!isObject(extra)) throw new SettingsError(`settingsOverlay of ${project.provider} must return an object`);
    return deepMerge(overlay, extra);
  };

  return {
    async apply(request: SettingsRequest): Promise<SettingsOutcome | null> {
      const { id, project, worktree } = request;
      if (!project.settings) return null;
      const target = targetOf(worktree, project.settings.file);
      const ledger = await readLedger(id);
      const base = await currentBase(id, target, ledger);
      const baseObject = base.text === null ? {} : parseObject(base.text, ledger?.generated ? baseFile(id) : target);
      const merged = deepMerge(baseObject, await overlayFor(request, target, baseObject));
      await saveBase(id, base.text);
      await writeJsonAtomic(ledgerFile(id), { worktree, file: target, existed: base.existed, generated: asText(merged) } satisfies Ledger);
      await writeJsonAtomic(target, merged);
      return { file: target, ...(base.backup && { folded: { backup: base.backup } }) };
    },

    async restore(id: string): Promise<SettingsOutcome | null> {
      const ledger = await readLedger(id);
      if (!ledger || ledger.generated === null) return null;
      const base = await currentBase(id, ledger.file, ledger);
      if (base.text === null) await fs.rm(ledger.file, { force: true });
      else await fs.writeFile(ledger.file, base.text, { mode: 0o600 });
      await saveBase(id, base.text);
      await writeJsonAtomic(ledgerFile(id), { ...ledger, existed: base.existed, generated: null } satisfies Ledger);
      return { file: ledger.file, ...(base.backup && { folded: { backup: base.backup } }) };
    },
  };
}

export type SettingsFiles = ReturnType<typeof createSettingsFiles>;
