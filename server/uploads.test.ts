import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FILES_ONLY, IMAGE_MAX, SWEEP_AGE, agentInput, createUploads, safeName } from './uploads.ts';
import { createPaseoAgents } from './paseo-agent.ts';
import type { DaemonAgent, DaemonClient } from './paseo-agent.ts';
import { createAsk } from './ask.ts';
import { createWorkAgents } from './work-agents.ts';
import { DEFAULTS } from './config.ts';
import type { Req, Res } from './core-types.ts';

const AGENT = '11111111-2222-3333-4444-555555555555';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-test-'));
const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  return null;
};

// one agent behind the SDK surface coco uses, recording what create and send got
function fakeDaemon() {
  const created: Record<string, unknown>[] = [];
  const sent: { text: string; opts?: Record<string, unknown> }[] = [];
  const agent = {
    id: AGENT,
    workspaceId: 'wks',
    timeline: { subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }) },
    send: async (text: string, opts?: Record<string, unknown>) => void sent.push({ text, opts }),
    waitForFinish: async () => ({ status: 'idle', lastMessage: 'Seen.' }),
    refresh: async () => ({ agent: { status: 'idle' } }),
    archive: async () => ({}),
  } as unknown as DaemonAgent;
  const handle = { id: 'wks', agents: { create: async (opts: Record<string, unknown>) => (created.push(opts), agent) } };
  const client = { workspaces: { list: async () => ({ entries: [{ id: 'wks', workspaceDirectory: '/acme' }] }), ref: () => handle, open: async () => handle, create: async () => handle }, agents: { ref: () => agent } } as unknown as DaemonClient;
  return { client, created, sent };
}

test('an upload is stored under uploads/<id>/<safe name>, images checked against their type and size, and a message takes at most 8 known ids', () => {
  const DATA = tmpDir();
  const uploads = createUploads({ DATA });
  const png = uploads.store('../../shot 1.png', 'image/png', PNG);
  assert.equal(png.path, path.join(DATA, 'uploads', png.id, 'shot 1.png'));
  assert.deepEqual(fs.readFileSync(png.path), PNG);
  assert.equal(status(() => uploads.store('fake.png', 'image/png', Buffer.from('not a png'))), 415);
  assert.equal(status(() => uploads.store('big.png', 'image/png', Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX)]))), 413);
  assert.equal(status(() => uploads.store('empty.txt', 'text/plain', Buffer.alloc(0))), 400);
  const pdf = uploads.store('spec.pdf', 'application/pdf', Buffer.from('%PDF-1.7'));
  assert.deepEqual(uploads.resolve([png.id, pdf.id]).map((u) => u.fileName), ['shot 1.png', 'spec.pdf']);
  assert.equal(status(() => uploads.resolve(['0123456789abcdef'])), 400);
  assert.equal(status(() => uploads.resolve(Array(9).fill(png.id))), 400);
  assert.equal(safeName('/etc/.passwd'), 'passwd');
  assert.deepEqual(agentInput([png, pdf]), {
    images: [{ data: PNG.toString('base64'), mimeType: 'image/png' }],
    attachments: [{ type: 'uploaded_file', id: pdf.id, fileName: 'spec.pdf', mimeType: 'application/pdf', size: 8, path: pdf.path }],
  });
});

test('a new agent created with a prompt gets its images and message id with it', async () => {
  const daemon = fakeDaemon();
  const DATA = tmpDir();
  const png = createUploads({ DATA }).store('shot.png', 'image/png', PNG);
  await createPaseoAgents({ connect: async () => daemon.client }).start({ title: 'Look', prompt: 'What is wrong here?', cwd: '/acme', input: { ...agentInput([png]), messageId: 'm1' } });
  assert.equal(daemon.created[0].prompt, 'What is wrong here?');
  assert.deepEqual(daemon.created[0].images, [{ data: PNG.toString('base64'), mimeType: 'image/png' }]);
  assert.equal(daemon.created[0].clientMessageId, 'm1');
});

test('Ask coco sends the first message with its images and files, and keeps their refs on the user event', async () => {
  const daemon = fakeDaemon();
  const DATA = tmpDir();
  const uploads = createUploads({ DATA });
  const png = uploads.store('shot.png', 'image/png', PNG);
  const log = uploads.store('build.log', 'text/plain', Buffer.from('boom'));
  const ask = createAsk({ DATA, REPO: '/acme', config: { ...DEFAULTS, owner: { name: 'Alice' } }, works: { get: () => undefined, save: () => {}, prInfo: async () => null }, agents: createPaseoAgents({ connect: async () => daemon.client }), uploads });
  const run = await new Promise<ReturnType<typeof ask.start>>((resolve) => ask.start({ prompt: 'Why does it fail?', files: [png, log] }, { onEnd: resolve }));

  assert.deepEqual(daemon.sent[0].opts?.images, [{ data: PNG.toString('base64'), mimeType: 'image/png' }]);
  assert.deepEqual(daemon.sent[0].opts?.attachments, [{ type: 'uploaded_file', id: log.id, fileName: 'build.log', mimeType: 'text/plain', size: 4, path: log.path }]);
  assert.deepEqual(run.events.find((e) => e.type === 'user')?.attachments, [{ id: png.id, fileName: 'shot.png', mimeType: 'image/png', size: PNG.length }, { id: log.id, fileName: 'build.log', mimeType: 'text/plain', size: 4 }]);
});

test("a message to any agent carries its files, and the agent's chat replays them on the user message Paseo kept as text", async () => {
  const daemon = fakeDaemon();
  const DATA = tmpDir();
  const uploads = createUploads({ DATA });
  const png = uploads.store('shot.png', 'image/png', PNG);
  const agents = createWorkAgents({ client: async () => daemon.client, asks: () => [], linked: () => [], onAgent: () => () => {}, serverId: async () => null, uploads });
  let answer: unknown = null;
  const post = { method: 'POST' } as Req;
  await agents.handle(post, {} as Res, ['agent-chat', AGENT, 'messages'], async () => JSON.stringify({ text: '', attachments: [png.id] }), (_res, code, body) => void (answer = { code, body }));

  assert.deepEqual(answer, { code: 200, body: { ok: true } });
  const [{ text, opts }] = daemon.sent;
  assert.equal(text, FILES_ONLY);
  assert.deepEqual(opts?.images, [{ data: PNG.toString('base64'), mimeType: 'image/png' }]);
  assert.equal(typeof opts?.messageId, 'string');
  const pair = uploads.pairer(AGENT);
  assert.deepEqual(pair({ text: 'something else' }), undefined);
  assert.deepEqual(pair({ text: FILES_ONLY }), [{ id: png.id, fileName: 'shot.png', mimeType: 'image/png', size: PNG.length }]);
  assert.equal(pair({ text: FILES_ONLY }), undefined);
});

test('the sweep removes uploads never sent once older than a day, and keeps sent, Ask-logged and fresh ones', () => {
  const DATA = tmpDir();
  const uploads = createUploads({ DATA });
  const [sent, asked, stale, fresh] = ['a.png', 'b.png', 'c.png', 'd.png'].map((n) => uploads.store(n, 'image/png', PNG));
  uploads.record(AGENT, { messageId: 'm1', text: 'see', at: '', attachments: [sent] });
  fs.mkdirSync(path.join(DATA, 'asks'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'asks', 'conv.jsonl'), JSON.stringify({ type: 'user', text: 'see', attachments: [{ id: asked.id }] }) + '\n');
  const old = new Date(Date.now() - 2 * SWEEP_AGE);
  for (const up of [sent, asked, stale]) {
    fs.utimesSync(path.dirname(up.path), old, old);
    fs.utimesSync(path.join(DATA, 'uploads', `${up.id}.json`), old, old);
  }

  assert.deepEqual(uploads.sweep(), [stale.id]);
  assert.equal(uploads.get(stale.id), null);
  assert.equal(fs.existsSync(path.dirname(stale.path)), false);
  for (const up of [sent, asked, fresh]) assert.ok(uploads.get(up.id));
});
