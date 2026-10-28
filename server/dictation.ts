// Dictation in coco's composers through Paseo's own speech to text (the daemon's `features.dictation`, as the Paseo app's mic uses it):
// the page captures the mic as 16-bit mono PCM and posts it here in short chunks; coco relays them on its daemon connection.
// GET /api/dictation { available, reason } · POST /api/dictation { id, rate } starts · POST /api/dictation/<id>/audio { audio } (base64 PCM16 LE)
// POST /api/dictation/<id>/finish → { text } · POST /api/dictation/<id>/cancel
// topic dictation:<id>: `partial` { text } (the whole transcript so far) · `final` { text } · `failed` { error }
import { HttpError, errorMessage, errorStatus } from './core-types.ts';
import { within } from './workspace-git.ts';
import type { VoiceApi } from './paseo-agent.ts';
import type { ReadBody, Req, Res, Send } from './core-types.ts';
import type { Sink } from './events.ts';

type Deps = {
  // the daemon's dictation calls while it is connected, else null
  daemon: () => Promise<VoiceApi | null>;
  idleMs?: number;
};
type Session = { id: string; d: VoiceApi; format: string; seq: number; text: string; started: number; last: number; done: boolean };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MIN_RATE = 8000;
const MAX_RATE = 48000;
// one second of 48 kHz audio, base64
const MAX_CHUNK = 136 * 1024;
const MAX_SESSIONS = 4;
const MAX_MS = 10 * 60 * 1000;
const IDLE_MS = 30000;
const START_MS = 30000;
const FINISH_MS = 60000;

export const pcmFormat = (rate: number) => `audio/pcm;rate=${rate};bits=16`;

export function createDictation({ daemon, idleMs = IDLE_MS }: Deps) {
  const sessions = new Map<string, Session>();
  const sinks = new Map<string, Set<Sink>>();
  const hooked = new WeakSet<VoiceApi>();
  const emit = (id: string, event: string, data: unknown) => sinks.get(id)?.forEach((s) => s.send(JSON.stringify(data), event));

  const api = async () => {
    const d = await within(daemon(), 2000).catch(() => null);
    if (!d) throw new HttpError(503, 'Paseo is not connected: dictation runs in its daemon');
    return d;
  };

  // the daemon says whether its speech to text is set up (Paseo settings, Dictation); one too old to say is tried
  async function status() {
    const d = await within(daemon(), 2000).catch(() => null);
    if (!d) return { available: false, reason: 'Paseo is not connected' };
    const cap = d.getLastServerInfoMessage()?.capabilities?.voice?.dictation;
    if (cap && !cap.enabled) return { available: false, reason: cap.reason || 'dictation is off in Paseo (Settings → Dictation)' };
    return { available: true, reason: null };
  }

  function end(s: Session, event: 'final' | 'failed', data: unknown) {
    if (s.done) return;
    s.done = true;
    sessions.delete(s.id);
    emit(s.id, event, data);
  }
  const fail = (s: Session, error: string) => {
    if (!s.done) {
      try {
        s.d.cancelDictationStream(s.id);
      } catch {}
    }
    end(s, 'failed', { error });
  };

  function hook(d: VoiceApi) {
    if (hooked.has(d)) return;
    hooked.add(d);
    d.on('dictation_stream_partial', (m) => {
      const s = sessions.get(m.payload.dictationId);
      if (!s || s.d !== d) return;
      s.text = m.payload.text;
      emit(s.id, 'partial', { text: s.text });
    });
    d.on('dictation_stream_error', (m) => {
      const s = sessions.get(m.payload.dictationId);
      if (s && s.d === d) end(s, 'failed', { error: m.payload.error });
    });
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (now - s.last > idleMs) fail(s, 'no audio for a while: dictation stopped');
      else if (now - s.started > MAX_MS) fail(s, 'dictation stops after 10 minutes');
    }
  }, Math.min(idleMs, 5000));
  sweep.unref?.();

  async function start(body: Record<string, unknown>) {
    const { id, rate } = body;
    if (typeof id !== 'string' || !ID.test(id)) throw new HttpError(400, 'id: a uuid');
    if (!Number.isInteger(rate) || (rate as number) < MIN_RATE || (rate as number) > MAX_RATE) throw new HttpError(400, `rate: a whole number of Hz from ${MIN_RATE} to ${MAX_RATE}`);
    if (sessions.has(id)) throw new HttpError(409, 'this dictation already started');
    if (sessions.size >= MAX_SESSIONS) throw new HttpError(429, `at most ${MAX_SESSIONS} dictations at once`);
    const avail = await status();
    if (!avail.available) throw new HttpError(503, avail.reason ?? 'dictation is not available');
    const d = await api();
    hook(d);
    const now = Date.now();
    const s: Session = { id, d, format: pcmFormat(rate as number), seq: 0, text: '', started: now, last: now, done: false };
    sessions.set(id, s);
    try {
      await within(d.startDictationStream(id, s.format), START_MS);
    } catch (e) {
      s.done = true;
      sessions.delete(id);
      throw new HttpError(502, `Paseo did not start dictation: ${errorMessage(e)}`);
    }
    return { ok: true, format: s.format };
  }

  const live = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new HttpError(404, 'no such dictation: it ended or never started');
    return s;
  };

  function audio(s: Session, body: Record<string, unknown>) {
    const { audio } = body;
    if (typeof audio !== 'string' || !audio || audio.length > MAX_CHUNK || !BASE64.test(audio)) throw new HttpError(400, `audio: base64 PCM, at most ${MAX_CHUNK} characters`);
    if (Buffer.byteLength(audio, 'base64') % 2) throw new HttpError(400, 'audio: 16-bit samples, an even number of bytes');
    try {
      s.d.sendDictationStreamChunk(s.id, s.seq, audio, s.format);
    } catch (e) {
      fail(s, `Paseo dropped the dictation: ${errorMessage(e)}`);
      throw new HttpError(502, `Paseo dropped the dictation: ${errorMessage(e)}`);
    }
    s.seq += 1;
    s.last = Date.now();
    return { ok: true, seq: s.seq - 1 };
  }

  async function finish(s: Session) {
    // nothing was said: nothing to transcribe
    if (!s.seq) {
      fail(s, 'no audio');
      return { text: '' };
    }
    s.last = Date.now() + FINISH_MS;
    try {
      const r = await within(s.d.finishDictationStream(s.id, s.seq - 1), FINISH_MS);
      const text = r.text.trim();
      end(s, 'final', { text });
      return { text };
    } catch (e) {
      fail(s, errorMessage(e));
      throw new HttpError(502, `Paseo did not transcribe it: ${errorMessage(e)}`);
    }
  }

  // a page following a dictation: the transcript so far first, then each change
  function watch(sink: Sink, id: string) {
    if (!ID.test(id)) throw new HttpError(400, 'bad dictation id');
    const set = sinks.get(id) ?? new Set<Sink>();
    sinks.set(id, set);
    set.add(sink);
    const text = sessions.get(id)?.text;
    if (text) sink.send(JSON.stringify({ text }), 'partial');
    sink.onClose(() => {
      set.delete(sink);
      if (!set.size && sinks.get(id) === set) sinks.delete(id);
    });
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [, id, action, extra] = parts;
    try {
      if (req.method === 'GET' && !id) return send(res, 200, await status());
      if (req.method !== 'POST' || extra !== undefined || (id && !action) || (!id && action)) throw new HttpError(404, 'no route');
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        throw new HttpError(400, 'the body is not JSON');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'the body must be an object');
      if (!id) return send(res, 200, await start(body as Record<string, unknown>));
      if (!ID.test(id)) throw new HttpError(400, 'bad dictation id');
      if (action === 'audio') return send(res, 200, audio(live(id), body as Record<string, unknown>));
      if (action === 'finish') return send(res, 200, await finish(live(id)));
      if (action === 'cancel') {
        const s = sessions.get(id);
        if (s) fail(s, 'cancelled');
        return send(res, 200, { ok: true });
      }
      throw new HttpError(404, 'no route');
    } catch (e) {
      return send(res, errorStatus(e), { error: errorMessage(e) });
    }
  }

  return { handle, watch, status, close: () => clearInterval(sweep) };
}
