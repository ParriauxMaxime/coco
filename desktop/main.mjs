// coco's desktop shell: one window on the coco server (started when none answers), a menu bar icon, a dock badge and a global shortcut.
// The server outlives the app: quitting coco leaves it running for the agents that call it.
import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, session, shell, systemPreferences } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHORTCUT = 'Alt+CommandOrControl+C';
const BOOT_WAIT_MS = 120000;
const POLL_MS = 1000;

if (!app.requestSingleInstanceLock()) app.quit();

// a Finder-launched app gets a bare PATH: git, gh, paseo, claude and node live on the login shell's
function loginPath() {
  try {
    return execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "%s" "$PATH"'], { encoding: 'utf8', timeout: 10000 });
  } catch {
    return process.env.PATH;
  }
}
process.env.PATH = loginPath();

// the coco checkout: the folder above this one when run from source, the one recorded at pack time when packaged
function appDir() {
  const recorded = path.join(app.getAppPath(), 'app-dir.json');
  if (fs.existsSync(recorded)) return JSON.parse(fs.readFileSync(recorded, 'utf8')).app;
  return path.resolve(HERE, '..');
}
const APP = appDir();

function baseUrl() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(APP, 'coco.config.json'), 'utf8'));
    if (cfg.baseUrl) return String(cfg.baseUrl).replace(/\/+$/, '');
  } catch {}
  return 'http://127.0.0.1:8777';
}
const BASE = baseUrl();

const ORIGIN = new URL(BASE).origin;
const fromCoco = (url) => {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
};

// the composer's mic (dictation): coco's own pages only, audio only, after macOS asks once; every other permission as Electron grants it
function allowMic() {
  const s = session.defaultSession;
  s.setPermissionCheckHandler((_wc, permission, origin) => permission !== 'media' || fromCoco(origin));
  s.setPermissionRequestHandler((_wc, permission, done, details) => {
    if (permission !== 'media') return done(true);
    const audioOnly = (details.mediaTypes ?? []).every((t) => t === 'audio');
    if (!fromCoco(details.requestingUrl) || !audioOnly) return done(false);
    if (process.platform !== 'darwin') return done(true);
    systemPreferences.askForMediaAccess('microphone').then(done, () => done(false));
  });
}

const answers = () => fetch(`${BASE}/api/server`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);

function startServer() {
  const log = fs.openSync(path.join(app.getPath('logs'), 'server.log'), 'a');
  const build = fs.existsSync(path.join(APP, 'dist', 'index.html')) ? '' : 'npm run -s build; ';
  spawn('sh', ['-c', `${build}exec node server/index.ts`], { cwd: APP, detached: true, stdio: ['ignore', log, log], env: process.env }).unref();
}

async function ensureServer() {
  if (await answers()) return true;
  startServer();
  const until = Date.now() + BOOT_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((ok) => setTimeout(ok, POLL_MS));
    if (await answers()) return true;
  }
  return false;
}

const page = (text) => `data:text/html;charset=utf-8,${encodeURIComponent(`<body style="margin:0;height:100vh;display:grid;place-items:center;background:#1c1f29;color:#c9cdd6;font:15px -apple-system,sans-serif">${text}</body>`)}`;

let win = null;
let tray = null;
let quitting = false;
let waiting = 0;

const boundsFile = () => path.join(app.getPath('userData'), 'window.json');
const savedBounds = () => {
  try {
    return JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
  } catch {
    return { width: 1440, height: 900 };
  }
};

async function load() {
  win.loadURL(page('Starting coco…'));
  if (await ensureServer()) return win.loadURL(BASE);
  win.loadURL(page(`coco did not answer on ${BASE}. See ${path.join(app.getPath('logs'), 'server.log')}.`));
}

function createWindow() {
  // no native title bar: the traffic lights sit in coco's own 40px top bar, which leaves room for them
  win = new BrowserWindow({ ...savedBounds(), minWidth: 900, minHeight: 600, title: 'coco', backgroundColor: '#1c1f29', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 }, webPreferences: { preload: path.join(HERE, 'preload.cjs') } });
  const fullscreen = (on) => win.webContents.send('coco:fullscreen', on);
  win.on('enter-full-screen', () => fullscreen(true));
  win.on('leave-full-screen', () => fullscreen(false));
  win.webContents.on('did-finish-load', () => fullscreen(win.isFullScreen()));
  const external = (url) => !url.startsWith(BASE) && !url.startsWith('data:');
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!external(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!external(url)) return;
    e.preventDefault();
    shell.openExternal(url);
  });
  // the server went away under the page: start it again
  win.webContents.on('did-fail-load', (_e, _code, _desc, url) => url.startsWith(BASE) && setTimeout(load, POLL_MS));
  win.on('close', (e) => {
    fs.writeFileSync(boundsFile(), JSON.stringify(win.getBounds()));
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  load();
}

function show() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

async function restartServer() {
  await fetch(`${BASE}/api/server/restart`, { method: 'POST' }).catch(() => {});
  setTimeout(load, POLL_MS * 2);
}

function refreshTray() {
  tray.setTitle(waiting ? String(waiting) : '');
  tray.setToolTip(waiting ? `coco: ${waiting} waiting on you` : 'coco');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open coco', accelerator: SHORTCUT, click: show },
    ...(waiting ? [{ label: `${waiting} waiting on you`, click: show }] : []),
    { type: 'separator' },
    { label: 'Restart server', click: restartServer },
    { label: 'Server log', click: () => shell.openPath(path.join(app.getPath('logs'), 'server.log')) },
    { type: 'separator' },
    { label: 'Quit coco', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
  ]));
}

// opens a coco page in the window, e.g. #/settings/beta
function openHash(hash) {
  show();
  const send = () => win.webContents.send('coco:open', hash);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
}

// Electron's default menu, with View > Beta… opening Settings > Beta
function appMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Beta…', click: () => openHash('#/settings/beta') },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

ipcMain.on('coco:waiting', (_e, count) => {
  waiting = count;
  app.dock?.setBadge(count ? String(count) : '');
  if (tray) refreshTray();
});

app.on('second-instance', show);
app.on('activate', show);
app.on('before-quit', () => (quitting = true));
app.on('will-quit', () => globalShortcut.unregisterAll());

app.whenReady().then(() => {
  // packaged, the bundle carries the icon; run from source, Electron's own would show
  if (!app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(path.join(HERE, 'build', 'icon.png')));
  allowMic();
  appMenu();
  tray = new Tray(nativeImage.createFromPath(path.join(HERE, 'build', 'trayTemplate.png')));
  tray.on('click', show);
  refreshTray();
  globalShortcut.register(SHORTCUT, () => (win?.isFocused() ? win.hide() : show()));
  createWindow();
});
