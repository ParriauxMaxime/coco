// The composer's mic: the words go through Paseo's own speech to text (server/dictation.ts), the mic captured here as 16-bit mono PCM
// and posted in quarter-second chunks, the transcript so far coming back on topic dictation:<id>. With Paseo's dictation off, Chrome's
// own speech recognition stands in; Electron has the API without Google's keys behind it, so the desktop app never uses it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { dictationApi, errorMessage } from '../../api.ts';
import { subscribe, topic } from '../../live.ts';

export type Engine = 'paseo' | 'browser';
export type Availability = { engine: Engine | null; reason: string | null };
export type DictationState = 'idle' | 'starting' | 'live' | 'finishing';
type Run = { stop(): Promise<string>; cancel(): void };
type Events = { partial(text: string): void; failed(error: string): void; ended(text: string): void };

const CHECK_MS = 30000;
const FLUSH_MS = 1000;

// ---- Chrome's speech recognition (no types in lib.dom)

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
const recognizer = () => {
  if (typeof window === 'undefined' || /Electron/.test(navigator.userAgent)) return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

let checked: { at: number; p: Promise<Availability> } | null = null;
export function availability(fresh = false): Promise<Availability> {
  if (!fresh && checked && Date.now() - checked.at < CHECK_MS) return checked.p;
  const p = dictationApi.status().then(
    (s) => ({ available: s.available, reason: s.reason }),
    (e) => ({ available: false, reason: errorMessage(e) }),
  ).then(({ available, reason }): Availability => {
    if (available) return { engine: 'paseo', reason: null };
    if (recognizer()) return { engine: 'browser', reason: `Paseo's dictation: ${reason}; the browser's speech recognition stands in` };
    return { engine: null, reason: `Dictation unavailable: ${reason}` };
  });
  checked = { at: Date.now(), p };
  return p;
}

// ---- capture

const WORKLET = `class CocoPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(Math.round(sampleRate / 4));
    this.n = 0;
    this.port.onmessage = () => { this.flush(); this.port.postMessage('done'); };
  }
  flush() {
    if (!this.n) return;
    const out = this.buf.slice(0, this.n);
    this.port.postMessage(out.buffer, [out.buffer]);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) this.flush();
    }
    return true;
  }
}
registerProcessor('coco-pcm', CocoPcm);`;
let workletUrl: string | null = null;

const base64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const micError = (e: unknown) => {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError') return 'the microphone is blocked for this page: allow it in the browser (or System Settings → Privacy → Microphone)';
  if (name === 'NotFoundError') return 'no microphone found';
  return errorMessage(e);
};

async function paseoRun(on: Events): Promise<Run> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('this page cannot reach a microphone (it needs http://127.0.0.1 or https)');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).catch((e) => {
    throw new Error(micError(e));
  });
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
  } catch {
    ctx = new AudioContext();
  }
  const id = crypto.randomUUID();
  let over = false;
  let ending = false;
  let failure: string | null = null;
  const unsub = subscribe(topic('dictation', id), {
    partial: (d: { text: string }) => !over && on.partial(d.text),
    failed: (d: { error: string }) => fail(d.error),
  });
  const release = () => {
    over = true;
    unsub();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };
  function fail(error: string) {
    if (over || error === 'cancelled') return;
    failure = error;
    release();
    void dictationApi.cancel(id).catch(() => {});
    // a failure while stopping is stop's to throw
    if (!ending) on.failed(error);
  }
  try {
    workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(workletUrl);
    await dictationApi.start(id, ctx.sampleRate);
  } catch (e) {
    release();
    throw e;
  }
  const node = new AudioWorkletNode(ctx, 'coco-pcm');
  ctx.createMediaStreamSource(stream).connect(node);
  // the processor writes no output: connected only so the graph pulls it
  node.connect(ctx.destination);
  let chain = Promise.resolve();
  let flushed: (() => void) | null = null;
  node.port.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (e.data === 'done') return flushed?.();
    const audio = base64(e.data as ArrayBuffer);
    chain = chain.then(() => (over || failure ? undefined : dictationApi.audio(id, audio).then(() => {}, (err) => fail(errorMessage(err)))));
  };
  return {
    async stop() {
      ending = true;
      await new Promise<void>((done) => {
        flushed = done;
        node.port.postMessage('flush');
        setTimeout(done, FLUSH_MS);
      });
      stream.getTracks().forEach((t) => t.stop());
      await chain;
      if (failure) throw new Error(failure);
      over = true;
      try {
        return (await dictationApi.finish(id)).text;
      } finally {
        release();
      }
    },
    cancel() {
      if (over) return;
      release();
      void dictationApi.cancel(id).catch(() => {});
    },
  };
}

function browserRun(on: Events): Promise<Run> {
  const Ctor = recognizer();
  if (!Ctor) return Promise.reject(new Error('this browser has no speech recognition'));
  const r = new Ctor();
  r.continuous = true;
  r.interimResults = true;
  r.lang = navigator.language || 'en-US';
  let text = '';
  let stopping: ((text: string) => void) | null = null;
  let cancelled = false;
  return new Promise<Run>((resolve, reject) => {
    let started = false;
    r.onstart = () => {
      started = true;
      resolve({
        stop: () => new Promise<string>((done) => {
          stopping = done;
          r.stop();
        }),
        cancel: () => {
          cancelled = true;
          r.abort();
        },
      });
    };
    r.onresult = (e) => {
      text = Array.from(e.results, (res) => res[0]?.transcript ?? '').join('').trim();
      on.partial(text);
    };
    r.onerror = (e) => {
      if (e.error === 'aborted' || e.error === 'no-speech') return;
      const why = e.error === 'not-allowed' ? 'the microphone is blocked for this page' : `speech recognition failed (${e.error})`;
      if (!started) reject(new Error(why));
      else if (!cancelled) {
        cancelled = true;
        on.failed(why);
      }
    };
    // Chrome ends a recognition after a silence on its own: what it heard so far is the final text
    r.onend = () => {
      if (stopping) stopping(text);
      else if (!cancelled && started) on.ended(text);
      else if (!started) reject(new Error('speech recognition did not start'));
    };
    r.start();
  });
}

// onText(text, final): the whole transcript so far, replacing the previous one
export function useDictation({ onText, onError }: { onText: (text: string, final: boolean) => void; onError: (message: string) => void }) {
  const [avail, setAvail] = useState<Availability | null>(null);
  const [state, setState] = useState<DictationState>('idle');
  const run = useRef<Run | null>(null);
  const mounted = useRef(true);
  const cbs = useRef({ onText, onError });
  cbs.current = { onText, onError };
  useEffect(() => {
    mounted.current = true;
    void availability().then((a) => mounted.current && setAvail(a));
    return () => {
      mounted.current = false;
      run.current?.cancel();
      run.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    if (state !== 'idle') return;
    setState('starting');
    const a = await availability(true);
    setAvail(a);
    if (!a.engine) {
      setState('idle');
      return cbs.current.onError(a.reason ?? 'Dictation unavailable');
    }
    const on: Events = {
      partial: (t) => cbs.current.onText(t, false),
      failed: (error) => {
        run.current = null;
        setState('idle');
        cbs.current.onError(`Dictation stopped: ${error}`);
      },
      ended: (t) => {
        run.current = null;
        setState('idle');
        cbs.current.onText(t, true);
      },
    };
    try {
      const r = await (a.engine === 'paseo' ? paseoRun(on) : browserRun(on));
      if (!mounted.current) return r.cancel();
      run.current = r;
      setState('live');
    } catch (e) {
      setState('idle');
      cbs.current.onError(`Dictation did not start: ${errorMessage(e)}`);
    }
  }, [state]);

  const stop = useCallback(async () => {
    const r = run.current;
    if (!r) return;
    run.current = null;
    setState('finishing');
    try {
      cbs.current.onText(await r.stop(), true);
    } catch (e) {
      cbs.current.onError(`Dictation failed: ${errorMessage(e)}`);
    } finally {
      setState('idle');
    }
  }, []);

  const toggle = useCallback(() => (state === 'idle' ? start() : state === 'live' ? stop() : undefined), [state, start, stop]);
  return { avail, state, start, stop, toggle };
}
