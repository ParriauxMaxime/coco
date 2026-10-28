// The commit this server runs against its checkout's head, the client build dist/ serves, and a restart that rebuilds the client
// and starts again on the same argv.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import type { Req, Res, Send } from './core-types.ts';

export type ServerInfo = { running: string | null; head: string | null; behind: number; dirty: boolean; startedAt: string; build: string | null };

// the old process must free the port before the new one listens; the client build runs in that gap
const RESTART = 'sleep 1; npm run -s build; exec "$0" "$@"';

export function createSelf({ APP, DATA, DIST = path.join(APP, 'dist') }: { APP: string; DATA: string; DIST?: string }) {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', ['-C', APP, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const running = git(['rev-parse', 'HEAD']);
  const dirtyAtBoot = Boolean(git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no']));
  const startedAt = new Date().toISOString();

  // dist/ is rebuilt under a running server (an agent's npm run build): the build is read again whenever index.html changes
  let page: { stamp: string; html: string; build: string } | null = null;
  function index() {
    const file = path.join(DIST, 'index.html');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return (page = null);
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (page?.stamp === stamp) return page;
    const raw = fs.readFileSync(file, 'utf8');
    const build = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
    // the page compares this with GET /api/server after a reconnect and reloads onto the new build
    return (page = { stamp, build, html: raw.replace('</head>', `<meta name="coco-build" content="${build}"></head>`) });
  }

  function info(): ServerInfo {
    const head = git(['rev-parse', 'HEAD']);
    const behind = running && head && head !== running ? Number(git(['rev-list', '--count', `${running}..${head}`])) || 0 : 0;
    return { running, head, behind, dirty: dirtyAtBoot, startedAt, build: index()?.build ?? null };
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

  return { info, handle, index };
}
