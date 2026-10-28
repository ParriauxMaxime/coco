// coco as Paseo's browser host when the Paseo desktop app is closed: agents' browser_* tools (new tab, navigate, snapshot, click…) run in coco's
// headless Chrome (screenshot.ts) instead of failing with "no browser automation host". The daemon sends each new tab to the most recently
// registered host, so coco registers only while the app is not running and steps down once the app is back and coco's tabs are closed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { DaemonClient as RawDaemon } from '@getpaseo/client/internal/daemon-client';
import type { BrowserAutomationExecuteRequestMessage as ExecRequest, BrowserAutomationExecuteResponseMessage as ExecResponse } from '@getpaseo/client/internal/daemon-client';
import { AGENT_UA } from './guard.ts';
import { inside } from './workspace-files.ts';
import { errorMessage, errorStatus } from './core-types.ts';
import type { Cdp, ChromeHold, Msg } from './screenshot.ts';
import type { Req, Res, Send } from './core-types.ts';

export const HOST_KIND = 'cocopilot';
export const COMMANDS = ['list_tabs', 'new_tab', 'snapshot', 'click', 'fill', 'wait', 'type', 'keypress', 'navigate', 'back', 'forward', 'reload', 'screenshot', 'upload', 'select', 'hover', 'drag', 'logs', 'evaluate', 'scroll', 'resize', 'close_tab'] as const;
const VIEWPORT = { width: 1280, height: 800 };
const LOAD_MS = 10_000;
const WAIT_MS = 5_000;
const TAB_IDLE_MS = 30 * 60 * 1000;
const MAX_LOGS = 200;
const MAX_SNAPSHOT = 80_000;
const MAX_EVAL = 80_000;
const TICK_MS = 15_000;
const REFS = "window[Symbol.for('coco.refs')]";

type Payload = ExecResponse['payload'];
type Result = Extract<Payload, { ok: true }>['result'];
type Command = ExecRequest['command'];
type Code = Extract<Payload, { ok: false }>['error']['code'];
type Dialog = NonNullable<Payload['dialogs']>[number];
type ConsoleEntry = { level: string; message: string; source?: string; line?: number; timestamp: number };
type Tab = { browserId: string; targetId: string; sessionId: string; cdp: Cdp; workspaceId: string; agentId: string | null; url: string; title: string; usedAt: number; width: number; height: number; console: ConsoleEntry[]; dialogs: Dialog[]; shot: { data: Buffer; type: string; at: number } | null; off(): void };
export type TabView = { browserId: string; agentId: string | null; workspaceId: string; url: string; title: string; usedAt: number; shotAt: number | null };

class Fail extends Error {
  code: Code;
  retryable: boolean;
  constructor(code: Code, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stale = (ref: string) => new Fail('browser_stale_ref', `Browser element reference ${ref} is stale. Take a new snapshot and try again.`);

// coco's own origins: an agent's page reaching them could drive coco's API as the owner. Loopback names on coco's ports, its other hosts on any port.
export type Block = (u: URL) => boolean;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0']);
export function cocoOrigins(ports: number[], hosts: string[]): Block {
  const at = new Set(ports.map(String));
  const named = new Set<string>();
  for (const h of hosts) {
    try {
      const u = new URL(h.includes('://') ? h : `http://${h}`);
      if (LOOPBACK.has(u.hostname)) at.add(u.port || (u.protocol === 'https:' ? '443' : '80'));
      else named.add(u.hostname);
    } catch {}
  }
  return (u) => named.has(u.hostname) || (LOOPBACK.has(u.hostname) && at.has(u.port || (u.protocol === 'https:' ? '443' : '80')));
}

// http(s) only: no file://, chrome://, data: or javascript: in coco's Chrome, nor coco itself
export function pageUrl(raw: string, block?: Block): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Fail('browser_denied', `not a URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Fail('browser_denied', `only http(s) pages open in coco's browser, not ${u.protocol}`);
  if (block?.(u)) throw new Fail('browser_denied', `${u.host} is coco itself: an agent's browser tab cannot open it`);
  return u.href;
}

// a file an agent uploads: only from its own workspace, symlinks followed
export async function workspaceFile(cwd: string | null | undefined, p: string): Promise<string> {
  if (!cwd) throw new Fail('browser_denied', 'uploads come from the agent\'s workspace: this agent has none');
  const abs = path.resolve(cwd, p);
  const base = await fs.promises.realpath(cwd).catch(() => cwd);
  const rel = [cwd, base].map((d) => path.relative(d, abs)).find((r) => r && !r.startsWith('..') && !path.isAbsolute(r));
  if (!rel) throw new Fail('browser_denied', `${p} is outside the workspace ${cwd}`);
  try {
    return (await inside(cwd, rel.split(path.sep).join('/'))).real;
  } catch (e) {
    throw new Fail(errorStatus(e) === 404 ? 'browser_unknown_error' : 'browser_denied', `${p}: ${errorMessage(e)}`);
  }
}

const KEYS: Record<string, [string, number, string?]> = {
  Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
  ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Space: ['Space', 32, ' '], ' ': ['Space', 32, ' '],
};
const MODS: Record<string, number> = { Alt: 1, Option: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };

// "Enter", "a", "Shift+Tab", "Meta+k" → the keyDown / keyUp pair Input.dispatchKeyEvent takes
export function keyEvents(spec: string): Record<string, unknown>[] {
  const parts = spec.endsWith('++') ? [...spec.slice(0, -2).split('+'), '+'] : spec.split('+');
  const key = parts.pop() || spec;
  let modifiers = 0;
  for (const p of parts.filter(Boolean)) {
    if (!MODS[p]) throw new Fail('browser_unknown_error', `unknown modifier "${p}" in key "${spec}" (Alt, Control, Meta, Shift)`);
    modifiers |= MODS[p];
  }
  let code: string;
  let keyCode: number;
  let text: string | undefined;
  if (KEYS[key]) [code, keyCode, text] = KEYS[key];
  else if (key.length === 1) {
    const up = key.toUpperCase();
    code = /[a-z]/i.test(key) ? `Key${up}` : /\d/.test(key) ? `Digit${key}` : '';
    keyCode = up.charCodeAt(0);
    text = key;
  } else if (/^F([1-9]|1[0-2])$/.test(key)) [code, keyCode] = [key, 111 + Number(key.slice(1))];
  else throw new Fail('browser_unknown_error', `unknown key "${key}": a character or Enter, Tab, Escape, Backspace, Delete, Arrow*, Home, End, PageUp, PageDown, Space, F1-F12`);
  // a shortcut types nothing
  if (modifiers & 6) text = undefined;
  const base = { key, code, windowsVirtualKeyCode: keyCode, modifiers };
  return [{ type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) }, { type: 'keyUp', ...base }];
}

// an accessibility-ish outline of the page in Paseo's aria-yaml shape; interactive elements get a ref (@e1…) kept on the page until the next snapshot
export const SNAPSHOT_SCRIPT = `(() => {
  const refs = new Map();
  ${REFS} = refs;
  const lines = [];
  let nodes = 0, maxDepth = 0, iframes = 0, truncated = false;
  const INPUT = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button', range: 'slider', number: 'spinbutton', search: 'searchbox', hidden: null };
  const TAGS = { A: (e) => (e.hasAttribute('href') ? 'link' : null), BUTTON: () => 'button', SUMMARY: () => 'button', TEXTAREA: () => 'textbox',
    SELECT: (e) => (e.multiple || e.size > 1 ? 'listbox' : 'combobox'), IMG: (e) => (e.getAttribute('alt') === '' ? null : 'img'),
    INPUT: (e) => (e.type in INPUT ? INPUT[e.type] : 'textbox'), H1: () => 'heading', H2: () => 'heading', H3: () => 'heading', H4: () => 'heading', H5: () => 'heading', H6: () => 'heading',
    NAV: () => 'navigation', MAIN: () => 'main', HEADER: () => 'banner', FOOTER: () => 'contentinfo', ASIDE: () => 'complementary', FORM: () => 'form', DIALOG: () => 'dialog',
    UL: () => 'list', OL: () => 'list', LI: () => 'listitem', TABLE: () => 'table', TR: () => 'row', TH: () => 'columnheader', TD: () => 'cell', OPTION: () => 'option' };
  const INTERACTIVE = new Set(['link', 'button', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);
  const LEAF = new Set(['link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'img', 'heading', 'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'SVG']);
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const hidden = (e) => {
    if (e.hidden || e.getAttribute('aria-hidden') === 'true') return true;
    const s = getComputedStyle(e);
    return s.display === 'none' || s.visibility === 'hidden';
  };
  const nameOf = (e, role) => {
    const by = e.getAttribute('aria-labelledby');
    const label = clean(e.getAttribute('aria-label') || (by ? by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : ''));
    if (label) return label;
    if (e.labels && e.labels.length) return clean([...e.labels].map((l) => l.textContent).join(' '));
    if (e.tagName === 'IMG') return clean(e.alt);
    if (e.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(e.type)) return clean(e.value);
    if (LEAF.has(role) && !['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton'].includes(role)) return clean(e.innerText || e.textContent);
    return clean(e.getAttribute('title') || e.getAttribute('placeholder') || '');
  };
  const attrsOf = (e, role) => {
    const a = [];
    if (role === 'heading') a.push('level=' + (e.getAttribute('aria-level') || e.tagName.slice(1) || 2));
    if (e.checked || e.getAttribute('aria-checked') === 'true') a.push('checked');
    if (e.disabled || e.getAttribute('aria-disabled') === 'true') a.push('disabled');
    if (e.getAttribute('aria-expanded')) a.push('expanded=' + e.getAttribute('aria-expanded'));
    if (e.getAttribute('aria-selected') === 'true' || (e.tagName === 'OPTION' && e.selected)) a.push('selected');
    if (['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton'].includes(role) && 'value' in e && e.value) a.push('value=' + JSON.stringify(cut(String(e.value), 200)));
    if (role === 'link' && e.href) a.push('url=' + JSON.stringify(cut(e.href, 200)));
    return a;
  };
  const emit = (line, depth) => {
    if (lines.length >= 4000) return void (truncated = true);
    lines.push('  '.repeat(depth) + line);
    maxDepth = Math.max(maxDepth, depth);
  };
  const walk = (parent, depth) => {
    for (const c of parent.childNodes) {
      if (truncated) return;
      if (c.nodeType === 3) {
        const t = clean(c.textContent);
        if (t) emit('- text: ' + JSON.stringify(cut(t, 300)), depth);
        continue;
      }
      if (c.nodeType !== 1 || SKIP.has(c.tagName.toUpperCase())) continue;
      if (c.tagName === 'IFRAME') {
        iframes++;
        continue;
      }
      if (hidden(c)) continue;
      nodes++;
      const explicit = c.getAttribute('role');
      const implicit = TAGS[c.tagName] ? TAGS[c.tagName](c) : c.isContentEditable && c.hasAttribute('contenteditable') ? 'textbox' : null;
      const role = explicit && explicit !== 'presentation' && explicit !== 'none' ? explicit : explicit ? null : implicit;
      const interactive = INTERACTIVE.has(role) || (c.hasAttribute('tabindex') && c.tabIndex >= 0) || c.hasAttribute('onclick');
      if (!role && !interactive) {
        walk(c.shadowRoot || c, depth);
        continue;
      }
      const r = role || 'generic';
      const name = nameOf(c, r);
      const a = attrsOf(c, r);
      if (interactive) {
        const ref = '@e' + (refs.size + 1);
        refs.set(ref, c);
        a.push('ref=' + ref);
      }
      emit('- ' + r + (name ? ' ' + JSON.stringify(cut(name, 120)) : '') + (a.length ? ' [' + a.join(' ') + ']' : ''), depth);
      if (!LEAF.has(r)) walk(c.shadowRoot || c, depth + 1);
    }
  };
  if (document.body) walk(document.body, 0);
  const snapshot = lines.join('\\n') || '- document';
  return { url: location.href, title: document.title, snapshot, truncated, stats: { nodeCount: nodes, refCount: refs.size, textLength: snapshot.length, iframeCount: iframes, maxDepth } };
})()`;

const consoleEntry = (m: Msg): ConsoleEntry | null => {
  const p = m.params || {};
  if (m.method === 'Runtime.consoleAPICalled') return { level: p.type === 'warning' ? 'warn' : String(p.type), message: (p.args || []).map((a: { value?: unknown; description?: string }) => (typeof a.value === 'string' ? a.value : a.description ?? JSON.stringify(a.value))).join(' ').slice(0, 2000), timestamp: Math.round(Number(p.timestamp) || Date.now()) };
  if (m.method === 'Runtime.exceptionThrown') return { level: 'error', message: String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 2000), timestamp: Math.round(Number(p.timestamp) || Date.now()) };
  if (m.method === 'Log.entryAdded') return { level: String(p.entry?.level), message: String(p.entry?.text || '').slice(0, 2000), ...(p.entry?.url ? { source: String(p.entry.url) } : {}), ...(Number.isInteger(p.entry?.lineNumber) ? { line: p.entry.lineNumber } : {}), timestamp: Math.round(Number(p.entry?.timestamp) || Date.now()) };
  return null;
};

// the tabs agents keep in coco's Chrome, and each command run on them. block: coco's origins, failed for every request of that Chrome (pages,
// redirects, frames, popups, workers), so the Chrome must be the agents' own, never the one screenshotting coco
export function createBrowserTabs({ hold, block, idleMs = TAB_IDLE_MS, now = Date.now }: { hold: () => ChromeHold; block?: Block; idleMs?: number; now?: () => number }) {
  const tabs = new Map<string, Tab>();
  let chrome: ChromeHold | null = null;
  // new_tab calls still opening: they keep the Chrome and their workspace's context
  let opening = 0;
  let armed: { cdp: Cdp; ready: Promise<void> } | null = null;
  // one browser context (cookies, storage) per workspace, disposed with its last tab
  const contexts = new Map<string, { cdp: Cdp; id: Promise<string>; opening: number }>();

  const idle = () => {
    if (tabs.size || opening || !chrome) return;
    chrome.release();
    chrome = null;
  };
  const forget = (workspaceId: string) => {
    const c = contexts.get(workspaceId);
    if (!c || c.opening || [...tabs.values()].some((t) => t.workspaceId === workspaceId)) return;
    contexts.delete(workspaceId);
    c.id.then((browserContextId) => c.cdp.send('Target.disposeBrowserContext', { browserContextId })).catch(() => {});
  };
  const drop = (tab: Tab) => {
    tab.off();
    tabs.delete(tab.browserId);
    forget(tab.workspaceId);
    idle();
  };
  const close = (tab: Tab) => {
    drop(tab);
    tab.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
  };

  // the whole Chrome: a request to coco fails, any other goes on; one that is never answered stays blocked
  function arm(cdp: Cdp) {
    if (!block || armed?.cdp === cdp) return armed?.ready;
    const off = cdp.on((m) => {
      if (m.method !== 'Fetch.requestPaused' || m.sessionId) return;
      let hit = true;
      try {
        hit = block(new URL(String(m.params?.request?.url)));
      } catch {}
      cdp.send(hit ? 'Fetch.failRequest' : 'Fetch.continueRequest', { requestId: m.params?.requestId, ...(hit ? { errorReason: 'BlockedByClient' } : {}) }).catch(() => {});
    });
    const a = { cdp, ready: cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }).then(() => {}) };
    a.ready.catch(() => {
      off();
      if (armed === a) armed = null;
    });
    armed = a;
    return a.ready;
  }

  function contextOf(cdp: Cdp, workspaceId: string) {
    let c = contexts.get(workspaceId);
    if (!c || c.cdp !== cdp) {
      const entry = { cdp, id: cdp.send('Target.createBrowserContext', {}).then((r) => String(r.browserContextId)), opening: 0 };
      entry.id.catch(() => contexts.get(workspaceId) === entry && contexts.delete(workspaceId));
      contexts.set(workspaceId, (c = entry));
    }
    return c;
  }

  function find(browserId: string, workspaceId: string | undefined) {
    const tab = tabs.get(browserId);
    if (!tab || !workspaceId || tab.workspaceId !== workspaceId) throw new Fail('browser_tab_not_found', `No browser tab found for ID: ${browserId}`);
    return tab;
  }

  async function open(req: ExecRequest, url: string | undefined): Promise<Tab> {
    if (!req.workspaceId) throw new Fail('browser_denied', 'browser tabs belong to a workspace: this agent has none');
    const workspaceId = req.workspaceId;
    const target = url ? pageUrl(url, block) : undefined;
    chrome ??= hold();
    opening++;
    let ctx: ReturnType<typeof contextOf> | null = null;
    let cdp!: Cdp;
    let targetId = '';
    let sessionId = '';
    try {
      cdp = await chrome.browser();
      await arm(cdp);
      ctx = contextOf(cdp, workspaceId);
      ctx.opening++;
      ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: await ctx.id }));
      ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    } catch (e) {
      if (targetId) cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      throw e;
    } finally {
      opening--;
      if (ctx) ctx.opening--;
      // a failed open lets its context and the Chrome go when nothing else holds them
      if (!sessionId) {
        forget(workspaceId);
        idle();
      }
    }
    const tab: Tab = { browserId: randomUUID(), targetId, sessionId, cdp, workspaceId, agentId: req.agentId ?? null, url: 'about:blank', title: '', usedAt: now(), ...VIEWPORT, console: [], dialogs: [], shot: null, off: () => {} };
    const s = (method: string, params?: Record<string, unknown>) => cdp.send(method, params, sessionId);
    tab.off = cdp.on((m) => {
      if (m.method === 'Target.detachedFromTarget' && m.params?.sessionId === sessionId) return void drop(tab);
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Page.javascriptDialogOpening') {
        const p = m.params || {};
        const promptText = p.type === 'prompt' ? String(p.defaultPrompt ?? '') : undefined;
        s('Page.handleJavaScriptDialog', { accept: true, ...(promptText !== undefined ? { promptText } : {}) }).catch(() => {});
        tab.dialogs.push({ type: p.type, message: String(p.message ?? ''), ...(p.defaultPrompt ? { defaultValue: String(p.defaultPrompt) } : {}), action: 'accepted', ...(promptText !== undefined ? { promptText } : {}), timestamp: now() });
        return;
      }
      const entry = consoleEntry(m);
      if (entry) tab.console = [...tab.console, entry].slice(-MAX_LOGS);
    });
    tabs.set(tab.browserId, tab);
    try {
      const { userAgent } = await cdp.send('Browser.getVersion');
      await Promise.all([s('Page.enable'), s('Runtime.enable'), s('Log.enable'), s('Emulation.setUserAgentOverride', { userAgent: `${userAgent || 'Mozilla/5.0'} ${AGENT_UA}` })]);
      await s('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
      if (target) await goto(tab, target);
    } catch (e) {
      close(tab);
      throw e;
    }
    return tab;
  }

  const session = (tab: Tab) => (method: string, params?: Record<string, unknown>) => tab.cdp.send(method, params, tab.sessionId);
  const evaluate = async (tab: Tab, expression: string) => {
    const r = await session(tab)('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Fail('browser_unknown_error', String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 2000));
    return r.result?.value;
  };
  async function settle(tab: Tab) {
    for (const end = now() + LOAD_MS; now() < end; await sleep(100)) if ((await evaluate(tab, 'document.readyState').catch(() => '')) === 'complete') break;
  }
  async function goto(tab: Tab, url: string) {
    const r = await session(tab)('Page.navigate', { url });
    if (r.errorText) throw new Fail('browser_unknown_error', `cannot open ${url}: ${r.errorText}`, true);
    await settle(tab);
  }
  async function element(tab: Tab, ref: string): Promise<string> {
    const r = await session(tab)('Runtime.evaluate', { expression: `(() => { const e = ${REFS}?.get(${JSON.stringify(ref)}); return e && e.isConnected ? e : null; })()` });
    const id = r.result?.objectId;
    if (!id) throw stale(ref);
    return String(id);
  }
  const call = async (tab: Tab, objectId: string, fn: string, args: unknown[] = []) => {
    const r = await session(tab)('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Fail('browser_unknown_error', String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 2000));
    return r.result?.value;
  };
  const center = async (tab: Tab, ref: string) => {
    const at = await call(tab, await element(tab, ref), 'function () { this.scrollIntoView({ block: "center", inline: "center" }); const r = this.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }');
    if (!at) throw stale(ref);
    return { x: Math.round(at.x), y: Math.round(at.y) };
  };
  const mouse = (tab: Tab, type: string, x: number, y: number, extra: Record<string, unknown> = {}) => session(tab)('Input.dispatchMouseEvent', { type, x, y, ...extra });
  const focus = async (tab: Tab, ref: string) => call(tab, await element(tab, ref), 'function () { this.scrollIntoView({ block: "center", inline: "center" }); this.focus(); }');
  async function info(tab: Tab) {
    const t = await tab.cdp.send('Target.getTargetInfo', { targetId: tab.targetId }).catch(() => null);
    if (t?.targetInfo) [tab.url, tab.title] = [String(t.targetInfo.url ?? tab.url), String(t.targetInfo.title ?? tab.title)];
    return tab;
  }
  async function history(tab: Tab) {
    const h = await session(tab)('Page.getNavigationHistory').catch(() => null);
    const n = Array.isArray(h?.entries) ? h.entries.length : 0;
    return { canGoBack: n > 0 && h!.currentIndex > 0, canGoForward: n > 0 && h!.currentIndex < n - 1, h };
  }
  async function capture(tab: Tab, opts: { fullPage?: boolean; type?: 'png' | 'jpeg' } = {}) {
    const s = session(tab);
    let clip: Record<string, number> | null = null;
    if (opts.fullPage) {
      const m = await s('Page.getLayoutMetrics');
      const size = m.cssContentSize || m.contentSize;
      clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(16384, Math.ceil(size.height)), scale: 1 };
    }
    const { data } = await s('Page.captureScreenshot', { format: opts.type || 'png', ...(opts.type === 'jpeg' ? { quality: 70 } : {}), ...(clip ? { clip, captureBeyondViewport: true } : {}) });
    if (!data) throw new Fail('screenshot_no_frame', 'The tab has not painted yet. Retry the screenshot.', true);
    tab.shot = { data: Buffer.from(String(data), 'base64'), type: `image/${opts.type || 'png'}`, at: now() };
    return { data: String(data), width: clip ? clip.width : tab.width, height: clip ? clip.height : tab.height };
  }

  async function run(req: ExecRequest, command: Command): Promise<Result> {
    if (command.command === 'list_tabs') {
      if (!req.workspaceId) throw new Fail('browser_denied', 'browser tabs belong to a workspace: this agent has none');
      const mine = [...tabs.values()].filter((t) => t.workspaceId === req.workspaceId);
      const active = mine.reduce<Tab | null>((a, t) => (!a || t.usedAt > a.usedAt ? t : a), null);
      const list = await Promise.all(mine.map(async (t) => ({ browserId: t.browserId, workspaceId: t.workspaceId, url: (await info(t)).url, title: t.title, isActive: t === active, isLoading: false, ...(({ canGoBack, canGoForward }) => ({ canGoBack, canGoForward }))(await history(t)) })));
      return { command: 'list_tabs', tabs: list };
    }
    if (command.command === 'new_tab') {
      const tab = await open(req, command.args.url);
      await info(tab);
      return { command: 'new_tab', browserId: tab.browserId, workspaceId: tab.workspaceId, url: tab.url || 'about:blank' };
    }
    const tab = find(command.args.browserId, req.workspaceId);
    // Chrome restarted (crash, idle) since the tab opened
    if ((await chrome?.browser().catch(() => null)) !== tab.cdp) {
      drop(tab);
      throw new Fail('browser_tab_closed', `Browser tab ${tab.browserId} has been closed`);
    }
    tab.usedAt = now();
    if (!tab.agentId && req.agentId) tab.agentId = req.agentId;
    const s = session(tab);
    const { browserId } = tab;
    switch (command.command) {
      case 'snapshot': {
        const r = await evaluate(tab, SNAPSHOT_SCRIPT);
        let snapshot = String(r?.snapshot || '- document');
        let truncated = Boolean(r?.truncated);
        if (snapshot.length > MAX_SNAPSHOT) [snapshot, truncated] = [snapshot.slice(0, MAX_SNAPSHOT).replace(/\n[^\n]*$/, ''), true];
        if (truncated) snapshot += '\n- text: "Snapshot truncated."';
        return { command: 'snapshot', browserId, workspaceId: tab.workspaceId, url: String(r?.url ?? ''), title: String(r?.title ?? ''), format: 'aria-yaml', snapshot, truncated, stats: { nodeCount: 0, refCount: 0, ...r?.stats, textLength: snapshot.length } };
      }
      case 'click': {
        const { ref, button, doubleClick, modifiers } = command.args;
        const { x, y } = await center(tab, ref);
        const mods = modifiers.reduce((m, k) => m | (MODS[k] || 0), 0);
        await mouse(tab, 'mouseMoved', x, y, { modifiers: mods });
        for (let n = 1; n <= (doubleClick ? 2 : 1); n++) {
          await mouse(tab, 'mousePressed', x, y, { button, clickCount: n, modifiers: mods });
          await mouse(tab, 'mouseReleased', x, y, { button, clickCount: n, modifiers: mods });
        }
        return { command: 'click', browserId, ref, x, y };
      }
      case 'hover': {
        const { x, y } = await center(tab, command.args.ref);
        await mouse(tab, 'mouseMoved', x, y);
        return { command: 'hover', browserId, ref: command.args.ref, x, y };
      }
      case 'drag': {
        const { sourceRef, targetRef } = command.args;
        const from = await center(tab, sourceRef);
        const to = await center(tab, targetRef);
        await mouse(tab, 'mouseMoved', from.x, from.y);
        await mouse(tab, 'mousePressed', from.x, from.y, { button: 'left', clickCount: 1 });
        for (let i = 1; i <= 5; i++) await mouse(tab, 'mouseMoved', from.x + ((to.x - from.x) * i) / 5, from.y + ((to.y - from.y) * i) / 5, { button: 'left' });
        await mouse(tab, 'mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 });
        return { command: 'drag', browserId, sourceRef, targetRef, sourceX: from.x, sourceY: from.y, targetX: to.x, targetY: to.y };
      }
      case 'fill': {
        await call(tab, await element(tab, command.args.ref), `function (v) {
          this.scrollIntoView({ block: 'center', inline: 'center' });
          this.focus();
          if ('value' in this) {
            const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), 'value');
            d && d.set ? d.set.call(this, v) : (this.value = v);
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            this.textContent = v;
            this.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
          }
        }`, [command.args.value]);
        return { command: 'fill', browserId, ref: command.args.ref };
      }
      case 'select': {
        const { ref, value } = command.args;
        const miss = await call(tab, await element(tab, ref), `function (v) {
          if (!(this instanceof HTMLSelectElement)) return 'not a select element';
          const o = [...this.options].find((o) => o.value === v) || [...this.options].find((o) => o.label.trim() === v || o.text.trim() === v);
          if (!o) return 'no option ' + JSON.stringify(v);
          this.value = o.value;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return '';
        }`, [value]);
        if (miss) throw new Fail('browser_unknown_error', `${ref}: ${miss}`);
        return { command: 'select', browserId, ref, value };
      }
      case 'type': {
        const { ref, text } = command.args;
        if (ref) await focus(tab, ref);
        await s('Input.insertText', { text });
        return { command: 'type', browserId, ...(ref ? { ref } : {}) };
      }
      case 'keypress': {
        const { ref, key } = command.args;
        const events = keyEvents(key);
        if (ref) await focus(tab, ref);
        for (const e of events) await s('Input.dispatchKeyEvent', e);
        return { command: 'keypress', browserId, key, ...(ref ? { ref } : {}) };
      }
      case 'wait': {
        const { text, url, timeoutMs } = command.args;
        const test = text ? `(document.body?.innerText || '').includes(${JSON.stringify(text)})` : `location.href.includes(${JSON.stringify(url)})`;
        for (const end = now() + (timeoutMs ?? WAIT_MS); ; await sleep(100)) {
          if (await evaluate(tab, test).catch(() => false)) return { command: 'wait', browserId, matched: text ? 'text' : 'url' };
          if (now() >= end) throw new Fail('browser_timeout', `Browser wait for ${text ? `text ${JSON.stringify(text)}` : `url ${JSON.stringify(url)}`} timed out after ${timeoutMs ?? WAIT_MS}ms.`, true);
        }
      }
      case 'navigate': {
        await goto(tab, pageUrl(command.args.url, block));
        return { command: 'navigate', browserId, url: (await info(tab)).url };
      }
      case 'back':
      case 'forward': {
        const { h } = await history(tab);
        const entry = h?.entries?.[h.currentIndex + (command.command === 'back' ? -1 : 1)];
        if (entry) {
          await s('Page.navigateToHistoryEntry', { entryId: entry.id });
          await sleep(100);
          await settle(tab);
        }
        return { command: command.command, browserId };
      }
      case 'reload': {
        await s('Page.reload', {});
        await sleep(100);
        await settle(tab);
        return { command: 'reload', browserId };
      }
      case 'screenshot': {
        const shot = await capture(tab, { fullPage: command.args.fullPage });
        return { command: 'screenshot', browserId, mimeType: 'image/png', dataBase64: shot.data, width: shot.width, height: shot.height };
      }
      case 'upload': {
        const { ref, filePaths } = command.args;
        const files = await Promise.all(filePaths.map((p) => workspaceFile(req.cwd, p)));
        await s('DOM.setFileInputFiles', { files, objectId: await element(tab, ref) });
        return { command: 'upload', browserId, ref, filePaths };
      }
      case 'logs': {
        const max = command.args.maxEntries;
        const network = (await evaluate(tab, `performance.getEntriesByType('navigation').concat(performance.getEntriesByType('resource')).map((e) => ({ url: e.name, type: e.initiatorType, startTime: e.startTime, duration: e.duration, transferSize: e.transferSize, status: e.responseStatus || undefined }))`).catch(() => [])) as { url: string; type?: string; startTime: number; duration: number; transferSize?: number; status?: number }[];
        return { command: 'logs', browserId, console: tab.console.slice(-max), network: (network || []).slice(-max).map((e) => ({ url: e.url, ...(e.type ? { type: e.type } : {}), ...(e.status ? { status: e.status } : {}), startTime: e.startTime, duration: e.duration, ...(e.transferSize !== undefined ? { transferSize: e.transferSize } : {}) })) };
      }
      case 'evaluate': {
        const { ref } = command.args;
        const self = ref ? await element(tab, ref) : String((await s('Runtime.evaluate', { expression: 'window' })).result?.objectId);
        const r = await s('Runtime.callFunctionOn', { objectId: self, functionDeclaration: command.args.function, arguments: ref ? [{ objectId: self }] : [], awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Fail('browser_unknown_error', `evaluate threw: ${String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 2000)}`);
        const json = JSON.stringify(r.result?.value ?? null);
        return { command: 'evaluate', browserId, resultJson: json.length > MAX_EVAL ? JSON.stringify(json.slice(0, MAX_EVAL - 1000)) : json, truncated: json.length > MAX_EVAL };
      }
      case 'scroll': {
        const { ref, deltaX, deltaY } = command.args;
        const { x, y } = ref ? await center(tab, ref) : { x: Math.round(tab.width / 2), y: Math.round(tab.height / 2) };
        await mouse(tab, 'mouseWheel', x, y, { deltaX, deltaY });
        return { command: 'scroll', browserId, deltaX, deltaY, x, y, ...(ref ? { ref } : {}) };
      }
      case 'resize': {
        const { width, height } = command.args;
        await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        [tab.width, tab.height] = [width, height];
        return { command: 'resize', browserId, width, height };
      }
      case 'close_tab': {
        close(tab);
        return { command: 'close_tab', browserId };
      }
    }
    throw new Fail('browser_unsupported', `Browser automation command "${(command as { command: string }).command}" is not supported by coco.`);
  }

  // one daemon request → its response payload; a failure is a payload too, never a throw
  async function execute(req: ExecRequest): Promise<Payload> {
    const tab = 'browserId' in req.command.args ? tabs.get(req.command.args.browserId) : undefined;
    const seen = tab?.dialogs.length ?? 0;
    const dialogs = () => (tab && tab.dialogs.length > seen ? { dialogs: tab.dialogs.slice(seen) } : {});
    try {
      const result = await run(req, req.command);
      return { requestId: req.requestId, ok: true, result, ...dialogs() };
    } catch (e) {
      const f = e instanceof Fail ? e : new Fail('browser_unknown_error', (e instanceof Error ? e.message : String(e)) || 'browser command failed');
      return { requestId: req.requestId, ok: false, error: { code: f.code, message: f.message, retryable: f.retryable }, ...dialogs() };
    } finally {
      if (tab) tab.dialogs = tab.dialogs.slice(-20);
    }
  }

  const view = (t: Tab): TabView => ({ browserId: t.browserId, agentId: t.agentId, workspaceId: t.workspaceId, url: t.url, title: t.title, usedAt: t.usedAt, shotAt: t.shot?.at ?? null });
  return {
    execute,
    size: () => tabs.size,
    list: (agentId?: string) => [...tabs.values()].filter((t) => !agentId || t.agentId === agentId).map(view),
    // what the tab shows now (a small JPEG), or its last capture when it cannot paint
    async shot(browserId: string) {
      const tab = tabs.get(browserId);
      if (!tab) return null;
      await capture(tab, { type: 'jpeg' }).catch(() => null);
      await info(tab);
      return tab.shot;
    },
    // tabs no agent touched for idleMs close, so a finished agent's pages do not keep Chrome up forever
    sweep() {
      for (const t of tabs.values()) if (now() - t.usedAt > idleMs) close(t);
    },
    closeAll() {
      for (const t of tabs.values()) close(t);
    },
  };
}
export type BrowserTabs = ReturnType<typeof createBrowserTabs>;

// the daemon side: one connection used only to host, never reconnected by the SDK (a reconnect would register again, maybe after the app)
export type HostLink = { register(onRequest: (req: ExecRequest) => void): Promise<void>; respond(r: ExecResponse): void; onClose(fn: () => void): void; close(): void };

export async function daemonLink(url: string, password?: string): Promise<HostLink> {
  const registration = { hostKind: HOST_KIND, supportedCommands: [...COMMANDS] };
  const raw = new RawDaemon({ url, clientId: `cocopilot-browser-${randomUUID().slice(0, 8)}`, clientType: 'cli', password, reconnect: { enabled: false }, capabilities: { browser_host: registration } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([raw.connect(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(raw.lastError || 'no answer')), 20_000)))]);
  } catch (e) {
    raw.close().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return {
    async register(onRequest) {
      const sub = raw.registerBrowserHost(registration);
      sub.subscribe({ snapshot: () => {}, update: (m) => void (m.type === 'browser.automation.execute.request' && onRequest(m as ExecRequest)) });
      await sub.ready;
    },
    respond: (r) => raw.sendBrowserAutomationExecuteResponse(r),
    onClose: (fn) => void raw.subscribeConnectionStatus((s) => s.status === 'disconnected' && fn()),
    close: () => void raw.close().catch(() => {}),
  };
}

// the Paseo desktop app hosts browser tabs while it runs; a failed check counts as running, so coco never takes the tabs by mistake
export const paseoAppRunning = () =>
  new Promise<boolean>((resolve) => execFile('pgrep', ['-x', 'Paseo'], { timeout: 5000 }, (err) => resolve(!err || (err as { code?: unknown }).code !== 1)));

// one coco server hosts at a time (a second server on another port or data dir would otherwise register after it)
export function pidLock(file = path.join(os.tmpdir(), 'cocopilot-browser-host.pid')) {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  return {
    take() {
      const pid = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : 0);
      if (pid && pid !== process.pid && alive(pid)) return false;
      fs.writeFileSync(file, String(process.pid));
      return true;
    },
    drop() {
      if (fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8').trim()) === process.pid) fs.rmSync(file, { force: true });
    },
  };
}
export type Lock = ReturnType<typeof pidLock>;

export type HostState = { mode: 'auto' | 'off'; registered: boolean; appRunning: boolean | null; reason: string; tabs: number };

export function createBrowserHost({ mode, tabs, connect, appRunning = paseoAppRunning, lock = pidLock(), log = console.log, everyMs = TICK_MS }: { mode: 'auto' | 'off'; tabs: BrowserTabs; connect: () => Promise<HostLink>; appRunning?: () => Promise<boolean>; lock?: Lock; log?: (line: string) => void; everyMs?: number }) {
  let link: HostLink | null = null;
  let app: boolean | null = null;
  // another host answered a list_tabs next to coco (the daemon fans it out with "<id>:<host>" request ids)
  let other = false;
  let reason = mode === 'off' ? 'browserHost is "off" in coco.config.json' : 'not checked yet';
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function down(why: string) {
    const l = link;
    link = null;
    other = false;
    lock.drop();
    l?.close();
    reason = why;
  }

  async function up() {
    if (!lock.take()) return void (reason = 'another coco server hosts the browser');
    let l: HostLink;
    try {
      l = await connect();
    } catch (e) {
      lock.drop();
      return void (reason = `cannot reach the Paseo daemon: ${e instanceof Error ? e.message : String(e)}`);
    }
    l.onClose(() => {
      if (link !== l) return;
      down('the daemon connection closed');
      log('browser host: the Paseo daemon connection closed, coco hosts again once it is back and the app is still closed');
    });
    link = l;
    try {
      const failed = (req: ExecRequest) => (e: unknown) => log(`browser host: cannot answer ${req?.requestId}: ${e instanceof Error ? e.message : String(e)}`);
      await l.register((req) => {
        try {
          if (req.command.command === 'list_tabs' && req.requestId.includes(':')) other = true;
          // the link may have dropped meanwhile: respond throws then, and an unhandled rejection would take the server down
          tabs
            .execute(req)
            .then((payload) => void (link === l && l.respond({ type: 'browser.automation.execute.response', payload })))
            .catch(failed(req));
        } catch (e) {
          failed(req)(e);
        }
      });
    } catch (e) {
      if (link === l) down(`the daemon refused the registration: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    reason = 'the Paseo app is closed: agents\' browser tabs open in coco\'s headless Chrome';
    log('browser host: the Paseo app is closed, coco hosts agents\' browser tabs');
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      tabs.sweep();
      if (mode === 'off') return;
      app = await appRunning();
      if (link) {
        // the app (or another host) took over: coco keeps serving its open tabs, then steps down
        if ((app || other) && tabs.size() === 0) {
          down(app ? 'the Paseo app hosts the browser' : 'another browser host is connected');
          log('browser host: the Paseo app is back, coco stops hosting');
        }
        return;
      }
      if (app) return void (reason = 'the Paseo app hosts the browser');
      await up();
    } finally {
      busy = false;
    }
  }

  const state = (): HostState => ({ mode, registered: Boolean(link), appRunning: app, reason, tabs: tabs.size() });
  return {
    tick,
    state,
    start() {
      if (timer || mode === 'off') return;
      void tick();
      timer = setInterval(() => void tick(), everyMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (link) down('coco stopped');
      tabs.closeAll();
    },
    // GET /api/browser → state and tabs (?agent=<id> for one agent's); GET /api/browser/tabs/<browserId>/shot → what that tab shows now
    async handle(req: Req, res: Res, parts: string[], send: Send) {
      const [, a, id, b] = parts;
      if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
      if (!a) {
        const agent = new URL(req.url || '/', 'http://x').searchParams.get('agent') || undefined;
        return send(res, 200, { ...state(), tabs: tabs.list(agent) });
      }
      if (a === 'tabs' && id && b === 'shot') {
        const shot = await tabs.shot(id);
        if (!shot) return send(res, 404, { error: 'no such tab' });
        res.writeHead(200, { 'Content-Type': shot.type, 'Cache-Control': 'no-store' });
        return res.end(shot.data);
      }
      return send(res, 404, { error: 'no route' });
    },
  };
}
