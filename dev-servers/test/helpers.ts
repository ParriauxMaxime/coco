import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cwdOf, infoOf, isUnder, signal } from "../server/proc.ts";
import type { DevServersState, JsonStore } from "../server/store.ts";

export const FIXTURE = fileURLToPath(new URL("./fixtures/widgets-app/server.mjs", import.meta.url));

// Ceiling for waits on a condition: they return as soon as it holds, so a loaded machine only makes them slower, never red.
export const PATIENCE_MS = 60_000;
export const PATIENCE_SECONDS = 50;

const bindable = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

// Below the OS ephemeral range (49152 and up), so outgoing connections never take a port a fixture is about to listen on; tests use base + 40 at most.
export async function freePort(): Promise<number> {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 29_000);
    if (await bindable(port)) return port;
  }
}

export const widgets = (base: number, extra: object = {}) => ({
  id: "widgets",
  match: { remote: "acme/widgets" },
  command: ["node", FIXTURE, "--port", "{port}", "--ttl", "30", "--leftover"],
  urlTemplate: "http://127.0.0.1:{port}",
  ports: { range: [base, base + 40], step: 1 },
  readiness: { http: { path: "/health", bodyIncludes: "ok" }, timeoutMinutes: 1 },
  logPatterns: { progress: "building (widgets \\d/\\d)", ready: "widgets ready on", crash: "server crashed" },
  stop: { graceSeconds: 1, sweepCwdUnder: [".build/server"] },
  optIns: { dedicatedDb: { args: ["--fresh-db"] }, services: { path: "services" } },
  ...extra,
});

export const runGit = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();

export const gitRepo = (repo: string, remote?: string) => {
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => runGit(repo, ...args);
  git("init", "-q", "-b", "main");
  if (remote) git("remote", "add", "origin", remote);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".build/\nwidgets.control\n");
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "index.js"), "export {};\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
};

// Only processes a test started are killed: server groups whose recorded start time still matches, and helpers running under the temp dir.
export async function killTestProcesses(stores: JsonStore<DevServersState>[], stateDir: string, dir: string) {
  for (const store of stores) {
    for (const record of Object.values(store.snapshot().servers)) {
      const proc = record.process;
      if (proc && (await infoOf(proc.pid))?.startedAt === proc.startedAt) signal(-proc.pgid, "SIGKILL");
    }
  }
  for (const log of fs.globSync(path.join(stateDir, "logs", "*", "run.log"))) {
    for (const [, pid] of fs.readFileSync(log, "utf8").matchAll(/leftover helper pid (\d+)/g)) {
      const cwd = await cwdOf(Number(pid));
      if (cwd && isUnder(fs.realpathSync(cwd), dir)) signal(Number(pid), "SIGKILL");
    }
  }
}
