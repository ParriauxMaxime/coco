// Screenshots and clips a finding shows: uploaded as raw bytes, served back from data/works/<slug>/media/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Req, Res, Send, Work } from './core-types.ts';

const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' };
const MIME: Record<string, string> = Object.fromEntries(Object.entries(TYPES).map(([m, ext]) => [ext, m]));
const MAX_BYTES = 50 * 1024 * 1024;
const FILE = /^[a-f0-9]{12}\.(png|jpg|webp|gif|mp4|webm)$/;

const readBytes = (req: Req) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(new Error(`larger than ${MAX_BYTES / 1024 / 1024} MB`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

export function createMedia({ DATA, works }: { DATA: string; works: { get: (slug: string) => Work | null } }) {
  const dir = (slug: string) => path.join(DATA, 'works', slug, 'media');

  // POST /api/works/<slug>/media (raw body, Content-Type image/* or video/*) → { src } · GET /api/works/<slug>/media/<file>
  async function handle(req: Req, res: Res, parts: string[], send: Send) {
    const [, slug, , file] = parts;
    if (!works.get(slug)) return send(res, 404, { error: 'no such work' });
    if (req.method === 'POST' && !file) {
      const ext = TYPES[String(req.headers['content-type'] || '').split(';')[0].trim()];
      if (!ext) return send(res, 415, { error: `Content-Type must be one of ${Object.keys(TYPES).join(', ')}` });
      let bytes: Buffer;
      try {
        bytes = await readBytes(req);
      } catch (e) {
        return send(res, 413, { error: e instanceof Error ? e.message : String(e) });
      }
      if (!bytes.length) return send(res, 400, { error: 'empty body' });
      const name = `${crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12)}.${ext}`;
      fs.mkdirSync(dir(slug), { recursive: true });
      fs.writeFileSync(path.join(dir(slug), name), bytes);
      return send(res, 200, { src: `/api/works/${slug}/media/${name}` });
    }
    if (req.method === 'GET' && file && FILE.test(file)) {
      const full = path.join(dir(slug), file);
      if (!fs.existsSync(full)) return send(res, 404, { error: 'no such media' });
      res.writeHead(200, { 'Content-Type': MIME[file.split('.').pop() ?? ''], 'Cache-Control': 'max-age=31536000, immutable' });
      return fs.createReadStream(full).pipe(res);
    }
    return send(res, 400, { error: `unsupported ${req.method}` });
  }

  return { handle };
}
