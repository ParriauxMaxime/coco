// The commit this server runs against its checkout's head, the client build dist/ serves, and a restart that rebuilds the client
// and starts again on the same argv.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import type { Req, Res, Send } from './core-types.ts';

export type ServerInfo = { running: string | null; head: string | null; behind: number; dirty: boolean; startedAt: string; build: string | null };

// the client builds beside dist/ while this server keeps serving; its chunks join dist/ next to the old ones an open page still loads,
// then index.html is renamed over the old one, so dist/ is never missing a file; only then are the chunks pruned to this build's and the
// replaced build's (listed in dist/.assets; two days of them when no list was kept); then this server stops and the new one
// takes the port; a lockfile newer than the last install installs first; a failed install or build leaves this one running
const RESTART = [
  '[ package-lock.json -nt node_modules/.package-lock.json ] && { npm install --no-audit --no-fund || { echo "restart: npm install failed, coco keeps running"; exit 1; }; }',
  'npx vite build --outDir dist.next --emptyOutDir --logLevel warn || { echo "restart: client build failed, coco keeps running"; exit 1; }',
  'ls dist.next/assets > dist.next/.assets',
  'rsync -a --exclude index.html --exclude .assets dist.next/ dist/ && mv dist.next/index.html dist/index.html',
  'if [ -f dist/.assets ]; then cat dist/.assets dist.next/.assets > dist.next/.keep; for f in dist/assets/*; do grep -qxF "${f##*/}" dist.next/.keep || rm -f "$f"; done; else find dist/assets -type f -mtime +2 -delete; fi',
  'mv dist.next/.assets dist/.assets && rm -rf dist.next',
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
    try {
      const child = spawn('sh', ['-c', RESTART, process.execPath, ...process.argv.slice(1)], { cwd: APP, detached: true, stdio: ['ignore', log, log], env: { ...process.env, COCO_OLD_PID: String(process.pid) } });
      child.on('exit', () => (restarting = false));
      child.unref();
    } finally {
      // the child holds its own copy of the log
      fs.closeSync(log);
    }
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
