import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ProjectConfig } from "./config.ts";
import { errnoOf, isUnder, realPath } from "./proc.ts";

const run = promisify(execFile);

export type WarmKind = "symlink" | "clone" | "copyIfMissing";
export type WarmStep = {
  kind: WarmKind;
  path: string;
  outcome: "done" | "exists" | "no-source" | "busy" | "failed";
  method?: string;
  detail?: string;
};

export type WarmOptions = {
  project: Pick<ProjectConfig, "mainCheckout" | "warm">;
  worktree: string;
  sourceBusy?: (source: string) => boolean;
  platform?: NodeJS.Platform;
};

const TMP_MARK = ".warming-";

const exists = async (file: string) => {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return false;
    throw error;
  }
};

const isPlainEntry = (file: string) => {
  const stat = fsSync.lstatSync(file);
  return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
};

const cloneCommand = (platform: NodeJS.Platform): string[] | null =>
  platform === "darwin" ? ["cp", "-cR"] : platform === "linux" ? ["cp", "-R", "--reflink=auto"] : null;

// cp -c on APFS and --reflink on Linux share blocks with the source; anywhere else, or if cp fails, a plain copy.
async function copyTree(source: string, target: string, { clone, platform }: { clone: boolean; platform: NodeJS.Platform }) {
  const command = clone ? cloneCommand(platform) : null;
  if (command) {
    try {
      await run(command[0], [...command.slice(1), source, target]);
      return command.join(" ");
    } catch {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
  await fs.cp(source, target, { recursive: true, verbatimSymlinks: true, filter: isPlainEntry });
  return "copy";
}

// Leftovers of a copy that was cut short, so a retry starts clean.
async function removeStaleCopies(target: string) {
  const prefix = `${path.basename(target)}${TMP_MARK}`;
  let names: string[];
  try {
    names = await fs.readdir(path.dirname(target));
  } catch {
    return;
  }
  await Promise.all(
    names.filter((name) => name.startsWith(prefix)).map((name) => fs.rm(path.join(path.dirname(target), name), { recursive: true, force: true })),
  );
}

// Each step fills one path of the worktree from the same path in the main checkout, and never touches a path that already exists.
export async function warmWorktree({ project, worktree, sourceBusy = () => false, platform = process.platform }: WarmOptions): Promise<WarmStep[]> {
  const steps: [WarmKind, string][] = [
    ...project.warm.symlink.map((rel): [WarmKind, string] => ["symlink", rel]),
    ...project.warm.clone.map((rel): [WarmKind, string] => ["clone", rel]),
    ...project.warm.copyIfMissing.map((rel): [WarmKind, string] => ["copyIfMissing", rel]),
  ];
  if (!steps.length) return [];
  const root = path.resolve(worktree);
  const source = project.mainCheckout ? path.resolve(project.mainCheckout) : "";
  if (source && realPath(source) === realPath(root)) return [];

  const results: WarmStep[] = [];
  for (const [kind, rel] of steps) {
    const target = path.resolve(root, rel);
    const step = (outcome: WarmStep["outcome"], extra: Partial<WarmStep> = {}) => results.push({ kind, path: rel, outcome, ...extra });
    if (target === root || !isUnder(target, root)) {
      step("failed", { detail: "points outside the worktree" });
      continue;
    }
    if (!source) {
      step("no-source", { detail: "the project sets no mainCheckout" });
      continue;
    }
    const from = path.join(source, path.relative(root, target));
    try {
      if (await exists(target)) {
        step("exists");
        continue;
      }
      if (!(await exists(from))) {
        step("no-source", { detail: `${from} does not exist` });
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (kind === "symlink") {
        await fs.symlink(from, target);
        step("done", { method: "symlink" });
        continue;
      }
      if (kind === "clone" && sourceBusy(source)) {
        step("busy", { detail: "the main checkout's server is building, so its cache may be half written" });
        continue;
      }
      await removeStaleCopies(target);
      const tmp = `${target}${TMP_MARK}${process.pid}-${randomBytes(3).toString("hex")}`;
      try {
        const method = await copyTree(from, tmp, { clone: kind === "clone", platform });
        await fs.rename(tmp, target);
        step("done", { method });
      } catch (error) {
        await fs.rm(tmp, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      if (errnoOf(error) === "EEXIST" || errnoOf(error) === "ENOTEMPTY") step("exists");
      else step("failed", { detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export const describeWarm = (steps: WarmStep[]) =>
  steps.flatMap(({ kind, path: rel, outcome, method, detail }) => {
    if (outcome === "done") return [kind === "symlink" ? `linked ${rel} to the main checkout` : `${kind === "clone" ? "cloned" : "copied"} ${rel} (${method})`];
    if (outcome === "busy") return [`did not clone ${rel}: ${detail}`];
    if (outcome === "failed") return [`warming ${rel} failed: ${detail}`];
    return [];
  });
