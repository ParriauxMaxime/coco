import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cocoOrigins, createBrowserHost, createBrowserTabs, keyEvents, pageUrl, workspaceFile } from './browser-host.ts';
import type { HostLink } from './browser-host.ts';
import type { Cdp, Msg } from './screenshot.ts';

type Call = { method: string; params: Record<string, any>; sessionId?: string };

// a Chrome that answers each DevTools call from a table, and records them
function fakeChrome(answers: Record<string, (p: Record<string, any>) => Record<string, any>> = {}) {
  const calls: Call[] = [];
  const listeners = new Set<(m: Msg) => void>();
  let targets = 0;
  let contexts = 0;
  const cdp: Cdp = {
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (answers[method]) return answers[method](params);
      if (method === 'Target.createBrowserContext') return { browserContextId: `C${++contexts}` };
      if (method === 'Browser.getVersion') return { userAgent: 'Mozilla/5.0 HeadlessChrome/150.0.0.0' };
      if (method === 'Target.createTarget') return { targetId: `T${++targets}` };
      if (method === 'Target.attachToTarget') return { sessionId: `S-${params.targetId}` };
      if (method === 'Target.getTargetInfo') return { targetInfo: { url: 'http://localhost:3000/', title: 'Dev' } };
      if (method === 'Runtime.evaluate' && String(params.expression).includes('coco.refs')) return { result: { objectId: 'EL1' } };
      if (method === 'Runtime.evaluate' && params.expression === 'document.readyState') return { result: { value: 'complete' } };
      if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('getBoundingClientRect')) return { result: { value: { x: 100.4, y: 50.6 } } };
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') };
      return {};
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  let released = 0;
  return { cdp, calls, emit: (m: Msg) => listeners.forEach((fn) => fn(m)), hold: () => ({ browser: async () => cdp, release: () => void released++ }), released: () => released };
}

const req = (command: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'browser.automation.execute.request' as const, requestId: 'browser_1', agentId: 'agent-1', workspaceId: 'ws-1', cwd: '/tmp', command, ...extra }) as never;

const block = cocoOrigins([8790, 8777, 8778], ['http://127.0.0.1:8790', 'coco.local']);

async function withTab(answers?: Parameters<typeof fakeChrome>[0]) {
  const chrome = fakeChrome(answers);
  const tabs = createBrowserTabs({ hold: chrome.hold, block });
  const r = await tabs.execute(req({ command: 'new_tab', args: { url: 'http://localhost:3000/' } }));
  assert.equal(r.ok, true, JSON.stringify(r));
  const browserId = r.ok && r.result.command === 'new_tab' ? r.result.browserId : '';
  return { chrome, tabs, browserId };
}

test('new_tab opens a target in the workspace with a uuid browserId and navigates it', async () => {
  const { chrome, tabs, browserId } = await withTab();
  assert.match(browserId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const nav = chrome.calls.find((c) => c.method === 'Page.navigate');
  assert.deepEqual([nav?.params.url, nav?.sessionId], ['http://localhost:3000/', 'S-T1']);
  assert.ok(chrome.calls.some((c) => c.method === 'Emulation.setDeviceMetricsOverride' && c.params.width === 1280));
  assert.deepEqual(tabs.list('agent-1').map((t) => [t.browserId, t.workspaceId, t.url]), [[browserId, 'ws-1', 'http://localhost:3000/']]);
});

test('list_tabs shows only the workspace\'s tabs; another workspace cannot reach a tab', async () => {
  const { tabs, browserId } = await withTab();
  const mine = await tabs.execute(req({ command: 'list_tabs', args: {} }));
  assert.equal(mine.ok && mine.result.command === 'list_tabs' && mine.result.tabs.map((t) => [t.browserId, t.isActive]).join(), `${browserId},true`);
  const other = await tabs.execute(req({ command: 'list_tabs', args: {} }, { workspaceId: 'ws-2' }));
  assert.equal(other.ok && other.result.command === 'list_tabs' && other.result.tabs.length, 0);
  const denied = await tabs.execute(req({ command: 'snapshot', args: { browserId } }, { workspaceId: 'ws-2' }));
  assert.equal(!denied.ok && denied.error.code, 'browser_tab_not_found');
});

test('click scrolls the ref into view and presses at its center with the modifiers', async () => {
  const { chrome, tabs, browserId } = await withTab();
  const r = await tabs.execute(req({ command: 'click', args: { browserId, ref: '@e3', button: 'left', doubleClick: true, modifiers: ['Shift', 'Meta'] } }));
  assert.deepEqual(r.ok && r.result, { command: 'click', browserId, ref: '@e3', x: 100, y: 51 });
  const presses = chrome.calls.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
  assert.deepEqual(presses.map((c) => [c.params.x, c.params.y, c.params.clickCount, c.params.modifiers]), [[100, 51, 1, 12], [100, 51, 2, 12]]);
  assert.match(String(chrome.calls.find((c) => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('coco.refs'))?.params.expression), /"@e3"/);
});

test('a ref the page no longer holds is a stale ref', async () => {
  const { tabs, browserId } = await withTab({ 'Runtime.evaluate': (p) => (p.expression === 'document.readyState' ? { result: { value: 'complete' } } : { result: { subtype: 'null' } }) });
  const r = await tabs.execute(req({ command: 'fill', args: { browserId, ref: '@e9', value: 'x' } }));
  assert.deepEqual(!r.ok && [r.error.code, r.error.message], ['browser_stale_ref', 'Browser element reference @e9 is stale. Take a new snapshot and try again.']);
});

test('navigate refuses file:// and chrome:// pages; an unknown tab is not found', async () => {
  const { tabs, browserId } = await withTab();
  for (const url of ['file:///etc/passwd', 'chrome://settings']) {
    const r = await tabs.execute(req({ command: 'navigate', args: { browserId, url } }));
    assert.equal(!r.ok && r.error.code, 'browser_denied', url);
  }
  const r = await tabs.execute(req({ command: 'reload', args: { browserId: '11111111-1111-4111-8111-111111111111' } }));
  assert.equal(!r.ok && r.error.code, 'browser_tab_not_found');
  assert.throws(() => pageUrl('javascript:alert(1)'), /only http/);
});

test('coco\'s own origins never open in an agent\'s tab, whatever the spelling; dev servers do', async () => {
  for (const url of ['http://127.0.0.1:8777/', 'http://localhost:8778/#/work/x', 'HTTP://LOCALHOST:8790/api/works', 'http://u:p@127.0.0.1:8790/api/agents', 'http://[::1]:8777/', 'http://0.0.0.0:8790/', 'http://127.1:8790/', 'http://2130706433:8777/', 'https://coco.local/', 'http://coco.local:9000/api']) {
    assert.throws(() => pageUrl(url, block), /coco itself/, url);
  }
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1:8000/', 'https://example.com/', 'http://coco.local.example.com/']) assert.equal(pageUrl(url, block), new URL(url).href, url);
  const { tabs, browserId } = await withTab();
  const r = await tabs.execute(req({ command: 'navigate', args: { browserId, url: 'http://localhost:8790/' } }));
  assert.equal(!r.ok && r.error.code, 'browser_denied');
  const n = await tabs.execute(req({ command: 'new_tab', args: { url: 'http://127.0.0.1:8777/' } }));
  assert.equal(!n.ok && n.error.code, 'browser_denied');
});

test('the whole Chrome fails every request to coco (redirects, frames, popups, workers) before a tab opens, and marks its tabs\' User-Agent', async () => {
  const { chrome } = await withTab();
  const fetchOn = chrome.calls.findIndex((c) => c.method === 'Fetch.enable');
  assert.ok(fetchOn >= 0 && fetchOn < chrome.calls.findIndex((c) => c.method === 'Target.createTarget'));
  assert.equal(chrome.calls[fetchOn].sessionId, undefined, 'on the browser session, not a tab\'s');
  chrome.emit({ method: 'Fetch.requestPaused', params: { requestId: 'r1', request: { url: 'http://u@localhost:8777/api/agents/a/mode' } } });
  chrome.emit({ method: 'Fetch.requestPaused', params: { requestId: 'r2', request: { url: 'http://localhost:3000/app.js' } } });
  const answer = (id: string) => chrome.calls.find((c) => c.method.startsWith('Fetch.') && c.params.requestId === id);
  assert.deepEqual([answer('r1')?.method, answer('r1')?.params.errorReason], ['Fetch.failRequest', 'BlockedByClient']);
  assert.equal(answer('r2')?.method, 'Fetch.continueRequest');
  assert.equal(chrome.calls.find((c) => c.method === 'Emulation.setUserAgentOverride')?.params.userAgent, 'Mozilla/5.0 HeadlessChrome/150.0.0.0 CocoAgentBrowser');
  const again = createBrowserTabs({ hold: chrome.hold, block });
  await again.execute(req({ command: 'new_tab', args: {} }));
  assert.equal(chrome.calls.filter((c) => c.method === 'Fetch.enable').length, 2, 'each tab set arms its Chrome once');
});

test('a Chrome that cannot block coco opens no tab', async () => {
  const chrome = fakeChrome({ 'Fetch.enable': () => {
    throw new Error('no Fetch');
  } });
  const tabs = createBrowserTabs({ hold: chrome.hold, block });
  const r = await tabs.execute(req({ command: 'new_tab', args: { url: 'http://localhost:3000/' } }));
  assert.equal(r.ok, false);
  assert.ok(!chrome.calls.some((c) => c.method === 'Target.createTarget'));
  assert.equal(chrome.released(), 1, 'the Chrome is let go');
});

test('each workspace browses in its own browser context, disposed with its last tab; a failed open lets Chrome go', async () => {
  const { chrome, tabs, browserId } = await withTab();
  const second = await tabs.execute(req({ command: 'new_tab', args: {} }));
  const other = await tabs.execute(req({ command: 'new_tab', args: {} }, { workspaceId: 'ws-2' }));
  assert.deepEqual(chrome.calls.filter((c) => c.method === 'Target.createTarget').map((c) => c.params.browserContextId), ['C1', 'C1', 'C2']);
  await tabs.execute(req({ command: 'close_tab', args: { browserId } }));
  assert.ok(!chrome.calls.some((c) => c.method === 'Target.disposeBrowserContext'), 'ws-1 still has a tab');
  await tabs.execute(req({ command: 'close_tab', args: { browserId: second.ok && second.result.command === 'new_tab' ? second.result.browserId : '' } }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(chrome.calls.filter((c) => c.method === 'Target.disposeBrowserContext').map((c) => c.params.browserContextId), ['C1']);
  await tabs.execute(req({ command: 'close_tab', args: { browserId: other.ok && other.result.command === 'new_tab' ? other.result.browserId : '' } }, { workspaceId: 'ws-2' }));
  assert.equal(chrome.released(), 1);

  const broken = fakeChrome({ 'Target.createTarget': () => {
    throw new Error('Chrome said no');
  } });
  const t2 = createBrowserTabs({ hold: broken.hold, block });
  const r = await t2.execute(req({ command: 'new_tab', args: {} }));
  assert.equal(!r.ok && r.error.message, 'Chrome said no');
  assert.equal(broken.released(), 1, 'the hold is released');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(broken.calls.some((c) => c.method === 'Target.disposeBrowserContext'));
});

test('a request with no workspace reaches no tab', async () => {
  const { tabs, browserId } = await withTab();
  const list = await tabs.execute(req({ command: 'list_tabs', args: {} }, { workspaceId: null }));
  assert.equal(!list.ok && list.error.code, 'browser_denied');
  const snap = await tabs.execute(req({ command: 'snapshot', args: { browserId } }, { workspaceId: undefined }));
  assert.equal(!snap.ok && snap.error.code, 'browser_tab_not_found');
});

test('upload takes files of the agent\'s workspace only, symlinks followed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-upload-'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'sub', 'a.png'), 'x');
  fs.writeFileSync(path.join(root, 'secret'), 'x');
  fs.symlinkSync(path.join(root, 'secret'), path.join(ws, 'link'));
  try {
    const real = fs.realpathSync(path.join(ws, 'sub', 'a.png'));
    assert.equal(await workspaceFile(ws, 'sub/a.png'), real);
    assert.equal(await workspaceFile(ws, path.join(ws, 'sub', 'a.png')), real);
    assert.equal(await workspaceFile(ws, path.join(fs.realpathSync(ws), 'sub', 'a.png')), real);
    for (const p of ['../secret', path.join(root, 'secret'), 'link', '/etc/hosts', os.homedir() + '/.ssh/id_rsa']) await assert.rejects(workspaceFile(ws, p), (e: { code?: string }) => e.code === 'browser_denied', p);
    await assert.rejects(workspaceFile(ws, 'nope.png'), /no nope.png/);
    await assert.rejects(workspaceFile(undefined, 'sub/a.png'), (e: { code?: string }) => e.code === 'browser_denied');
    const { tabs, browserId, chrome } = await withTab();
    const r = await tabs.execute(req({ command: 'upload', args: { browserId, ref: '@e1', filePaths: ['/etc/hosts'] } }, { cwd: ws }));
    assert.equal(!r.ok && r.error.code, 'browser_denied');
    assert.ok(!chrome.calls.some((c) => c.method === 'DOM.setFileInputFiles'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('screenshot returns the PNG, keeps it as the tab\'s last shot, and close_tab lets Chrome go', async () => {
  const { chrome, tabs, browserId } = await withTab();
  const r = await tabs.execute(req({ command: 'screenshot', args: { browserId, fullPage: false } }));
  assert.deepEqual(r.ok && r.result, { command: 'screenshot', browserId, mimeType: 'image/png', dataBase64: Buffer.from('png').toString('base64'), width: 1280, height: 800 });
  assert.ok(tabs.list()[0].shotAt);
  const closed = await tabs.execute(req({ command: 'close_tab', args: { browserId } }));
  assert.equal(closed.ok, true);
  assert.equal(tabs.size(), 0);
  assert.equal(chrome.released(), 1);
  assert.ok(chrome.calls.some((c) => c.method === 'Target.closeTarget' && c.params.targetId === 'T1'));
});

test('type, keypress, scroll, resize and evaluate map to their DevTools calls', async () => {
  const { chrome, tabs, browserId } = await withTab({ 'Runtime.callFunctionOn': (p) => (String(p.functionDeclaration).includes('getBoundingClientRect') ? { result: { value: { x: 10, y: 20 } } } : { result: { value: { n: 2 } } }) });
  await tabs.execute(req({ command: 'type', args: { browserId, text: 'hello' } }));
  assert.equal(chrome.calls.find((c) => c.method === 'Input.insertText')?.params.text, 'hello');
  await tabs.execute(req({ command: 'keypress', args: { browserId, key: 'Enter' } }));
  assert.deepEqual(chrome.calls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => [c.params.type, c.params.key, c.params.text]), [['keyDown', 'Enter', '\r'], ['keyUp', 'Enter', undefined]]);
  const scroll = await tabs.execute(req({ command: 'scroll', args: { browserId, deltaX: 0, deltaY: 400 } }));
  assert.deepEqual(scroll.ok && scroll.result, { command: 'scroll', browserId, deltaX: 0, deltaY: 400, x: 640, y: 400 });
  const resize = await tabs.execute(req({ command: 'resize', args: { browserId, width: 390, height: 844 } }));
  assert.equal(resize.ok, true);
  assert.equal(chrome.calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride').at(-1)?.params.width, 390);
  const ev = await tabs.execute(req({ command: 'evaluate', args: { browserId, function: '() => ({ n: 2 })' } }));
  assert.deepEqual(ev.ok && ev.result, { command: 'evaluate', browserId, resultJson: '{"n":2}', truncated: false });
});

test('a dialog the page opens is accepted and reported with the command', async () => {
  const { chrome, tabs, browserId } = await withTab({
    'Runtime.callFunctionOn': (p) => {
      if (String(p.functionDeclaration).includes('getBoundingClientRect')) chrome.emit({ method: 'Page.javascriptDialogOpening', sessionId: 'S-T1', params: { type: 'confirm', message: 'Sure?' } });
      return { result: { value: { x: 1, y: 1 } } };
    },
  });
  const r = await tabs.execute(req({ command: 'click', args: { browserId, ref: '@e1', button: 'left', doubleClick: false, modifiers: [] } }));
  assert.deepEqual(r.dialogs?.map((d) => [d.type, d.message, d.action]), [['confirm', 'Sure?', 'accepted']]);
  assert.ok(chrome.calls.some((c) => c.method === 'Page.handleJavaScriptDialog' && c.params.accept === true));
});

test('keys: characters, named keys and shortcuts', () => {
  assert.deepEqual(keyEvents('a')[0], { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0, text: 'a', unmodifiedText: 'a' });
  assert.deepEqual(keyEvents('Meta+k')[0], { type: 'rawKeyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 4 });
  assert.equal(keyEvents('Shift+Tab')[0].modifiers, 8);
  assert.throws(() => keyEvents('Hyper+x'), /unknown modifier/);
  assert.throws(() => keyEvents('Launch'), /unknown key/);
});

// --- registration: coco hosts only while the Paseo app is closed

function fakeLink() {
  const sent: unknown[] = [];
  let onRequest: ((r: never) => void) | null = null;
  let closed = 0;
  let closeFn = () => {};
  const link: HostLink = {
    async register(fn) {
      onRequest = fn as never;
    },
    respond: (r) => void sent.push(r),
    onClose: (fn) => void (closeFn = fn),
    close: () => void closed++,
  };
  return { link, sent, request: (r: never) => onRequest?.(r), closed: () => closed, drop: () => closeFn(), registered: () => Boolean(onRequest) };
}
const memLock = () => {
  let held = false;
  return { take: () => (held ? false : (held = true)), drop: () => void (held = false), other: () => void (held = true) };
};

test('coco does not register while the Paseo app runs', async () => {
  let connects = 0;
  const host = createBrowserHost({ mode: 'auto', tabs: createBrowserTabs({ hold: fakeChrome().hold }), connect: async () => (connects++, fakeLink().link), appRunning: async () => true, lock: memLock(), log: () => {} });
  await host.tick();
  assert.equal(connects, 0);
  assert.deepEqual([host.state().registered, host.state().reason], [false, 'the Paseo app hosts the browser']);
});

test('with the app closed coco registers, answers requests, and steps down once the app is back and its tabs are closed', async () => {
  let app = false;
  const f = fakeLink();
  const lock = memLock();
  const tabs = createBrowserTabs({ hold: fakeChrome().hold });
  const host = createBrowserHost({ mode: 'auto', tabs, connect: async () => f.link, appRunning: async () => app, lock, log: () => {} });
  await host.tick();
  assert.equal(host.state().registered, true);
  assert.equal(f.registered(), true);
  f.request(req({ command: 'new_tab', args: {} }));
  for (let i = 0; i < 20 && !f.sent.length; i++) await new Promise((r) => setTimeout(r, 5));
  const sent = f.sent[0] as { type: string; payload: { requestId: string; ok: boolean } };
  assert.deepEqual([sent.type, sent.payload.requestId, sent.payload.ok], ['browser.automation.execute.response', 'browser_1', true]);
  app = true;
  await host.tick();
  assert.equal(host.state().registered, true, 'keeps serving its open tab');
  tabs.closeAll();
  await host.tick();
  assert.equal(host.state().registered, false);
  assert.equal(f.closed(), 1);
  assert.equal(lock.take(), true, 'the lock is released');
});

test('an answer the daemon link cannot send is logged, not an unhandled rejection', async () => {
  const f = fakeLink();
  f.link.respond = () => {
    throw new Error('not connected');
  };
  const lines: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => void unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const host = createBrowserHost({ mode: 'auto', tabs: createBrowserTabs({ hold: fakeChrome().hold }), connect: async () => f.link, appRunning: async () => false, lock: memLock(), log: (l) => void lines.push(l) });
    await host.tick();
    f.request(req({ command: 'list_tabs', args: {} }));
    for (let i = 0; i < 20 && !lines.some((l) => l.includes('cannot answer')); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(lines.some((l) => l.includes('cannot answer browser_1: not connected')), lines.join('\n'));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('"off", another coco holding the lock, and a dropped daemon connection', async () => {
  let connects = 0;
  const connect = async () => (connects++, fakeLink().link);
  const off = createBrowserHost({ mode: 'off', tabs: createBrowserTabs({ hold: fakeChrome().hold }), connect, appRunning: async () => false, lock: memLock(), log: () => {} });
  await off.tick();
  assert.equal(connects, 0);
  const lock = memLock();
  lock.other();
  const second = createBrowserHost({ mode: 'auto', tabs: createBrowserTabs({ hold: fakeChrome().hold }), connect, appRunning: async () => false, lock, log: () => {} });
  await second.tick();
  assert.deepEqual([connects, second.state().reason], [0, 'another coco server hosts the browser']);
  const f = fakeLink();
  const host = createBrowserHost({ mode: 'auto', tabs: createBrowserTabs({ hold: fakeChrome().hold }), connect: async () => f.link, appRunning: async () => false, lock: memLock(), log: () => {} });
  await host.tick();
  f.drop();
  assert.deepEqual([host.state().registered, host.state().reason], [false, 'the daemon connection closed']);
});

test('a list_tabs fanned out to several hosts tells coco another host is up', async () => {
  const f = fakeLink();
  const host = createBrowserHost({ mode: 'auto', tabs: createBrowserTabs({ hold: fakeChrome().hold }), connect: async () => f.link, appRunning: async () => false, lock: memLock(), log: () => {} });
  await host.tick();
  f.request(req({ command: 'list_tabs', args: {} }, { requestId: 'browser_x:host-2' }));
  await host.tick();
  assert.deepEqual([host.state().registered, host.state().reason], [false, 'another browser host is connected']);
});
