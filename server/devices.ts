// Paired devices (a phone through tailscale serve): a request from this Mac needs nothing, any other carries a device token in a cookie,
// swapped once at GET /pair?code=… for a one-time code that Settings > Devices shows (five minutes). Tokens are kept as their sha256.
// GET /api/devices · POST /api/devices/codes · PUT /api/devices/<id> { name } · DELETE /api/devices/<id>, from this Mac only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isLocal } from './guard.ts';
import type { ReadBody, Req, Res, Send } from './core-types.ts';

export type Device = { id: string; name: string; hash: string; createdAt: string; lastSeen: string };
export type DeviceView = Omit<Device, 'hash'>;
export type Devices = ReturnType<typeof createDevices>;

export const PAIR_PATH = '/pair';
export const APK_PATH = '/mobile/coco.apk';
const COOKIE = 'coco_device';
const CODE_MS = 5 * 60_000;
const SEEN_MS = 10 * 60_000;
const FAIL_WINDOW_MS = 60_000;
const FAILS = 10;
const YEAR_S = 365 * 24 * 3600;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ANDROID_UA = 'CocoAndroid';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();
const view = ({ hash: _, ...d }: Device): DeviceView => d;

const ON_THIS_MAC = /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/;

// the addresses a phone reaches coco under: the config's proxy hosts over https and the baseUrl, none on loopback, tailnet names first
export function pairOrigins(baseUrl: string, hosts: string[]) {
  const out = hosts.map((h) => `https://${h.toLowerCase()}`);
  try {
    out.unshift(new URL(baseUrl).origin);
  } catch {
    // no baseUrl origin
  }
  const reachable = [...new Set(out)].filter((o) => !ON_THIS_MAC.test(new URL(o).host));
  return [...reachable.filter((o) => o.endsWith('.ts.net')), ...reachable.filter((o) => !o.endsWith('.ts.net'))];
}

export function deviceName(ua = '') {
  const app = ua.includes(ANDROID_UA) ? 'coco app' : /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const model = ua.match(/Android [\d.]+; (?:[a-z]{2}[-_][a-z]{2}; )?([^;)]+?)(?: Build\/[^;)]*)?[;)]/i)?.[1];
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? (model && model !== 'K' && model !== 'wv' ? model : 'Android') : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${app} on ${os}` : app;
}

function cookieOf(req: Req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
}

const page = (title: string, text: string, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>coco</title>${head}` +
  `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:#1c1f29;color:#e6e8ee}main{max-width:340px;padding:24px}h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#a9aec0}</style>` +
  `</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

// loopback: the Hosts this Mac reaches coco under; origins: the https addresses a phone reaches it under, for the pairing QR; apk: the Android app's file
export function createDevices({ file, loopback, origins = [], apk = '', now = Date.now }: { file: string; loopback: Set<string>; origins?: string[]; apk?: string; now?: () => number }) {
  const load = (): Device[] => {
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  let devices = load();
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(devices, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  // code → when it expires; codes stay in memory, a restart drops them
  const codes = new Map<string, number>();
  const open = new Map<string, Set<Res>>();
  let fails: number[] = [];

  function newCode() {
    for (const [c, until] of codes) if (until <= now()) codes.delete(c);
    const code = Array.from(crypto.randomBytes(8), (b) => ALPHABET[b & 31]).join('');
    codes.set(code, now() + CODE_MS);
    return { code, expiresAt: new Date(now() + CODE_MS).toISOString() };
  }

  // a live code is swapped once for a new device's token; ten wrong codes in a minute shut the door for that minute
  function redeem(code: string, userAgent = ''): { token: string; device: DeviceView } | { status: number; error: string } {
    fails = fails.filter((t) => t > now() - FAIL_WINDOW_MS);
    if (fails.length >= FAILS) return { status: 429, error: 'Too many wrong codes. Wait a minute, then scan a new code.' };
    const given = sha256(code.trim().toUpperCase());
    let hit: string | null = null;
    for (const c of codes.keys()) if (crypto.timingSafeEqual(given, sha256(c))) hit = c;
    const until = hit ? codes.get(hit)! : 0;
    if (hit) codes.delete(hit);
    if (!hit || until <= now()) {
      fails.push(now());
      return { status: 400, error: 'This code is unknown, used or expired. Show a new one in coco Settings &gt; Devices on your Mac.' };
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const at = new Date(now()).toISOString();
    const device: Device = { id: crypto.randomBytes(6).toString('hex'), name: deviceName(userAgent), hash: sha256(token).toString('hex'), createdAt: at, lastSeen: at };
    devices.push(device);
    save();
    return { token, device: view(device) };
  }

  function deviceOf(req: Req): Device | null {
    const token = cookieOf(req);
    if (!token) return null;
    const hash = sha256(token);
    let found: Device | null = null;
    for (const d of devices) if (crypto.timingSafeEqual(hash, Buffer.from(d.hash, 'hex'))) found = d;
    if (found && Date.parse(found.lastSeen) < now() - SEEN_MS) {
      found.lastSeen = new Date(now()).toISOString();
      save();
    }
    return found;
  }

  // who sends a request: this Mac, a paired device, or no one coco knows (refused)
  const who = (req: Req): 'local' | Device | null => (isLocal(loopback, req) ? 'local' : deviceOf(req));

  // a device's open responses (its event stream above all), cut when it is revoked
  function hold(device: Device, res: Res) {
    const set = open.get(device.id) ?? new Set();
    open.set(device.id, set.add(res));
    res.on('close', () => set.delete(res));
  }

  function revoke(id: string) {
    const before = devices.length;
    devices = devices.filter((d) => d.id !== id);
    if (devices.length === before) return false;
    save();
    for (const res of open.get(id) ?? []) res.destroy();
    open.delete(id);
    return true;
  }

  function rename(id: string, name: string) {
    const d = devices.find((x) => x.id === id);
    if (!d) return null;
    d.name = name.trim().slice(0, 80) || d.name;
    save();
    return view(d);
  }

  function refuse(res: Res, pathname: string) {
    const text = 'Pair this device from coco Settings &gt; Devices on your Mac.';
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: 'this device is not paired: pair it from coco Settings > Devices on your Mac' }));
    }
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page('This device is not paired', text));
  }

  // GET /pair?code=…[&then=apk]: the cookie, then coco (or the Android app's download) through a page of coco's own origin, not a
  // redirect: a pairing link followed from another site would keep that site as initiator and the SameSite=Strict cookie would stay home
  function pair(req: Req, res: Res, url: URL) {
    const head = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    if (req.method !== 'GET') {
      res.writeHead(405, head);
      return res.end(page('Not here', 'Open the pairing link in a browser.'));
    }
    const r = redeem(url.searchParams.get('code') || '', String(req.headers['user-agent'] || ''));
    if ('error' in r) {
      res.writeHead(r.status, head);
      return res.end(page('Pairing failed', r.error));
    }
    const to = url.searchParams.get('then') === 'apk' ? APK_PATH : '/';
    res.writeHead(200, { ...head, 'Set-Cookie': `${COOKIE}=${r.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${YEAR_S}` });
    res.end(page('Paired', `<a href="${to}" style="color:inherit">Opening coco…</a>`, `<meta http-equiv="refresh" content="0;url=${to}">`));
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [, id] = parts;
    if (who(req) !== 'local') return send(res, 403, { error: 'devices are paired and revoked from coco on the Mac itself' });
    if (!id && req.method === 'GET') return send(res, 200, { devices: devices.map(view), origins, apk: Boolean(apk && fs.existsSync(apk)) });
    if (id === 'codes' && req.method === 'POST') return send(res, 200, newCode());
    if (id && req.method === 'PUT') {
      const { name } = JSON.parse((await readBody(req)) || '{}');
      const d = typeof name === 'string' ? rename(id, name) : null;
      return d ? send(res, 200, d) : send(res, 404, { error: 'no such device' });
    }
    if (id && req.method === 'DELETE') return revoke(id) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such device' });
    return send(res, 404, { error: 'no route' });
  }

  return { who, hold, pair, refuse, handle, newCode, redeem, revoke, rename, list: () => devices.map(view) };
}
