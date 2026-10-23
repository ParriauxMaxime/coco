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

export async function worktreeInfo(worktree: string): Promise<WorktreeInfo> {
  const [head, branch, status] = await Promise.all([
    git(worktree, ["rev-parse", "HEAD"]),
    git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(worktree, ["status", "--porcelain"]),
  ]);
  return { head: head?.trim() ?? "", branch: branch?.trim() || null, dirty: Boolean(status?.trim()) };
}
