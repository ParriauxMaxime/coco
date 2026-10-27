import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHub, parseTopic, sseSink, topicOf } from './events.ts';
import type { Sink } from './events.ts';
import type { Req, Res } from './core-types.ts';

type Msg = { event: string; data: unknown };

function stream() {
  const req = new EventEmitter() as unknown as Req;
  const chunks: string[] = [];
  const res = { writeHead: () => res, write: (c: string) => chunks.push(c) > 0 } as unknown as Res;
  const parsed = () =>
    chunks.filter((c) => !c.startsWith(':')).map((c): Msg => {
      const event = /^event: (.*)$/m.exec(c)?.[1] ?? 'message';
      return { event, data: JSON.parse(/^data: (.*)$/m.exec(c)?.[1] ?? 'null') };
    });
  return { req, res, chunks, parsed, close: () => (req as unknown as EventEmitter).emit('close') };
}

// a topic with a replayed history and live pushes; closed counts its ended subscriptions
function fakeTopic() {
  const live = new Set<Sink>();
  let closed = 0;
  const follow = (sink: Sink, id: string) => {
    if (id === 'missing') throw Object.assign(new Error('no such thing'), { status: 404 });
    sink.send(JSON.stringify({ replay: id }));
    live.add(sink);
    sink.onClose(() => (live.delete(sink), closed++));
  };
  const push = (data: unknown, event?: string) => live.forEach((s) => s.send(JSON.stringify(data), event));
  return { follow, push, live, closed: () => closed };
}

const hubWith = () => {
  const hub = createHub({ pingMs: 60000 });
  const chat = fakeTopic();
  hub.topic('chat', chat.follow);
  return { hub, chat };
};
const envelopes = (s: ReturnType<typeof stream>) => s.parsed().filter((m) => m.event === 'message').map((m) => m.data);

test('a stream says hello with its id, then opens and replays each topic it was asked for, every message naming its topic', () => {
  const { hub, chat } = hubWith();
  const s = stream();
  const id = hub.connect(s.req, s.res, ['chat:a', 'chat:a', 'chat:b']);
  const [hello] = s.parsed();
  assert.deepEqual(hello, { event: 'hello', data: { id } });
  assert.deepEqual(envelopes(s), [
    { topic: 'chat:a', event: 'open', data: null },
    { topic: 'chat:a', event: 'message', data: { replay: 'a' } },
    { topic: 'chat:b', event: 'open', data: null },
    { topic: 'chat:b', event: 'message', data: { replay: 'b' } },
  ]);
  chat.push([1], 'cards');
  assert.deepEqual(envelopes(s).slice(4), [
    { topic: 'chat:a', event: 'cards', data: [1] },
    { topic: 'chat:b', event: 'cards', data: [1] },
  ]);
  s.close();
});

test('an unknown topic or one that cannot be followed answers an error event on that topic only', () => {
  const { hub } = hubWith();
  const s = stream();
  hub.connect(s.req, s.res, ['nope:x', 'chat:missing']);
  assert.deepEqual(envelopes(s), [
    { topic: 'nope:x', event: 'open', data: null },
    { topic: 'nope:x', event: 'error', data: { error: 'unknown topic nope', status: 404 } },
    { topic: 'chat:missing', event: 'open', data: null },
    { topic: 'chat:missing', event: 'error', data: { error: 'no such thing', status: 404 } },
  ]);
  s.close();
});

test('subscriptions change without reconnecting: an added topic replays, adding it again replays it again, a removed one stops', () => {
  const { hub, chat } = hubWith();
  const s = stream();
  const id = hub.connect(s.req, s.res, []);
  assert.deepEqual(hub.change(id, { add: ['chat:a'] }), { topics: ['chat:a'] });
  hub.change(id, { add: ['chat:a'] });
  assert.equal(chat.live.size, 1);
  assert.equal(chat.closed(), 1);
  assert.deepEqual(envelopes(s).map((m) => (m as { event: string }).event), ['open', 'message', 'open', 'message']);
  assert.deepEqual(hub.change(id, { remove: ['chat:a'], add: [7] }), { topics: [] });
  assert.equal(chat.live.size, 0);
  chat.push('late');
  assert.equal(envelopes(s).length, 4);
  assert.throws(() => hub.change('gone', { add: ['chat:a'] }), { status: 404 });
  s.close();
});

test('closing the stream ends every topic it followed and forgets it', () => {
  const { hub, chat } = hubWith();
  const s = stream();
  const id = hub.connect(s.req, s.res, ['chat:a', 'chat:b']);
  assert.equal(hub.streams(), 1);
  s.close();
  assert.equal(chat.closed(), 2);
  assert.equal(hub.streams(), 0);
  chat.push('late');
  assert.equal(envelopes(s).length, 4);
  assert.throws(() => hub.change(id, { remove: ['chat:a'] }), { status: 404 });
});

test('a topic name keeps any character of its arguments', () => {
  const t = topicOf('thread', 'my-work', 'b:feat/x');
  assert.equal(t, 'thread:my-work:b%3Afeat%2Fx');
  assert.deepEqual(parseTopic(t), { name: 'thread', args: ['my-work', 'b:feat/x'] });
  assert.throws(() => parseTopic('thread:%E0'), { status: 400 });
});

test('a per-topic route streams plain SSE events and stops writing once the page leaves', () => {
  const s = stream();
  const sink = sseSink(s.req, s.res);
  sink.send('{"a":1}');
  sink.send('[]', 'cards');
  let ended = 0;
  sink.onClose(() => ended++);
  s.close();
  sink.send('{"a":2}');
  assert.deepEqual(s.chunks, ['data: {"a":1}\n\n', 'event: cards\ndata: []\n\n']);
  assert.equal(ended, 1);
  assert.equal(sink.closed, true);
});
