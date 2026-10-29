// Files the owner attaches to a message for an agent: stored under <data>/uploads/<id>/<name>, sent to Paseo as images or uploaded files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import type { Req, Res, Send } from './core-types.ts';
import type { AgentInput } from './paseo-agent.ts';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const IMAGE_MAX = 5 * 1024 * 1024;
export const FILE_MAX = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
export const SWEEP_AGE = 24 * 60 * 60 * 1000;
// the text of a message that only carries files
export const FILES_ONLY = 'See the attached files.';
const ID = /^[a-f0-9]{16}$/;
const MIME = /^[\w.+-]+\/[\w.+-]+$/;
const AGENT = /^[\w-]{1,80}$/;

export type Upload = { id: string; fileName: string; mimeType: string; size: number; path: string };
export type UploadRef = Omit<Upload, 'path'>;
export type SentMessage = { messageId: string; text: string; at: string; attachments: UploadRef[] };
export type UserItem = { text?: string; messageId?: string };

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

export const isImage = (mimeType: string) => IMAGE_TYPES.includes(mimeType);
export const limitOf = (mimeType: string) => (isImage(mimeType) ? IMAGE_MAX : FILE_MAX);
export const safeName = (name: string) => path.basename(String(name || '')).replace(/[^\w.\- ()+@]+/g, '_').replace(/^[.\s]+/, '').slice(-120) || 'file';
const tooBig = (mimeType: string) => new HttpError(413, `${isImage(mimeType) ? 'images' : 'files'} up to ${limitOf(mimeType) / 1024 / 1024} MB`);
export const uploadRef = ({ id, fileName, mimeType, size }: Upload): UploadRef => ({ id, fileName, mimeType, size });

// what Paseo takes with the text: images inline as base64, any other file by its path on disk
export function agentInput(files: Upload[]): AgentInput {
  const images = files.filter((f) => isImage(f.mimeType)).map((f) => ({ data: fs.readFileSync(f.path).toString('base64'), mimeType: f.mimeType }));
  const attachments = files.filter((f) => !isImage(f.mimeType)).map((f) => ({ type: 'uploaded_file' as const, id: f.id, fileName: f.fileName, mimeType: f.mimeType, size: f.size, path: f.path }));
  return { ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) };
}

// the body, or null past max bytes (read to the end so the refusal reaches the browser)
const readBytes = (req: Req, max: number) =>
  new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= max) chunks.push(c);
    });
    req.on('end', () => resolve(size > max ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });

export function createUploads({ DATA }: { DATA: string }) {
  const DIR = path.join(DATA, 'uploads');
  const SENT = path.join(DIR, 'sent');
  const metaFile = (id: string) => path.join(DIR, `${id}.json`);

  function store(fileName: string, mimeType: string, bytes: Buffer): Upload {
    if (!bytes.length) throw new HttpError(400, 'empty file');
    if (bytes.length > limitOf(mimeType)) throw tooBig(mimeType);
    if (MAGIC[mimeType] && !MAGIC[mimeType](bytes)) throw new HttpError(415, `not a ${mimeType.slice(6)} image`);
    const id = crypto.randomBytes(8).toString('hex');
    const name = safeName(fileName);
    fs.mkdirSync(path.join(DIR, id), { recursive: true });
    const full = path.join(DIR, id, name);
    fs.writeFileSync(full, bytes);
    const up = { id, fileName: name, mimeType, size: bytes.length, path: full };
    fs.writeFileSync(metaFile(id), JSON.stringify(up));
    return up;
  }

  function get(id: string): Upload | null {
    if (!ID.test(id) || !fs.existsSync(metaFile(id))) return null;
    const up: Upload = JSON.parse(fs.readFileSync(metaFile(id), 'utf8'));
    return fs.existsSync(up.path) ? up : null;
  }

  // the uploads a message carries, in order; an unknown id or too many refuse the message
  function resolve(ids: unknown): Upload[] {
    if (ids == null) return [];
    if (!Array.isArray(ids)) throw new HttpError(400, 'attachments must be a list of upload ids');
    if (ids.length > MAX_ATTACHMENTS) throw new HttpError(400, `at most ${MAX_ATTACHMENTS} attachments per message`);
    return [...new Set(ids.map(String))].map((id) => {
      const up = get(id);
      if (!up) throw new HttpError(400, `no upload ${id}`);
      return up;
    });
  }

  // what coco sent an agent with files: Paseo's timeline keeps only the text of a user message
  function record(agentId: string, msg: SentMessage) {
    if (!AGENT.test(agentId)) return;
    fs.mkdirSync(SENT, { recursive: true });
    fs.appendFileSync(path.join(SENT, `${agentId}.jsonl`), JSON.stringify(msg) + '\n');
  }
  const sent = (agentId: string): SentMessage[] => {
    const file = path.join(SENT, `${agentId}.jsonl`);
    return AGENT.test(agentId) && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  // pairs each user message of a replayed timeline with its files: by message id, else the oldest unpaired one with the same text
  function pairer(agentId: string) {
    const left = sent(agentId);
    return (item: UserItem) => {
      const byId = item.messageId ? left.findIndex((m) => m.messageId === item.messageId) : -1;
      const at = byId >= 0 ? byId : left.findIndex((m) => m.text.trim() === String(item.text || '').trim());
      return at < 0 ? undefined : left.splice(at, 1)[0].attachments;
    };
  }
  // a user message arriving live: the latest one sent with its id or text
  const latest = (agentId: string, item: UserItem) => sent(agentId).findLast((m) => (item.messageId && m.messageId === item.messageId) || m.text.trim() === String(item.text || '').trim())?.attachments;

  // ids any sent message or Ask log carries
  function sentIds() {
    const ids = new Set<string>();
    const scan = (dir: string, ext: RegExp) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir).filter((x) => ext.test(x))) for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/"id":\s*"([a-f0-9]{16})"/g)) ids.add(m[1]);
    };
    scan(SENT, /\.jsonl$/);
    scan(path.join(DATA, 'asks'), /\.jsonl?$/);
    return ids;
  }

  // uploads never sent (dropped from the composer, a message that never went) once older than maxAgeMs
  function sweep(now = Date.now(), maxAgeMs = SWEEP_AGE) {
    if (!fs.existsSync(DIR)) return [];
    const used = sentIds();
    const ids = new Set(fs.readdirSync(DIR).map((f) => f.replace(/\.json$/, '')).filter((id) => ID.test(id) && !used.has(id)));
    const mtime = (f: string) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0);
    const old = [...ids].filter((id) => now - Math.max(mtime(metaFile(id)), mtime(path.join(DIR, id))) > maxAgeMs);
    for (const id of old) {
      fs.rmSync(path.join(DIR, id), { recursive: true, force: true });
      fs.rmSync(metaFile(id), { force: true });
    }
    return old;
  }

  // POST /api/uploads?name=<file name> (raw body, Content-Type the file's) → UploadRef & { path } · GET|DELETE /api/uploads/<id>
  async function handle(req: Req, res: Res, parts: string[], send: Send) {
    const [, id] = parts;
    try {
      if (req.method === 'POST' && !id) {
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
        if (!MIME.test(type)) throw new HttpError(415, `unsupported Content-Type ${type}`);
        if (Number(req.headers['content-length'] || 0) > limitOf(type)) throw tooBig(type);
        const bytes = await readBytes(req, limitOf(type));
        if (!bytes) throw tooBig(type);
        return send(res, 200, store(new URL(req.url || '/', 'http://coco').searchParams.get('name') || '', type, bytes));
      }
      const up = id ? get(id) : null;
      if (!up) return send(res, 404, { error: 'no such upload' });
      if (req.method === 'GET') {
        const name = encodeURIComponent(up.fileName);
        res.writeHead(200, {
          'Content-Type': isImage(up.mimeType) ? up.mimeType : 'application/octet-stream',
          'Content-Disposition': `${isImage(up.mimeType) ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=31536000, immutable',
        });
        return fs.createReadStream(up.path).pipe(res);
      }
      if (req.method === 'DELETE') {
        fs.rmSync(path.dirname(up.path), { recursive: true, force: true });
        fs.rmSync(metaFile(up.id), { force: true });
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: `unsupported ${req.method}` });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { handle, store, get, resolve, record, pairer, latest, sweep };
}
export type Uploads = ReturnType<typeof createUploads>;

const ATTACHMENT_DIR = /^paseo-attachments-[\w-]{1,40}$/;
const ATTACHMENT_FILE = /^[a-f0-9]{16,128}\.(png|jpe?g|gif|webp)$/;
const ATTACHMENT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// GET /api/paseo-attachments/<dir>/<file>: images Paseo writes to its temp dir and links as file:// in an agent's text (a tool reading an image)
export function servePaseoAttachment(req: Req, res: Res, parts: string[], send: Send, tmpDir: string) {
  const [, dir, file] = parts;
  if (req.method !== 'GET' || !ATTACHMENT_DIR.test(dir || '') || !ATTACHMENT_FILE.test(file || '')) return send(res, 404, { error: 'no such attachment' });
  const full = path.join(tmpDir, dir, file);
  if (!fs.existsSync(full)) return send(res, 404, { error: 'no such attachment' });
  res.writeHead(200, { 'Content-Type': ATTACHMENT_MIME[file.split('.').pop() ?? ''], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' });
  return fs.createReadStream(full).pipe(res);
}
