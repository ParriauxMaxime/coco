// CSRF / DNS rebinding guard for /api/ and /works/: only our own hosts, and a browser Origin only from them. Clients with no Origin (mcp, plugins, curl) pass.
export const VITE_PORT = 8778;
// the User-Agent mark of agents' browser tabs (browser-host.ts): a page an agent drives never reaches coco's API
export const AGENT_UA = 'CocoAgentBrowser';
// a shell's input and output (a workspace's terminals, the event stream carrying them): a foreign Origin is refused on a read too
const SHELL = /^\/api\/(events(\/|\?|$)|workspaces\/[^/]+\/(terminals|scripts)(\/|\?|$))/;

const LOOPBACK_IP = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'];

export const loopbackHosts = (port: number) => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `127.0.0.1:${VITE_PORT}`, `localhost:${VITE_PORT}`]);

// a request from this Mac itself: a loopback socket and Host, and no proxy between. tailscale serve connects from loopback too, but keeps
// the client's Host (which a client can set to 127.0.0.1) and always adds X-Forwarded-For
export function isLocal(loopback: Set<string>, req: { socket?: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> }) {
  if (!LOOPBACK_IP.test(req.socket?.remoteAddress || '')) return false;
  if (!loopback.has(String(req.headers.host || '').toLowerCase())) return false;
  return PROXY_HEADERS.every((h) => req.headers[h] === undefined);
}

export function allowedHosts(port: number, baseUrl: string, extra: string[] = []): Set<string> {
  const hosts = new Set([...loopbackHosts(port), ...extra.map((h) => h.toLowerCase())]);
  try {
    hosts.add(new URL(baseUrl).host);
  } catch {
    // keep the defaults
  }
  return hosts;
}

// the paths the guard covers: every API route and the artifacts
export const guarded = (pathname: string) => pathname.startsWith('/api/') || pathname.startsWith('/works/');

// null when allowed, else the reason
export function guard(hosts: Set<string>, req: { method?: string; url?: string; headers: { host?: string; origin?: string; 'user-agent'?: string } }): string | null {
  if (!hosts.has(String(req.headers.host || '').toLowerCase())) return 'host not allowed';
  if (String(req.headers['user-agent'] || '').includes(AGENT_UA)) return 'refused from an agent\'s browser tab';
  const m = req.method || 'GET';
  const origin = req.headers.origin;
  const originHost = origin?.match(/^https?:\/\/(.+)$/i)?.[1].toLowerCase();
  const checked = (m !== 'GET' && m !== 'HEAD') || SHELL.test(req.url || '');
  if (checked && origin !== undefined && !(originHost && hosts.has(originHost))) return 'origin not allowed';
  return null;
}
