import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function git(cwd: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
    return stdout;
  } catch {
    return null;
  }
}

export const toplevel = async (cwd: string) => (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim() || null;

export async function remoteUrls(worktree: string): Promise<string[]> {
  const text = (await git(worktree, ["config", "--get-regexp", "^remote\\..*\\.url$"])) ?? "";
  return text
    .split("\n")
    .map((line) => line.split(/\s+/)[1])
    .filter(Boolean);
}

const normalizeRemote = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

// "acme/widgets" matches git@host:acme/widgets.git, https://host/acme/widgets and ssh://host/acme/widgets.
export function remoteMatches(url: string, remote: string) {
  const [have, want] = [normalizeRemote(url), normalizeRemote(remote)];
  return have === want || have.endsWith(`/${want}`) || have.endsWith(`:${want}`);
}

export type WorktreeInfo = { branch: string | null; head: string; dirty: boolean };
export type WorktreeEntry = { path: string; head: string; branch: string | null };

export const statusFiles = async (worktree: string) =>
  ((await git(worktree, ["status", "--porcelain"])) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));

export async function listWorktrees(worktree: string): Promise<WorktreeEntry[]> {
  const text = (await git(worktree, ["worktree", "list", "--porcelain"])) ?? "";
  return text.split("\n\n").flatMap((block) => {
    const fields = new Map(block.split("\n").map((line) => [line.split(" ")[0], line.slice(line.indexOf(" ") + 1)]));
    const [path, head, branch] = [fields.get("worktree"), fields.get("HEAD"), fields.get("branch")];
    if (!path || !head || !/^[0-9a-f]{40,64}$/.test(head) || fields.has("bare")) return [];
    return [{ path, head, branch: branch?.replace(/^refs\/heads\//, "") ?? null }];
  });
}

// origin/HEAD when the clone recorded it, else origin/main or origin/master.
export async function defaultRemoteRef(worktree: string): Promise<string | null> {
  const text =
    (await git(worktree, [
      "for-each-ref",
      "--format=%(refname) %(symref)",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
      "refs/remotes/origin/master",
    ])) ?? "";
  const refs = new Map(text.split("\n").map((line) => [line.split(" ")[0], line.split(" ")[1] ?? ""]));
  return refs.get("refs/remotes/origin/HEAD") || ["refs/remotes/origin/main", "refs/remotes/origin/master"].find((ref) => refs.has(ref)) || null;
}

export async function refsContaining(worktree: string, commit: string, refs: string[]): Promise<Set<string>> {
  if (!refs.length) return new Set();
  const text = (await git(worktree, ["for-each-ref", "--contains", commit, "--format=%(refname)", ...refs])) ?? "";
  const wanted = new Set(refs);
  return new Set(text.split("\n").filter((ref) => wanted.has(ref)));
}

// The commits of the list that no other one descends from.
export async function independent(worktree: string, commits: string[]): Promise<string[]> {
  const unique = [...new Set(commits)];
  if (unique.length < 2) return unique;
  const text = await git(worktree, ["merge-base", "--independent", ...unique]);
  return text === null ? unique : text.split("\n").filter(Boolean);
}

export const isAncestor = async (worktree: string, ancestor: string, descendant: string) =>
  ancestor === descendant || (await git(worktree, ["merge-base", "--is-ancestor", ancestor, descendant])) !== null;

export type GitCache = {
  info(worktree: string): Promise<WorktreeInfo>;
  dirtyFiles(worktree: string): Promise<string[]>;
  forget(worktree: string): void;
};

export function createGitCache(ttlMs: number): GitCache {
  const entries = new Map<string, { at: number; value: Promise<unknown> }>();
  const refreshing = new Set<string>();
  // stale: an expired entry is served while it refreshes, so a git status over every worktree never holds the board up; placement reads stay strict
  const cached = <T>(key: string, load: () => Promise<T>, stale = false): Promise<T> => {
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
    if (hit && stale) {
      if (!refreshing.has(key)) {
        refreshing.add(key);
        const next = load();
        next.then(() => entries.set(key, { at: Date.now(), value: next }), () => {}).finally(() => refreshing.delete(key));
      }
      return hit.value as Promise<T>;
    }
    const value = load();
    entries.set(key, { at: Date.now(), value });
    return value;
  };
  const dirtyFiles = (worktree: string) => cached(`status ${worktree}`, () => statusFiles(worktree));
  return {
    dirtyFiles,
    info: (worktree) =>
      cached(`info ${worktree}`, async () => {
        const [head, branch, files] = await Promise.all([
          git(worktree, ["rev-parse", "HEAD"]),
          git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
          dirtyFiles(worktree),
        ]);
        return { head: head?.trim() ?? "", branch: branch?.trim() || null, dirty: files.length > 0 };
      }, true),
    forget: (worktree) => {
      entries.delete(`status ${worktree}`);
      entries.delete(`info ${worktree}`);
    },
  };
}
