// CSRF / DNS rebinding guard for /api/ and /works/: only our own hosts, and a browser Origin only from them. Clients with no Origin (mcp, plugins, curl) pass.
const VITE_PORT = 8778;

export function allowedHosts(port: number, baseUrl: string, extra: string[] = []): Set<string> {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `127.0.0.1:${VITE_PORT}`, `localhost:${VITE_PORT}`, ...extra.map((h) => h.toLowerCase())]);
  try {
    hosts.add(new URL(baseUrl).host);
  } catch {
    // keep the defaults
  }
  return hosts;
}

// null when allowed, else the reason
export function guard(hosts: Set<string>, req: { method?: string; headers: { host?: string; origin?: string } }): string | null {
  if (!hosts.has(String(req.headers.host || '').toLowerCase())) return 'host not allowed';
  const m = req.method || 'GET';
  const origin = req.headers.origin;
  const originHost = origin?.match(/^https?:\/\/(.+)$/i)?.[1].toLowerCase();
  if (m !== 'GET' && m !== 'HEAD' && origin !== undefined && !(originHost && hosts.has(originHost))) return 'origin not allowed';
  return null;
}
