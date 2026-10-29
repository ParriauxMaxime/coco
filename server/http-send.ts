// Every response coco writes through `send`: a JSON GET gets a strong ETag and `private, no-cache`, so the browser revalidates and an unchanged
// payload comes back as a bodiless 304; text bodies over MIN_SIZE go out brotli or gzip, as the request accepts. SSE streams and the
// pairing page write their own heads and never come here; a caller that passes `no-store`, or a response that sets a cookie, gets no ETag.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import type { Res, Send } from './core-types.ts';

const MIN_SIZE = 1024;
const COMPRESSIBLE = /^(application\/(json|javascript)|text\/(?!event-stream)|image\/svg\+xml)/;
type Enc = 'br' | 'gzip';

const accepted = (header: string | string[] | undefined) => {
  const out = new Set<string>();
  for (const part of String(header ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (name && !(q && Number(q.slice(2)) === 0)) out.add(name);
  }
  return out;
};
export const encodingFor = (header: string | string[] | undefined): Enc | null => {
  const ok = accepted(header);
  return ok.has('br') ? 'br' : ok.has('gzip') || ok.has('*') ? 'gzip' : null;
};
export const compress = (data: Buffer, enc: Enc) =>
  enc === 'br' ? zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }) : zlib.gzipSync(data, { level: 6 });

const hashOf = (data: Buffer) => createHash('sha1').update(data).digest('base64url');
// a tag per encoding (the bytes differ), and any of them revalidates: the browser's stored copy holds the same content
const matches = (header: string | string[] | undefined, hash: string) =>
  String(header ?? '')
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === `"${hash}"` || t === `"${hash}-br"` || t === `"${hash}-gzip"`);

type Encoded = (enc: Enc) => Buffer | null;

function write(res: Res, code: number, body: Buffer, type: string, cache: string, encoded?: Encoded) {
  const req = res.req;
  const head: Record<string, string | number> = { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': cache };
  const squeezable = COMPRESSIBLE.test(type);
  if (squeezable) head.Vary = 'Accept-Encoding';
  const enc = squeezable && body.length >= MIN_SIZE ? encodingFor(req?.headers['accept-encoding']) : null;
  const tagged = code === 200 && /\bno-cache\b/.test(cache) && (!req || req.method === 'GET' || req.method === 'HEAD') && !res.hasHeader('set-cookie');
  if (tagged) {
    const hash = hashOf(body);
    head.ETag = `"${hash}${enc ? `-${enc}` : ''}"`;
    if (matches(req?.headers['if-none-match'], hash)) {
      delete head['Content-Type'];
      res.writeHead(304, head);
      return res.end();
    }
  }
  const out = enc ? ((encoded && encoded(enc)) ?? compress(body, enc)) : body;
  if (enc && out !== body) head['Content-Encoding'] = enc;
  head['Content-Length'] = out.length;
  res.writeHead(code, head);
  res.end(out);
}

// cache: left out, JSON revalidates (`no-cache` + ETag, kept out of shared caches) and anything else is `no-store`
export const send: Send = (res, code, body, type = 'application/json', cache) => {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  write(res, code, data, type, cache ?? (type === 'application/json' ? 'private, no-cache' : 'no-store'));
};

// a file of dist/: its .br/.gz sibling when the build left one, else compressed once per file and mtime
const memo = new Map<string, Buffer>();
export function sendFile(res: Res, file: string, type: string, cache: string) {
  const stat = fs.statSync(file);
  const encoded: Encoded = (enc) => {
    const sibling = `${file}.${enc === 'br' ? 'br' : 'gz'}`;
    if (fs.existsSync(sibling)) return fs.readFileSync(sibling);
    const key = `${file}\0${stat.mtimeMs}\0${stat.size}\0${enc}`;
    let hit = memo.get(key);
    if (!hit) {
      if (memo.size > 400) memo.clear();
      memo.set(key, (hit = compress(fs.readFileSync(file), enc)));
    }
    return hit;
  };
  write(res, 200, fs.readFileSync(file), type, cache, encoded);
}
