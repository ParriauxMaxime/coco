// one Paseo terminal in xterm.js, loaded on demand (its own chunk): output from the topic terminal:<ws>:<id>, keys and size posted back
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { errorMessage, termApi } from '../api.ts';
import { subscribe, topic } from '../live.ts';
import { getTheme, onThemeChange } from '../theme.ts';
import type { ResolvedTheme } from '../theme.ts';

const CHUNK = 32 * 1024;
const RESIZE_MS = 150;
// the default ANSI colours read on a dark panel; a light panel takes darker ones
const LIGHT: ITheme = { black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781', brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f' };

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const themeOf = (el: HTMLElement, mode: ResolvedTheme): ITheme => {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { ...(mode === 'light' ? LIGHT : {}), background: v('--dp-panel'), foreground: v('--dp-t1'), cursor: v('--dp-t1'), cursorAccent: v('--dp-panel'), selectionBackground: `${v('--dp-accent')}55` };
};
const note = (text: string) => `\r\n\x1b[2m${text}\x1b[0m\r\n`;

type Ev = { type: 'reset' | 'output'; data: string } | { type: 'exit'; error: string | null };

export default function XtermView({ wsId, terminalId }: { wsId: string; terminalId: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const term = new Terminal({ fontFamily: getComputedStyle(el).getPropertyValue('--dp-mono').trim() || 'ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, theme: themeOf(el, getTheme().resolved) });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const offTheme = onThemeChange((mode) => requestAnimationFrame(() => (term.options.theme = themeOf(el, mode))));

    // keys in order, one request at a time: what is typed meanwhile goes together in the next one
    let pending = '';
    let sending = false;
    const flush = async () => {
      if (sending || !pending) return;
      sending = true;
      const data = pending.slice(0, CHUNK);
      pending = pending.slice(CHUNK);
      try {
        await termApi.input(wsId, terminalId, data);
      } catch (e) {
        term.write(note(errorMessage(e)));
      }
      sending = false;
      void flush();
    };
    const typed = term.onData((d) => {
      pending += d;
      void flush();
    });

    // fitted to its box; Paseo's terminal follows once the size settles
    let timer: ReturnType<typeof setTimeout> | undefined;
    let told = '';
    const resize = () => {
      if (!el.offsetWidth || !el.offsetHeight) return;
      fit.fit();
      clearTimeout(timer);
      timer = setTimeout(() => {
        const size = `${term.rows}x${term.cols}`;
        if (size === told) return;
        told = size;
        termApi.resize(wsId, terminalId, term.rows, term.cols).catch(() => {});
      }, RESIZE_MS);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const off = subscribe(topic('terminal', wsId, terminalId), {
      message: (ev: Ev) => {
        if (ev.type === 'reset') {
          term.reset();
          term.write(bytes(ev.data));
          told = '';
          resize();
        } else if (ev.type === 'output') term.write(bytes(ev.data));
        else if (ev.type === 'exit') term.write(note(ev.error ? `Paseo stopped streaming it: ${ev.error}` : 'The terminal ended.'));
      },
      error: (e: { error: string }) => term.write(note(e.error)),
    });
    term.focus();
    return () => {
      off();
      offTheme();
      ro.disconnect();
      clearTimeout(timer);
      typed.dispose();
      term.dispose();
    };
  }, [wsId, terminalId]);
  return <div ref={box} className="tm-xterm" />;
}
