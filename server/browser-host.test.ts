import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserHost, createBrowserTabs, keyEvents, pageUrl } from './browser-host.ts';
import type { HostLink } from './browser-host.ts';
import type { Cdp, Msg } from './screenshot.ts';

type Call = { method: string; params: Record<string, any>; sessionId?: string };

// a Chrome that answers each DevTools call from a table, and records them
function fakeChrome(answers: Record<string, (p: Record<string, any>) => Record<string, any>> = {}) {
  const calls: Call[] = [];
  const listeners = new Set<(m: Msg) => void>();
  let targets = 0;
  const cdp: Cdp = {
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (answers[method]) return answers[method](params);
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

async function withTab(answers?: Parameters<typeof fakeChrome>[0]) {
  const chrome = fakeChrome(answers);
  const tabs = createBrowserTabs({ hold: chrome.hold });
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
