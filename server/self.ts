// The commit this server runs against its checkout's head, the client build dist/ serves, and a restart that rebuilds the client
// and starts again on the same argv.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import type { Req, Res, Send } from './core-types.ts';

export type ServerInfo = { running: string | null; head: string | null; behind: number; dirty: boolean; startedAt: string; build: string | null };

// the client builds beside dist/ while this server keeps serving, keeps the old chunks an open page still loads (two days), swaps in,
// then this server stops and the new one takes the port; a failed build leaves this one running
const RESTART = [
  'npx vite build --outDir dist.next --emptyOutDir --logLevel warn || { echo "restart: client build failed, coco keeps running"; exit 1; }',
  '[ -d dist/assets ] && cp -pn dist/assets/* dist.next/assets/ 2>/dev/null; find dist.next/assets -type f -mtime +2 -delete',
  'rm -rf dist.old; [ -d dist ] && mv dist dist.old; mv dist.next dist; rm -rf dist.old',
  'kill "$COCO_OLD_PID"; while kill -0 "$COCO_OLD_PID" 2>/dev/null; do sleep 0.2; done',
  'exec "$0" "$@"',
].join('\n');

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

  let restarting = false;
  function restart() {
    if (restarting) return;
    restarting = true;
    const log = fs.openSync(path.join(DATA, 'server-restart.log'), 'a');
    const child = spawn('sh', ['-c', RESTART, process.execPath, ...process.argv.slice(1)], { cwd: APP, detached: true, stdio: ['ignore', log, log], env: { ...process.env, COCO_OLD_PID: String(process.pid) } });
    child.on('exit', () => (restarting = false));
    child.unref();
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
