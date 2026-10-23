import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const C_LOCALE = { ...process.env, LC_ALL: "C", LANG: "C" };

const output = async (file: string, args: string[]) => {
  try {
    return (await run(file, args, { env: C_LOCALE, maxBuffer: 32 * 1024 * 1024 })).stdout;
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? "";
  }
};

export const errnoOf = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

export function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoOf(error) === "EPERM";
  }
}

export function groupAlive(pgid: number) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return errnoOf(error) === "EPERM";
  }
}

export function signal(target: number, name: NodeJS.Signals) {
  try {
    process.kill(target, name);
    return true;
  } catch {
    return false;
  }
}

export type ProcessInfo = { pid: number; pgid: number; startedAt: string };

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;

// `lstart` is second-precise and stable for the life of a process, so pid + lstart names one process even after its pid is reused.
export async function processInfo(pids: number[]): Promise<Map<number, ProcessInfo>> {
  const found = new Map<number, ProcessInfo>();
  if (!pids.length) return found;
  const text = await output("ps", ["-o", "pid=,pgid=,lstart=", "-p", pids.join(",")]);
  for (const line of text.split("\n")) {
    const match = PS_LINE.exec(line);
    if (match) found.set(Number(match[1]), { pid: Number(match[1]), pgid: Number(match[2]), startedAt: match[3].replace(/\s+/g, " ") });
  }
  return found;
}

export const infoOf = async (pid: number) => (await processInfo([pid])).get(pid) ?? null;

export const realPath = (file: string) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

const parseLsofCwds = (text: string) => {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
};

export async function cwdOf(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  return parseLsofCwds(await output("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])).get(pid) ?? null;
}

async function ownCwds(): Promise<Map<number, string>> {
  if (process.platform === "linux") {
    const cwds = new Map<number, string>();
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        cwds.set(Number(entry), fs.readlinkSync(`/proc/${entry}/cwd`));
      } catch {
        // another user's process, or gone
      }
    }
    return cwds;
  }
  return parseLsofCwds(await output("lsof", ["-a", "-u", String(process.getuid?.() ?? ""), "-d", "cwd", "-Fpn"]));
}

export const isUnder = (file: string, dir: string) => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

export async function pidsWithCwdUnder(dirs: string[]): Promise<number[]> {
  const roots = dirs.map(realPath);
  if (!roots.length) return [];
  const pids: number[] = [];
  for (const [pid, cwd] of await ownCwds()) {
    if (pid !== process.pid && roots.some((root) => isUnder(cwd, root))) pids.push(pid);
  }
  return pids.sort((a, b) => a - b);
}

export async function bootTime(): Promise<number | null> {
  if (process.platform === "linux") {
    const btime = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
    return btime ? Number(btime[1]) * 1000 : null;
  }
  const sec = /sec = (\d+)/.exec(await output("sysctl", ["-n", "kern.boottime"]));
  return sec ? Number(sec[1]) * 1000 : null;
}

export function portListening(port: number, timeoutMs = 300) {
  const attempt = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host });
      const settle = (listening: boolean) => {
        socket.destroy();
        resolve(listening);
      };
      socket.setTimeout(timeoutMs, () => settle(false));
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
    });
  return Promise.all(["127.0.0.1", "::1"].map(attempt)).then((results) => results.some(Boolean));
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, everyMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(everyMs);
  }
}

export function resolveExecutable(command: string, cwd: string, envPath: string | undefined) {
  if (command === "node") return process.execPath;
  if (command.includes("/")) return path.resolve(cwd, command);
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}
