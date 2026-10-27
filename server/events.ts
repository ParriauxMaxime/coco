// Live updates: one SSE stream per page carrying any number of topics, each replayed on subscribe like the per-topic routes it replaces.
// GET /api/events?sub=<topic>… opens it (first event `hello` with its id) · POST /api/events/<id>/subs { add, remove } changes its topics.
// Each message is { topic, event, data }: `open` starts a topic's replay, `error` says it cannot be followed, any other event is the topic's own.
// A `ping` event every pingMs lets the page tell a live stream from one a proxy left hanging.
import { randomUUID } from 'node:crypto';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import type { ReadBody, Req, Res, Send } from './core-types.ts';

// json: an already serialized value; event: the SSE event name, none for a plain message
export type Sink = { send(json: string, event?: string): void; onClose(fn: () => void): void; readonly closed: boolean };
export type Topic = (sink: Sink, ...args: string[]) => unknown;

const PING_MS = 25000;
const HEAD = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' };

export const topicOf = (name: string, ...args: (string | number)[]) => [name, ...args.map((a) => encodeURIComponent(String(a)))].join(':');
export function parseTopic(topic: string) {
  const [name, ...args] = topic.split(':');
  try {
    return { name, args: args.map(decodeURIComponent) };
  } catch {
    throw new HttpError(400, `bad topic ${topic}`);
  }
}

function sinkOf(write: (json: string, event?: string) => void) {
  const closers: (() => void)[] = [];
  let closed = false;
  const sink: Sink = {
    send: (json, event) => closed || write(json, event),
    onClose: (fn) => (closed ? fn() : closers.push(fn)),
    get closed() {
      return closed;
    },
  };
  const close = () => {
    if (closed) return;
    closed = true;
    closers.splice(0).forEach((fn) => fn());
  };
  return { sink, close };
}

// one topic on its own response, as the per-topic routes stream it
export function sseSink(req: Req, res: Res): Sink {
  res.writeHead(200, HEAD);
  const { sink, close } = sinkOf((json, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${json}\n\n`));
  req.on('close', close);
  return sink;
}

type Conn = { res: Res; subs: Map<string, () => void> };

export function createHub({ pingMs = PING_MS } = {}) {
  const topics = new Map<string, Topic>();
  const conns = new Map<string, Conn>();

  function subscribe(conn: Conn, topic: string) {
    conn.subs.get(topic)?.();
    const head = `data: {"topic":${JSON.stringify(topic)},"event":`;
    const { sink, close } = sinkOf((json, event = 'message') => conn.res.write(`${head}${JSON.stringify(event)},"data":${json}}\n\n`));
    conn.subs.set(topic, close);
    sink.send('null', 'open');
    const fail = (e: unknown) => sink.send(JSON.stringify({ error: errorMessage(e), status: httpStatus(e) }), 'error');
    try {
      const { name, args } = parseTopic(topic);
      const follow = topics.get(name);
      if (!follow) throw new HttpError(404, `unknown topic ${name}`);
      Promise.resolve(follow(sink, ...args)).catch(fail);
    } catch (e) {
      fail(e);
    }
  }

  function unsubscribe(conn: Conn, topic: string) {
    conn.subs.get(topic)?.();
    conn.subs.delete(topic);
  }

  function connect(req: Req, res: Res, subs: string[]) {
    const id = randomUUID();
    const conn: Conn = { res, subs: new Map() };
    res.writeHead(200, HEAD);
    res.write(`event: hello\ndata: ${JSON.stringify({ id })}\n\n`);
    conns.set(id, conn);
    for (const t of new Set(subs)) subscribe(conn, t);
    const ping = setInterval(() => res.write('event: ping\ndata: 0\n\n'), pingMs);
    req.on('close', () => {
      clearInterval(ping);
      conns.delete(id);
      for (const t of [...conn.subs.keys()]) unsubscribe(conn, t);
    });
    return id;
  }

  // a topic already followed is subscribed again: its subscribers get `open` and the replay
  function change(id: string, { add = [], remove = [] }: { add?: unknown; remove?: unknown }) {
    const conn = conns.get(id);
    if (!conn) throw new HttpError(404, 'no such stream: reconnect');
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []);
    for (const t of list(remove)) unsubscribe(conn, t);
    for (const t of new Set(list(add))) subscribe(conn, t);
    return { topics: [...conn.subs.keys()] };
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [, id, action] = parts;
    try {
      if (!id && req.method === 'GET') return void connect(req, res, new URL(req.url || '/', 'http://coco').searchParams.getAll('sub'));
      if (id && action === 'subs' && req.method === 'POST') {
        let body: unknown;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          throw new HttpError(400, 'the body is not JSON');
        }
        return send(res, 200, change(id, body && typeof body === 'object' ? body : {}));
      }
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return {
    topic: (name: string, follow: Topic) => void topics.set(name, follow),
    connect,
    change,
    handle,
    streams: () => conns.size,
  };
}
