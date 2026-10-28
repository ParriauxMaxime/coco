// A restart or a rebuild of coco under an open page: the page reloads onto the new build (its layout and hash kept) once the server
// answers again, found on reconnect, on focus, on the status bar's poll of /api/server, or when a chunk of the old build is gone.
// Never while words or choices wait unsent or unsaved: the status bar then offers the reload, and it happens once they are gone.
import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from './api.ts';
import { connected, onConnection } from './live.ts';

// index.html as served carries its build (server/self.ts); vite's dev server serves its own, without one
const loaded = typeof document !== 'undefined' ? document.querySelector<HTMLMetaElement>('meta[name="coco-build"]')?.content || null : null;
const OFFLINE_AFTER_MS = 1500;
const SAFE_POLL_MS = 3000;
const FOCUS_CHECK_MS = 10000;
// an automatic reload this soon after the last one waits for a click instead of looping
const LOOP_MS = 20000;
const LOOP_KEY = 'coco.reloadedAt';
const CHUNK = /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

export const useUpdates = create<{ offline: boolean; stale: boolean }>(() => ({ offline: false, stale: false }));

export const chunkGone = (e: unknown) => CHUNK.test(e instanceof Error ? e.message : String(e));

// what the owner has not sent or saved yet: each box, card, form or dialog that holds some registers while it does
const unsaved = new Set<object>();
export function useUnsaved(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return undefined;
    const mark = {};
    unsaved.add(mark);
    return () => void unsaved.delete(mark);
  }, [dirty]);
}

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', '']);
// unsaved words: a registered box, card, form or dialog, or a focused field not held by React whose text was changed (Monaco's own aside)
function typing() {
  if (unsaved.size) return true;
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el.closest('.monaco-editor')) return false;
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type))) return Boolean(el.value.trim()) && el.value !== el.defaultValue;
  return el.isContentEditable && Boolean(el.textContent?.trim());
}

const recent = () => {
  try {
    return Date.now() - Number(sessionStorage.getItem(LOOP_KEY) || 0) < LOOP_MS;
  } catch {
    return false;
  }
};

// only once the server answers: a reload while it is down would leave a browser error page
export function reloadNow() {
  api.server().then(() => {
    try {
      sessionStorage.setItem(LOOP_KEY, String(Date.now()));
    } catch {}
    location.reload();
  }, () => {});
}

let waiting: ReturnType<typeof setInterval> | undefined;
let afterReconnect = false;
export function reloadWhenSafe() {
  if (!connected()) return void (afterReconnect = true);
  if (recent()) return void useUpdates.setState({ stale: true });
  if (!typing()) return reloadNow();
  useUpdates.setState({ stale: true });
  waiting ??= setInterval(() => !typing() && reloadNow(), SAFE_POLL_MS);
}

export function sawBuild(build: string | null | undefined) {
  if (loaded && build && build !== loaded) reloadWhenSafe();
}

let checked = 0;
const check = () => {
  checked = Date.now();
  if (loaded) api.server().then((s) => sawBuild(s.build), () => {});
};

export function watchUpdates() {
  let offline: ReturnType<typeof setTimeout> | undefined;
  onConnection((up) => {
    clearTimeout(offline);
    if (!up) return void (offline = setTimeout(() => useUpdates.setState({ offline: true }), OFFLINE_AFTER_MS));
    useUpdates.setState({ offline: false });
    if (afterReconnect) {
      afterReconnect = false;
      reloadWhenSafe();
    } else check();
  });
  addEventListener('focus', () => Date.now() - checked > FOCUS_CHECK_MS && check());
  // vite fires it when a lazy chunk (Monaco, Mermaid) cannot load: a build since replaced
  addEventListener('vite:preloadError', () => reloadWhenSafe());
  addEventListener('unhandledrejection', (e) => chunkGone(e.reason) && reloadWhenSafe());
}
