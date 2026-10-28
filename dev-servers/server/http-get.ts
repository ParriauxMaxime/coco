import http from "node:http";

export type HttpReply = { status: number; body: string };

// A plain GET without fetch: Node 24's fetch can throw setTypeOfService EINVAL from a socket event, out of reach of any catch, and that kills the plugin.
export function httpGet(url: URL, timeoutMs: number): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`GET ${url} timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
  });
}
