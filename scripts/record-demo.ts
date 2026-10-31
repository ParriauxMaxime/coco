// Records the README media (docs/media) against a demo coco seeded with fictional data, never your own server.
// Usage: node scripts/record-demo.ts [shots|video|all]   (reseed between two runs: the video takes a decision)
// Env: COCO_URL (default http://127.0.0.1:8793), OUT_DIR (default docs/media), DEMO_SLUG, DEMO_THEME (dark|light),
//      DEMO_VIEWPORT (default 1440x900; 640x1138 makes the 9:16 phone cut, written as demo-vertical.mp4),
//      PLAYWRIGHT_MODULE (path to playwright's index.mjs when not installed here).
// Expects the demo work: rows b:export-api, b:export-ui, b:export-toggle, the "Customer names…" finding with its thread.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

interface Box { x: number; y: number; width: number; height: number; top: number; bottom: number; left: number; right: number }
interface Point { x: number; y: number }
interface DomElement { parentElement: DomElement | null; scrollHeight: number; clientHeight: number; getBoundingClientRect(): Box; scrollBy(o: { top: number; behavior: string }): void; style: Record<string, string>; firstChild: DomElement }
interface LocatorOptions { has?: Locator; hasText?: string | RegExp }
interface Locator {
  first(): Locator;
  last(): Locator;
  count(): Promise<number>;
  waitFor(o?: { state?: string; timeout?: number }): Promise<void>;
  boundingBox(): Promise<Box | null>;
  click(): Promise<void>;
  evaluate<T>(fn: (el: DomElement, arg: T) => unknown, arg?: T): Promise<unknown>;
  locator(sel: string, o?: LocatorOptions): Locator;
}
interface Page {
  goto(url: string): Promise<void>;
  setContent(html: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: (arg: T) => unknown, arg?: T): Promise<T>;
  keyboard: { press(k: string): Promise<void> };
  mouse: { move(x: number, y: number, o?: { steps?: number }): Promise<void>; down(): Promise<void>; up(): Promise<void>; wheel(dx: number, dy: number): Promise<void> };
  video(): { path(): Promise<string> };
  locator(sel: string, o?: LocatorOptions): Locator;
  getByText(t: string | RegExp): Locator;
  screenshot(o: { path: string }): Promise<void>;
}
interface BrowserContext { newPage(): Promise<Page>; addInitScript(script: string): Promise<void>; close(): Promise<void> }
interface Browser { newContext(o?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; colorScheme?: string; recordVideo?: { dir: string; size: { width: number; height: number } } }): Promise<BrowserContext>; close(): Promise<void> }

declare const getComputedStyle: (el: DomElement) => { overflowY: string };
declare const location: { hash: string };

// playwright is not a dependency of coco: PLAYWRIGHT_MODULE picks the install at run time, a literal cannot
const { chromium }: { chromium: { launch(): Promise<Browser> } } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.COCO_URL || 'http://127.0.0.1:8793';
const OUT = path.resolve(process.env.OUT_DIR || path.join(HERE, '../docs/media'));
const SLUG = process.env.DEMO_SLUG || 'invoice-csv-export';
const MODE = process.argv[2] || 'all';
const THEME = process.env.DEMO_THEME === 'light' ? 'light' : 'dark';
const [vw, vh] = (process.env.DEMO_VIEWPORT || '1440x900').split('x').map(Number);
const VIEWPORT = { width: vw, height: vh };
const DSF = Number(process.env.DEMO_DSF || 1);
// a taller-than-wide frame is the phone shell: the title fills it and the caption clears the platform's chrome
const PORTRAIT = VIEWPORT.height > VIEWPORT.width;
fs.mkdirSync(OUT, { recursive: true });

// coco's palette, the one docs/media/banner.svg is drawn in
const CREAM = '#f3ecdc';
const VIOLET = '#7b7bf5';
const AMBER = '#f2b84b';
const MUTED = '#a9abb6';

const MARK = `<svg width="118" height="109" viewBox="150 190 700 645" aria-hidden="true">
  <path d="M630.7 320.5 A250 250 0 1 0 686.5 637" fill="none" stroke="${VIOLET}" stroke-width="140" stroke-linecap="round"/>
  <path fill="${AMBER}" d="M640 372 C770 360 852 455 842 600 C838 652 816 684 790 692 C794 622 762 574 684 566 C672 500 660 430 640 372 Z"/>
  <circle cx="560" cy="440" r="54" fill="${CREAM}"/>
</svg>`;

const CHIP = (text: string) => `<span class="chip"><i></i>${text}</span>`;

// type for the frame: a 9:16 cut is watched at arm's length on a phone, the 16:9 hero on a desktop
const TYPE = PORTRAIT
  ? { name: 92, line: 38, chip: 17, caption: 19, kicker: 12 }
  : { name: 116, line: 46, chip: 15.5, caption: 17, kicker: 11 };
// the caption sits where the platform draws nothing: bottom-left on a desktop, above the phone shell's tab bar
// and TikTok's own chrome (the bottom ~300 px of a 1920-tall video) on 9:16
const CAPTION_BOX = PORTRAIT
  ? 'left:0;right:0;margin:0 auto;width:fit-content;max-width:calc(100% - 40px);bottom:150px'
  : 'left:28px;bottom:26px';

// the film layer on the app page: a dim overlay that hosts the title and outro, a camera that zooms, a ring on
// whatever is acted on, a click ripple, and a caption chip. Nothing here is black: the app always shows through.
const OVERLAY = `(() => {
  const add = () => {
    if (document.getElementById('__demo_ring')) return;
    document.documentElement.style.overflow = 'hidden';
    const style = document.createElement('style');
    style.textContent = \`
      #__demo_dim{position:fixed;inset:0;z-index:2147483643;display:flex;align-items:center;justify-content:center;
        background:radial-gradient(120% 100% at 50% 42%, rgba(10,11,16,.62), rgba(8,9,13,.86));
        opacity:0;transition:opacity .38s ease;pointer-events:none}
      #__demo_dim.on{opacity:1}
      .tstage{display:flex;flex-direction:column;align-items:center;gap:14px;transform:translateY(10px);opacity:0;
        transition:transform .5s cubic-bezier(.2,.9,.2,1),opacity .5s ease}
      #__demo_dim.on .tstage{transform:none;opacity:1}
      .tname{font:800 ${TYPE.name}px/.9 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:-6px;color:${CREAM}}
      .tline{font:500 ${TYPE.line}px/1.15 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:-.6px;color:${MUTED}}
      .tline b{color:${VIOLET};font-weight:700}
      .trow{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;justify-content:center;max-width:${PORTRAIT ? '460' : '1000'}px}
      .chip{display:flex;align-items:center;gap:9px;padding:9px 15px;border-radius:11px;background:rgba(24,25,32,.9);
        border:1px solid rgba(243,236,220,.14);color:${CREAM};font:600 ${TYPE.chip}px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
      .chip i{width:8px;height:8px;border-radius:50%;background:${AMBER}}
      .chip.v i{background:${VIOLET}}
      #__demo_chip{position:fixed;z-index:2147483646;display:flex;flex-direction:column;gap:5px;padding:13px 21px 14px;
        border-radius:12px;background:rgba(18,19,25,.95);border:1px solid rgba(243,236,220,.14);border-left:3px solid ${VIOLET};
        color:${CREAM};box-shadow:0 18px 40px rgba(0,0,0,.55);pointer-events:none;opacity:0;transform:translateY(12px);
        transition:opacity .28s ease, transform .28s cubic-bezier(.2,.9,.2,1);${CAPTION_BOX};
        font:600 ${TYPE.caption}px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
      #__demo_chip b{font:700 ${TYPE.kicker}px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
        letter-spacing:.16em;text-transform:uppercase;color:${VIOLET}}
    \`;
    document.head.appendChild(style);

    const mk = (id) => { const d = document.createElement('div'); d.id = id; document.documentElement.appendChild(d); return d; };

    const dim = mk('__demo_dim');
    dim.innerHTML = '<div class="tstage"></div>';

    const cursor = mk('__demo_cursor');
    cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 2.5l13.5 10.2-6.1 1.1-3.3 6.2z" fill="#f3ecdc" stroke="#0b0c10" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-100px,-100px)', filter: 'drop-shadow(0 3px 6px rgba(0,0,0,.55))' });
    addEventListener('mousemove', (e) => (cursor.style.transform = 'translate(' + (e.clientX - 5) + 'px,' + (e.clientY - 3) + 'px)'), true);
    addEventListener('mousedown', () => (cursor.firstChild.style.transform = 'scale(.8)'), true);
    addEventListener('mouseup', () => (cursor.firstChild.style.transform = ''), true);

    const vig = mk('__demo_vig');
    Object.assign(vig.style, { position: 'fixed', inset: '0', zIndex: '2147483641', pointerEvents: 'none',
      background: 'radial-gradient(126% 96% at 50% 45%, transparent 58%, rgba(8,9,12,.34) 100%)' });

    const flash = mk('__demo_flash');
    Object.assign(flash.style, { position: 'fixed', inset: '0', zIndex: '2147483642', pointerEvents: 'none', opacity: '0',
      background: 'radial-gradient(40% 34% at 50% 50%, ${VIOLET}59, transparent 70%)', transition: 'opacity .22s ease' });

    const ring = mk('__demo_ring');
    Object.assign(ring.style, { position: 'fixed', zIndex: '2147483645', pointerEvents: 'none', border: '2px solid ${VIOLET}',
      borderRadius: '10px', boxShadow: '0 0 0 4px ${VIOLET}29, 0 0 34px ${VIOLET}5c', opacity: '0',
      transition: 'opacity .16s ease, transform .22s cubic-bezier(.2,.9,.2,1)', transform: 'scale(.96)' });

    const caption = mk('__demo_chip');
    caption.innerHTML = '<b></b><span></span>';
    Object.assign(caption.style, { opacity: '0', transform: 'translateY(12px)' });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})()`;

function actor(page: Page) {
  const wait = (ms: number) => page.waitForTimeout(ms);
  const center = async (loc: Locator) => {
    const b = await loc.boundingBox();
    if (!b) throw new Error(`no box for ${loc}`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const moveTo = (p: Point, steps = 22) => page.mouse.move(p.x, p.y, { steps });
  const reveal = async (loc: Locator, block = 'center') => {
    // scroll only the nearest scrolling pane: scrollIntoView also nudges the document, hiding the top bar
    await loc.evaluate((el, block) => {
      let p = el.parentElement;
      while (p && !(/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight)) p = p.parentElement;
      if (!p) return;
      const r = el.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      const delta = block === 'start' ? r.top - pr.top - 16 : block === 'end' ? r.bottom - pr.bottom + 16 : r.top + r.height / 2 - (pr.top + pr.height / 2);
      p.scrollBy({ top: delta, behavior: 'smooth' });
    }, block);
    await wait(680);
  };
  // the camera: zoom the app, origin on a point (the acted element), never on the overlays
  const camera = async (scale: number, ms: number, at?: Point) => {
    await page.evaluate(([s, d, p]: [number, number, Point | null]) => {
      const root = document.getElementById('root');
      if (!root) return;
      root.style.transformOrigin = p ? `${p.x}px ${p.y}px` : '50% 48%';
      root.style.transition = `transform ${d}ms cubic-bezier(.2,.9,.2,1)`;
      root.style.transform = `scale(${s})`;
    }, [scale, ms, at ?? null] as [number, number, Point | null]);
    await wait(ms);
  };
  const click = async (loc: Locator, { pause = 320, steps = 20 }: { pause?: number; steps?: number } = {}) => {
    await loc.waitFor({ state: 'visible', timeout: 15000 });
    const b = await loc.boundingBox();
    if (!b || b.y < 60 || b.y + b.height > VIEWPORT.height - 10) await reveal(loc);
    const p = await center(loc);
    await moveTo(p, steps);
    await wait(110);
    await page.evaluate(([pt, color]: [Point, string]) => {
      const r = document.createElement('span');
      Object.assign(r.style, { position: 'fixed', left: pt.x - 14 + 'px', top: pt.y - 14 + 'px', width: '28px', height: '28px',
        borderRadius: '50%', border: `2px solid ${color}`, zIndex: '2147483646', pointerEvents: 'none', opacity: '.95',
        transition: 'transform .42s cubic-bezier(.2,.9,.2,1), opacity .42s ease' });
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(2.1)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 460);
    }, [p, VIOLET] as [Point, string]);
    await page.mouse.down();
    await page.mouse.up();
    await wait(pause);
  };
  const hover = async (loc: Locator) => {
    await loc.waitFor({ state: 'visible', timeout: 15000 });
    await moveTo(await center(loc), 18);
    await wait(380);
  };
  const scroll = async (dy: number, at?: Point) => {
    if (at) await moveTo(at, 12);
    const step = dy > 0 ? 45 : -45;
    for (let done = 0; Math.abs(done) < Math.abs(dy); done += step) {
      await page.mouse.wheel(0, step);
      await wait(12);
    }
    await wait(200);
  };
  // wheel the pane under `at` until the element sits in view: a detail pane's button is often below the fold
  const intoView = async (loc: Locator, at: Point) => {
    for (let i = 0; i < 8; i++) {
      const b = await loc.boundingBox();
      if (b && b.y > 80 && b.y + b.height < VIEWPORT.height - 80) return;
      await moveTo(at, 6);
      await page.mouse.wheel(0, 260);
      await wait(180);
    }
  };
  const go = (hash: string) => page.evaluate((h: string) => (location.hash = h), hash);
  // a cut: punch the camera in, swap the tab under the cover of that push, settle back. No black frame.
  const cut = async (hash: string) => {
    await page.evaluate(() => {
      const f = document.getElementById('__demo_flash');
      const root = document.getElementById('root');
      if (f) f.style.opacity = '0.16';
      if (root) { root.style.transition = 'transform .16s ease-out'; root.style.transformOrigin = '50% 48%'; root.style.transform = 'scale(1.07)'; }
    });
    await wait(110);
    await go(hash);
    await wait(130);
    await page.evaluate(() => {
      const f = document.getElementById('__demo_flash');
      const root = document.getElementById('root');
      if (f) f.style.opacity = '0';
      if (root) { root.style.transition = 'transform .3s cubic-bezier(.2,.9,.2,1)'; root.style.transform = 'scale(1)'; }
    });
    await wait(190);
  };
  // the caption chip: a numbered kicker in caps and one line, swapped per beat
  const caption = async (kicker: string, line: string) => {
    await page.evaluate(([k, l]: [string, string]) => {
      const chip = document.getElementById('__demo_chip');
      const kicker = chip?.firstElementChild;
      const text = chip?.lastElementChild;
      if (!chip || !kicker || !text) return;
      chip.style.opacity = '0';
      chip.style.transform = 'translateY(12px)';
      kicker.textContent = k;
      text.textContent = l;
      requestAnimationFrame(() => {
        chip.style.opacity = l ? '1' : '0';
        chip.style.transform = l ? 'translateY(0)' : 'translateY(12px)';
      });
    }, [kicker, line] as [string, string]);
    await wait(line ? 300 : 180);
  };
  // a ring around what is about to be acted on, gone again when the beat moves on
  const ring = async (loc: Locator, hold = 900) => {
    const b = await loc.boundingBox();
    if (!b) return;
    await page.evaluate((r: { x: number; y: number; w: number; h: number }) => {
      const el = document.getElementById('__demo_ring');
      if (!el) return;
      el.style.left = r.x - 6 + 'px';
      el.style.top = r.y - 6 + 'px';
      el.style.width = r.w + 12 + 'px';
      el.style.height = r.h + 12 + 'px';
      el.style.opacity = '1';
      el.style.transform = 'scale(1)';
    }, { x: b.x, y: b.y, w: b.width, h: b.height });
    await wait(hold);
    await page.evaluate(() => {
      const el = document.getElementById('__demo_ring');
      if (el) { el.style.opacity = '0'; el.style.transform = 'scale(.97)'; }
    });
  };
  const card = async (html: string, hold: number) => {
    await page.evaluate((h: string) => {
      const dim = document.getElementById('__demo_dim');
      const stage = dim?.firstElementChild;
      if (!dim || !stage) return;
      stage.innerHTML = h;
      dim.classList.remove('on');
      requestAnimationFrame(() => dim.classList.add('on'));
    }, html);
    await wait(hold);
  };
  const dimOff = async () => {
    await page.evaluate(() => document.getElementById('__demo_dim')?.classList.remove('on'));
    await wait(420);
  };
  return { wait, moveTo, reveal, click, hover, scroll, intoView, go, cut, camera, caption, ring, card, dimOff };
}

const findingRow = (page: Page, text: string) => page.locator('.dp-fi-row', { has: page.locator('.dp-fi-claim', { hasText: text }) });

// the four README stills, in the demo's own state: plan, review, findings, thread
async function shots(browser: Browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: THEME });
  const page = await ctx.newPage();
  const a = actor(page);
  const shot = async (name: string) => {
    await a.wait(600);
    await page.screenshot({ path: path.join(OUT, name) });
    console.log('wrote', name);
  };

  await page.goto(`${URL}/#/work/${SLUG}/plan`);
  await page.getByText('CSV serializer and export endpoint').first().waitFor();
  await a.wait(1400);
  await shot('stack-plan.png');

  await page.goto(`${URL}/#/work/${SLUG}/review-b:export-api`);
  await page.locator('.rv-card').first().waitFor();
  await a.wait(1200);
  await page.locator('.rv-card-h', { hasText: 'csv-export.ts' }).first().click();
  await a.wait(2200);
  await shot('code-review.png');

  await page.goto(`${URL}/#/work/${SLUG}/findings`);
  await page.locator('.dp-fi-row').first().waitFor();
  await a.wait(1200);
  await page.locator('.dp-fi-claim', { hasText: 'Customer names' }).first().click();
  await a.wait(1000);
  await shot('findings-board.png');

  await a.reveal(page.locator('.dp-fi-thread').first(), 'end');
  await a.wait(900);
  await shot('agent-thread.png');
  await ctx.close();
}

// one continuous pass over the app: the camera never stops, the cuts are pushes, nothing goes black
async function video(browser: Browser) {
  const dir = fs.mkdtempSync(path.join(OUT, '.rec-'));
  const size = { width: VIEWPORT.width * DSF, height: VIEWPORT.height * DSF };
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DSF, colorScheme: THEME, recordVideo: { dir, size } });
  await ctx.addInitScript(OVERLAY);
  const page = await ctx.newPage();
  const a = actor(page);
  // points are fractions of the frame, so one beat works at 1440x900 and in a 540x960 phone shell
  const at = (fx: number, fy: number): Point => ({ x: Math.round(VIEWPORT.width * fx), y: Math.round(VIEWPORT.height * fy) });

  // open on the work, the title rising over it: a feed decides in the first second, so the phone cut is the card
  // from its first frame, and the desktop hero lets the app breathe first
  await page.goto(`${URL}/#/work/${SLUG}/plan`);
  await page.getByText('CSV serializer and export endpoint').first().waitFor();
  await a.wait(PORTRAIT ? 260 : 500);
  if (!PORTRAIT) await a.camera(1.02, 450);
  await a.card(`<div class="tstage"><div>${MARK}</div><div class="tname">coco</div><div class="tline">ADE, but <b>your way.</b></div>
    <div class="trow"><span class="chip v"><i></i>one stack, many agents</span><span class="chip"><i></i>decisions you click</span>
    <span class="chip v"><i></i>every remark, one board</span></div></div>`, PORTRAIT ? 2100 : 1500);
  await a.dimOff();

  // 01 the work: its stack, its progress, what is next
  await a.caption('01 — Plan', 'One work: the stack, its progress, what is next.');
  await a.ring(page.locator('.dp-segs').first(), 600);
  await a.camera(1.06, 1200);
  await a.scroll(260, at(0.43, 0.58));
  await a.ring(page.locator('.dp-next').first(), 800);
  await a.camera(1.02, 500);

  // 02 a decision taken beside the plan
  await a.caption('02 — Decide', 'Answer the decision that blocks the build.');
  await a.cut(`#/work/${SLUG}/decisions`);
  await page.locator('.dp-dc-row').first().waitFor();
  await a.wait(400);
  await a.ring(page.locator('.dp-dc-row').first(), 450);
  await a.click(page.locator('.dp-dc-row').first(), { pause: 650 });
  const takeBtn = page.locator('.dp-dc-actions .dp-primary').first();
  await a.ring(takeBtn, 450);
  await a.click(takeBtn, { pause: 60 });
  // the take blanks its board for a second while it refetches: the punch into the next beat starts on the click, so
  // the ripple and the flash carry it and the empty bucket never shows

  // 03 review: files in reading order, a watch point and its fix beside the line
  await a.caption('03 — Review', 'Files in reading order. Fixes beside the line.');
  await a.cut(`#/work/${SLUG}/review-b:export-api`);
  await page.locator('.rv-card').first().waitFor();
  await a.wait(500);
  const fileCard = page.locator('.rv-card-h', { hasText: 'csv-export.ts' }).first();
  await a.ring(fileCard, 400);
  await a.click(fileCard, { pause: 700 });
  const watch = page.locator('.rv-card-wp').first();
  await a.camera(1.05, 800);
  await a.scroll(420, at(0.6, 0.62));
  await a.moveTo(at(0.63, 0.42), 16);
  await a.wait(350);
  await a.ring(watch, 700);
  await a.camera(1.01, 400);

  // 04 findings: the whole PR in one board, the worst one read with the agent's answer
  await a.caption('04 — Findings', 'Every remark in one board. Accept starts the fix agent.');
  await a.cut(`#/work/${SLUG}/findings`);
  await page.locator('.dp-fi-row').first().waitFor();
  await a.wait(600);
  const worst = findingRow(page, 'Customer names');
  await a.ring(worst, 400);
  await a.click(worst.locator('.dp-fi-claim'), { pause: 700 });
  const accept = page.locator('.dp-fi-actions button', { hasText: /^Accept/ }).first();
  await a.intoView(accept, at(0.63, 0.58));
  await a.ring(accept, 550);
  await a.hover(accept);
  await a.wait(250);
  await a.caption('05 — Fix', 'The agent answers in the thread, with a patch you approve.');
  await a.reveal(page.locator('.dp-fi-thread').first(), 'center');
  await a.camera(1.04, 900);
  await a.wait(700);

  // 06 the stack, in merge order: three short rows leave a phone frame empty, so the vertical cut ends on the patch
  if (!PORTRAIT) {
    await a.cut(`#/work/${SLUG}/stack`);
    await a.caption('06 — Stack', 'Rows in merge order, gates on each.');
    await a.moveTo(at(0.43, 0.33), 18);
    await a.camera(1.05, 1100);
    await a.wait(400);
  }
  await a.caption('', '');
  await a.camera(1.02, 400);
  await a.card(`<div class="tstage"><div>${MARK}</div><div class="tline" style="font-size:${PORTRAIT ? 34 : 52}px">ADE, but <b>your way.</b></div>
    <div class="trow"><span class="chip"><i></i>github.com/ParriauxMaxime/coco</span></div></div>`, 2000);

  const raw = await page.video().path();
  await ctx.close();
  const webm = path.join(OUT, '.rec-raw.webm');
  fs.renameSync(raw, webm);
  fs.rmSync(dir, { recursive: true, force: true });
  encode(webm, PORTRAIT ? 1.45 : 0.25);
}

// writes demo.mp4 (H.264, what GitHub plays), demo.webm (VP9), a demo.jpg poster and the README's demo.gif; the
// vertical take writes demo-vertical.mp4 and its cover only: a phone feed wants neither a GIF nor a webm
function encode(raw: string, start: number) {
  const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    console.log('no ffmpeg: kept', raw);
    return;
  }
  const stem = PORTRAIT ? 'demo-vertical' : 'demo';
  const out = (ext: string) => path.join(OUT, `${stem}.${ext}`);
  const trim = ['-ss', start.toFixed(2)];
  // the recorder captures CSS pixels: the phone shell is recorded at 640x1138 and lands on TikTok's 1080x1920
  const frame = PORTRAIT ? ['-vf', 'scale=1080:1920:flags=lanczos'] : [];
  ff([...trim, '-i', raw, ...frame, '-c:v', 'libx264', '-preset', 'slow', '-crf', '25', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out('mp4')]);
  ff(['-ss', (start + (PORTRAIT ? 0.8 : 11.5)).toFixed(2), '-i', raw, ...frame, '-frames:v', '1', '-q:v', '3', out('jpg')]);
  if (PORTRAIT) {
    fs.rmSync(raw);
    console.log(`wrote ${path.basename(out('mp4'))} (${(fs.statSync(out('mp4')).size / 1048576).toFixed(1)} MB), ${path.basename(out('jpg'))}`);
    return;
  }
  ff([...trim, '-i', raw, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-row-mt', '1', '-an', out('webm')]);
  // the GIF is the README's inline hero: 820px, 8 fps, a 192-colour palette; gifsicle then packs the frames
  const palette = path.join(OUT, '.palette.png');
  const gif = out('gif');
  const scale = 'scale=820:-1:flags=lanczos';
  ff([...trim, '-i', raw, '-vf', `fps=8,${scale},palettegen=max_colors=192:stats_mode=diff`, '-y', palette]);
  ff([...trim, '-i', raw, '-i', palette, '-lavfi', `fps=8,${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`, '-loop', '0', gif]);
  fs.rmSync(palette);
  // a moving camera makes every frame differ, which raw GIF stores three times over: gifsicle packs it under 8 MB
  try {
    execFileSync('gifsicle', ['-b', '-O3', '--lossy=140', gif], { stdio: 'inherit' });
  } catch {
    console.log('no gifsicle: demo.gif keeps its raw size');
  }
  fs.rmSync(raw);
  const mb = (f: string) => (fs.statSync(out(f)).size / 1048576).toFixed(1);
  console.log(`wrote demo.mp4 (${mb('mp4')} MB), demo.webm (${mb('webm')} MB), demo.jpg, demo.gif (${mb('gif')} MB)`);
}

const browser = await chromium.launch();
try {
  if (MODE === 'shots' || MODE === 'all') await shots(browser);
  if (MODE === 'video' || MODE === 'all') await video(browser);
} finally {
  await browser.close();
}
