import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createDictation } from './dictation.ts';
import type { VoiceApi } from './paseo-agent.ts';
import type { Sink } from './events.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PCM = Buffer.alloc(320).toString('base64');

// a daemon whose dictation answers like Paseo's: ack on start, the chunks kept, the transcript on finish
function fakeDaemon({ caps = { enabled: true, reason: '' } as { enabled: boolean; reason: string } | null, startError = '' } = {}) {
  const calls = { started: [] as [string, string][], chunks: [] as [string, number, string][], finished: [] as [string, number][], cancelled: [] as string[] };
  const handlers = new Map<string, (m: unknown) => void>();
  const d = {
    getLastServerInfoMessage: () => ({ capabilities: caps ? { voice: { dictation: caps, voice: caps } } : undefined }),
    on: (type: string, h: (m: unknown) => void) => (handlers.set(type, h), () => handlers.delete(type)),
    startDictationStream: async (id: string, format: string) => {
      if (startError) throw new Error(startError);
      calls.started.push([id, format]);
    },
    sendDictationStreamChunk: (id: string, seq: number, audio: string) => void calls.chunks.push([id, seq, audio]),
    finishDictationStream: async (id: string, finalSeq: number) => {
      calls.finished.push([id, finalSeq]);
      return { dictationId: id, text: ' hello coco ' };
    },
    cancelDictationStream: (id: string) => void calls.cancelled.push(id),
  };
  const emit = (type: string, payload: unknown) => handlers.get(type)?.({ type, payload });
  return { d: d as unknown as VoiceApi, calls, emit };
}

type Out = { status: number; body: Record<string, unknown> & { error: string } };
function caller(daemon: () => Promise<VoiceApi | null>, idleMs?: number) {
  const dict = createDictation({ daemon, idleMs });
  const call = async (method: string, url: string, body?: unknown): Promise<Out> => {
    const out = { status: 0, body: {} } as Out;
    const req = new IncomingMessage(new Socket());
    req.method = method;
    req.url = url;
    const parts = url.split('/').filter(Boolean).slice(1);
    const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    await dict.handle(req, new ServerResponse(req), parts, async () => raw, (_r, status, b) => void Object.assign(out, { status, body: b }));
    return out;
  };
  return { dict, call };
}

function sinkOf() {
  const sent: [string | undefined, unknown][] = [];
  const closers: (() => void)[] = [];
  const sink: Sink = { send: (json, event) => void sent.push([event, JSON.parse(json)]), onClose: (fn) => void closers.push(fn), closed: false };
  return { sink, sent, close: () => closers.forEach((f) => f()) };
}

test('status follows the daemon: off when Paseo is away or its dictation is disabled', async (t) => {
  const away = caller(async () => null);
  t.after(away.dict.close);
  assert.deepEqual((await away.call('GET', '/api/dictation')).body, { available: false, reason: 'Paseo is not connected' });
  const off = caller(async () => fakeDaemon({ caps: { enabled: false, reason: 'Dictation STT not configured' } }).d);
  t.after(off.dict.close);
  assert.deepEqual((await off.call('GET', '/api/dictation')).body, { available: false, reason: 'Dictation STT not configured' });
  assert.equal((await off.call('POST', '/api/dictation', { id: ID, rate: 16000 })).status, 503);
  const old = caller(async () => fakeDaemon({ caps: null }).d);
  t.after(old.dict.close);
  assert.equal((await old.call('GET', '/api/dictation')).body.available, true);
});

test('start, audio and finish refuse a bad id, rate, chunk, body or route', async (t) => {
  const { d, calls } = fakeDaemon();
  const { dict, call } = caller(async () => d);
  t.after(dict.close);
  assert.equal((await call('POST', '/api/dictation', { id: 'nope', rate: 16000 })).status, 400);
  assert.equal((await call('POST', '/api/dictation', { id: ID, rate: 16000.5 })).status, 400);
  assert.equal((await call('POST', '/api/dictation', { id: ID, rate: 96000 })).status, 400);
  assert.equal((await call('POST', '/api/dictation', 'not json')).status, 400);
  assert.equal((await call('POST', '/api/dictation', [1])).status, 400);
  assert.equal((await call('PUT', '/api/dictation', { id: ID, rate: 16000 })).status, 404);
  assert.equal((await call('POST', '/api/dictation/bad/audio', { audio: PCM })).status, 400);
  assert.equal((await call('POST', `/api/dictation/${ID}/audio`, { audio: PCM })).status, 404, 'not started');
  assert.equal((await call('POST', '/api/dictation', { id: ID, rate: 16000 })).status, 200);
  assert.equal((await call('POST', '/api/dictation', { id: ID, rate: 16000 })).status, 409, 'started twice');
  assert.equal((await call('POST', `/api/dictation/${ID}/audio`, { audio: 'not base64!' })).status, 400);
  assert.equal((await call('POST', `/api/dictation/${ID}/audio`, { audio: Buffer.alloc(3).toString('base64') })).status, 400, 'odd byte count');
  assert.equal((await call('POST', `/api/dictation/${ID}/audio`, { audio: 'A'.repeat(200 * 1024) })).status, 400, 'too big');
  assert.equal((await call('POST', `/api/dictation/${ID}/audio`, {})).status, 400);
  assert.equal((await call('POST', `/api/dictation/${ID}/merge`, {})).status, 404);
  assert.equal((await call('POST', `/api/dictation/${ID}/audio/x`, { audio: PCM })).status, 404);
  assert.deepEqual(calls.chunks, []);
});

test('a dictation relays its chunks in order with the format it started with, partials and the final reach its followers', async (t) => {
  const { d, calls, emit } = fakeDaemon();
  const { dict, call } = caller(async () => d);
  t.after(dict.close);
  const follower = sinkOf();
  dict.watch(follower.sink, ID);
  assert.deepEqual((await call('POST', '/api/dictation', { id: ID, rate: 16000 })).body, { ok: true, format: 'audio/pcm;rate=16000;bits=16' });
  assert.deepEqual(calls.started, [[ID, 'audio/pcm;rate=16000;bits=16']]);
  assert.equal((await call('POST', `/api/dictation/${ID}/audio`, { audio: PCM })).body.seq, 0);
  assert.equal((await call('POST', `/api/dictation/${ID}/audio`, { audio: PCM })).body.seq, 1);
  assert.deepEqual(calls.chunks.map((c) => c[1]), [0, 1]);
  emit('dictation_stream_partial', { dictationId: ID, text: 'hello' });
  emit('dictation_stream_partial', { dictationId: 'another', text: 'not ours' });
  // a page that follows late gets the transcript so far
  const late = sinkOf();
  dict.watch(late.sink, ID);
  assert.deepEqual(late.sent, [['partial', { text: 'hello' }]]);
  assert.deepEqual((await call('POST', `/api/dictation/${ID}/finish`)).body, { text: 'hello coco' });
  assert.deepEqual(calls.finished, [[ID, 1]]);
  assert.deepEqual(follower.sent, [['partial', { text: 'hello' }], ['final', { text: 'hello coco' }]]);
  assert.equal((await call('POST', `/api/dictation/${ID}/audio`, { audio: PCM })).status, 404, 'ended');
});

test('a dictation the daemon fails, the page cancels, or nobody feeds ends with a reason', async (t) => {
  const { d, calls, emit } = fakeDaemon();
  const { dict, call } = caller(async () => d, 30);
  t.after(dict.close);
  const follower = sinkOf();
  dict.watch(follower.sink, ID);
  await call('POST', '/api/dictation', { id: ID, rate: 48000 });
  emit('dictation_stream_error', { dictationId: ID, error: 'model missing', retryable: false });
  assert.deepEqual(follower.sent.at(-1), ['failed', { error: 'model missing' }]);
  assert.equal((await call('POST', `/api/dictation/${ID}/finish`)).status, 404);

  await call('POST', '/api/dictation', { id: ID, rate: 16000 });
  assert.deepEqual((await call('POST', `/api/dictation/${ID}/cancel`)).body, { ok: true });
  assert.deepEqual(calls.cancelled, [ID]);
  assert.deepEqual(follower.sent.at(-1), ['failed', { error: 'cancelled' }]);

  // finishing before any audio: nothing to transcribe, the stream is let go
  await call('POST', '/api/dictation', { id: ID, rate: 16000 });
  assert.deepEqual((await call('POST', `/api/dictation/${ID}/finish`)).body, { text: '' });
  assert.equal(calls.finished.length, 0);

  await call('POST', '/api/dictation', { id: ID, rate: 16000 });
  await new Promise((r) => setTimeout(r, 120));
  assert.match(String((follower.sent.at(-1)?.[1] as { error?: string }).error), /no audio/);
  follower.close();
});

test('a start Paseo refuses frees its id, and at most four run at once', async (t) => {
  const bad = fakeDaemon({ startError: 'Dictation STT not configured' });
  const refused = caller(async () => bad.d);
  t.after(refused.dict.close);
  const r = await refused.call('POST', '/api/dictation', { id: ID, rate: 16000 });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /STT not configured/);
  assert.equal((await refused.call('POST', `/api/dictation/${ID}/audio`, { audio: PCM })).status, 404);

  const { d } = fakeDaemon();
  const { dict, call } = caller(async () => d);
  t.after(dict.close);
  const ids = [1, 2, 3, 4, 5].map((n) => `0f8fad5b-d9cb-469f-a165-7086772895${String(n).padStart(2, '0')}`);
  for (const id of ids.slice(0, 4)) assert.equal((await call('POST', '/api/dictation', { id, rate: 16000 })).status, 200);
  assert.equal((await call('POST', '/api/dictation', { id: ids[4], rate: 16000 })).status, 429);
});
