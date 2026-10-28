// The commit this server runs against its checkout's head, and a restart that rebuilds the client and starts again on the same argv.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { Req, Res, Send } from './core-types.ts';

export type ServerInfo = { running: string | null; head: string | null; behind: number; dirty: boolean; startedAt: string };

// the old process must free the port before the new one listens; the client build runs in that gap
const RESTART = 'sleep 1; npm run -s build; exec "$0" "$@"';

export function createSelf({ APP, DATA }: { APP: string; DATA: string }) {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', ['-C', APP, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const running = git(['rev-parse', 'HEAD']);
  const dirtyAtBoot = Boolean(git(['status', '--porcelain', '--untracked-files=no']));
  const startedAt = new Date().toISOString();

  function info(): ServerInfo {
    const head = git(['rev-parse', 'HEAD']);
    const behind = running && head && head !== running ? Number(git(['rev-list', '--count', `${running}..${head}`])) || 0 : 0;
    return { running, head, behind, dirty: dirtyAtBoot, startedAt };
  }

  function restart() {
    const log = fs.openSync(path.join(DATA, 'server-restart.log'), 'a');
    spawn('sh', ['-c', RESTART, process.execPath, ...process.argv.slice(1)], { cwd: APP, detached: true, stdio: ['ignore', log, log] }).unref();
    setTimeout(() => process.exit(0), 200);
  }

  function handle(req: Req, res: Res, parts: string[], send: Send) {
    if (req.method === 'GET') return send(res, 200, info());
    if (req.method === 'POST' && parts[1] === 'restart') {
      send(res, 202, { restarting: true });
      return restart();
    }
    return send(res, 405, { error: 'GET /api/server or POST /api/server/restart' });
  }

  return { info, handle };
}
