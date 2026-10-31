// Records the README media (docs/media) against a demo coco seeded with fictional data, never your own server.
// Usage: node scripts/record-demo.ts [shots|video|all]   (reseed between two runs: the video takes a decision)
// Env: COCO_URL (default http://127.0.0.1:8793), OUT_DIR (default docs/media), DEMO_SLUG, DEMO_THEME (dark|light),
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
const VIEWPORT = { width: 1440, height: 900 };
fs.mkdirSync(OUT, { recursive: true });

// coco's palette, the one docs/media/banner.svg is drawn in, on a near-black film backdrop
const CREAM = '#f3ecdc';
const VIOLET = '#7b7bf5';
const AMBER = '#f2b84b';
const MUTED = '#a9abb6';
const FILM = '#0b0c10';

const MARK = `<svg width="150" height="138" viewBox="150 190 700 645" aria-hidden="true">
  <path d="M630.7 320.5 A250 250 0 1 0 686.5 637" fill="none" stroke="${VIOLET}" stroke-width="140" stroke-linecap="round"/>
  <path fill="${AMBER}" d="M640 372 C770 360 852 455 842 600 C838 652 816 684 790 692 C794 622 762 574 684 566 C672 500 660 430 640 372 Z"/>
  <circle cx="560" cy="440" r="54" fill="${CREAM}"/>
</svg>`;

// a card is page content, so the recording carries it: dark stage, a violet glow, tilted chips that pop in
const card = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:${FILM};color:${CREAM};overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
  .stage{position:relative;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;
    animation:fade .5s ease-out both}
  .glow{position:absolute;inset:-25%;background:
    radial-gradient(44% 38% at 32% 28%, ${VIOLET}4d, transparent 70%),
    radial-gradient(38% 34% at 72% 74%, ${AMBER}29, transparent 70%);
    filter:blur(6px);animation:breathe 6s ease-in-out infinite alternate}
  .mark{position:relative;animation:rise .7s cubic-bezier(.2,.9,.2,1) .1s both}
  .name{position:relative;margin:0;font-size:164px;font-weight:800;letter-spacing:-8px;line-height:.88;animation:rise .7s cubic-bezier(.2,.9,.2,1) .18s both}
  .line{position:relative;margin:0;font-size:54px;font-weight:500;color:${MUTED};letter-spacing:-.5px;animation:rise .7s cubic-bezier(.2,.9,.2,1) .3s both}
  .line b{color:${VIOLET};font-weight:700}
  .chips{position:absolute;inset:0;pointer-events:none}
  .chip{position:absolute;display:flex;align-items:center;gap:10px;padding:11px 17px;border-radius:12px;background:rgba(24,25,32,.93);
    border:1px solid rgba(243,236,220,.13);font-size:17px;font-weight:600;color:${CREAM};box-shadow:0 20px 44px rgba(0,0,0,.5);
    transform:translateY(14px) rotate(var(--r)) scale(.96);opacity:0;animation:pop .72s cubic-bezier(.2,.9,.2,1) forwards;animation-delay:calc(var(--i)*95ms + 320ms)}
  .chip i{width:9px;height:9px;border-radius:50%;background:var(--c)}
  @keyframes pop{to{opacity:1;transform:translateY(0) rotate(var(--r)) scale(1)}}
  @keyframes rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  @keyframes breathe{from{transform:scale(1)}to{transform:scale(1.06)}}
</style></head><body><div class="stage"><div class="glow"></div>${body}</div></body></html>`;

const TITLE_CHIPS = `<div class="chips">
  <span class="chip" style="--i:0;--r:-3deg;--c:${AMBER};top:15%;left:7%"><i></i>one stack, many agents</span>
  <span class="chip" style="--i:1;--r:2.5deg;--c:${VIOLET};top:21%;right:8%"><i></i>decisions you click</span>
  <span class="chip" style="--i:2;--r:2deg;--c:${VIOLET};bottom:19%;left:10%"><i></i>every remark, one board</span>
  <span class="chip" style="--i:3;--r:-2.5deg;--c:${AMBER};bottom:15%;right:9%"><i></i>an agent that answers</span>
</div>`;

const TITLE_CARD = card(`${TITLE_CHIPS}<div class="mark">${MARK}</div><h1 class="name">coco</h1><p class="line">ADE, but <b>your way.</b></p>`);
const OUTRO_CARD = card(`${TITLE_CHIPS}<div class="mark">${MARK}</div><p class="line">ADE, but <b>your way.</b></p>
  <span class="chip" style="--i:4;--r:0deg;--c:${AMBER};position:relative;margin-top:18px;font-size:19px"><i></i>github.com/ParriauxMaxime/coco</span>`);

// the film overlay on the app page: cursor, a focus vignette, a ring on what is acted on, a cut wipe, the caption chip
const OVERLAY = `(() => {
  const add = () => {
    if (document.getElementById('__demo_ring')) return;
    const mk = (id) => { const d = document.createElement('div'); d.id = id; document.documentElement.appendChild(d); return d; };

    const cursor = mk('__demo_cursor');
    cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 2.5l13.5 10.2-6.1 1.1-3.3 6.2z" fill="#f3ecdc" stroke="#0b0c10" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-100px,-100px)', filter: 'drop-shadow(0 3px 6px rgba(0,0,0,.55))' });
    addEventListener('mousemove', (e) => (cursor.style.transform = 'translate(' + (e.clientX - 5) + 'px,' + (e.clientY - 3) + 'px)'), true);
    addEventListener('mousedown', () => (cursor.firstChild.style.transform = 'scale(.82)'), true);
    addEventListener('mouseup', () => (cursor.firstChild.style.transform = ''), true);

    const vig = mk('__demo_vig');
    Object.assign(vig.style, { position: 'fixed', inset: '0', zIndex: '2147483644', pointerEvents: 'none',
      background: 'radial-gradient(118% 88% at 50% 45%, transparent 52%, rgba(8,9,12,.46) 100%)' });

    const ring = mk('__demo_ring');
    Object.assign(ring.style, { position: 'fixed', zIndex: '2147483645', pointerEvents: 'none', border: '2px solid ${VIOLET}',
      borderRadius: '9px', boxShadow: '0 0 0 4px ${VIOLET}29, 0 0 30px ${VIOLET}66', opacity: '0',
      transition: 'opacity .18s ease, transform .22s ease', transform: 'scale(.97)' });

    const wipe = mk('__demo_wipe');
    Object.assign(wipe.style, { position: 'fixed', inset: '0', zIndex: '2147483646', pointerEvents: 'none',
      background: '${FILM}', opacity: '0', transition: 'opacity .14s ease' });

    const chip = mk('__demo_chip');
    chip.innerHTML = '<b></b><span></span>';
    Object.assign(chip.style, { position: 'fixed', left: '28px', bottom: '26px', zIndex: '2147483646', display: 'flex',
      flexDirection: 'column', gap: '5px', padding: '12px 20px 13px', borderRadius: '12px', background: 'rgba(18,19,25,.94)',
      border: '1px solid rgba(243,236,220,.13)', borderLeft: '3px solid ${VIOLET}', color: '${CREAM}',
      boxShadow: '0 16px 36px rgba(0,0,0,.55)', pointerEvents: 'none', opacity: '0', transform: 'translateY(10px)',
      transition: 'opacity .3s ease, transform .3s ease',
      font: '600 15.5px/1.35 -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif' });
    Object.assign(chip.firstChild.style, { font: '700 10.5px/1.2 -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif',
      letterSpacing: '.15em', textTransform: 'uppercase', color: '${VIOLET}' });
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
    await wait(700);
  };
  const click = async (loc: Locator, { pause = 350, steps = 22 }: { pause?: number; steps?: number } = {}) => {
    await loc.waitFor({ state: 'visible', timeout: 15000 });
    const b = await loc.boundingBox();
    if (!b || b.y < 60 || b.y + b.height > VIEWPORT.height - 10) await reveal(loc);
    await moveTo(await center(loc), steps);
    await wait(110);
    await page.mouse.down();
    await page.mouse.up();
    await wait(pause);
  };
  const hover = async (loc: Locator) => {
    await loc.waitFor({ state: 'visible', timeout: 15000 });
    await moveTo(await center(loc), 20);
    await wait(400);
  };
  const scroll = async (dy: number, at?: Point) => {
    if (at) await moveTo(at, 14);
    const step = dy > 0 ? 40 : -40;
    for (let done = 0; Math.abs(done) < Math.abs(dy); done += step) {
      await page.mouse.wheel(0, step);
      await wait(14);
    }
    await wait(220);
  };
  // wheel the pane under `at` until the element sits in view: a detail pane's button is often below the fold
  const intoView = async (loc: Locator, at: Point) => {
    for (let i = 0; i < 8; i++) {
      const b = await loc.boundingBox();
      if (b && b.y > 80 && b.y + b.height < VIEWPORT.height - 80) return;
      await moveTo(at, 6);
      await page.mouse.wheel(0, 260);
      await wait(190);
    }
  };
  const go = (hash: string) => page.evaluate((h: string) => (location.hash = h), hash);
  const wipe = async (on: boolean) => {
    await page.evaluate((o: boolean) => {
      const w = document.getElementById('__demo_wipe');
      if (w) w.style.opacity = o ? '1' : '0';
    }, on);
    await wait(on ? 170 : 200);
  };
  // the caption chip: a kicker in caps and one line, swapped per beat
  const caption = async (kicker: string, line: string) => {
    await page.evaluate(([k, l]: [string, string]) => {
      const chip = document.getElementById('__demo_chip');
      const kicker = chip?.firstElementChild;
      const text = chip?.lastElementChild;
      if (!chip || !kicker || !text) return;
      chip.style.opacity = '0';
      chip.style.transform = 'translateY(10px)';
      kicker.textContent = k;
      text.textContent = l;
      requestAnimationFrame(() => {
        chip.style.opacity = l ? '1' : '0';
        chip.style.transform = l ? 'translateY(0)' : 'translateY(10px)';
      });
    }, [kicker, line] as [string, string]);
    await wait(line ? 320 : 200);
  };
  // a ring around what is about to be acted on, gone again after 1.8 s
  const ring = async (loc: Locator, hold = 1500) => {
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
  return { wait, moveTo, reveal, click, hover, scroll, intoView, go, wipe, caption, ring };
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

// one pass, dark stage to dark stage: title card, four beats with a caption chip and a ring on what is acted on, outro
async function video(browser: Browser) {
  const dir = fs.mkdtempSync(path.join(OUT, '.rec-'));
  const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: THEME, recordVideo: { dir, size: VIEWPORT } });
  await ctx.addInitScript(OVERLAY);
  const page = await ctx.newPage();
  const a = actor(page);

  await page.setContent(TITLE_CARD);
  await a.wait(3400);

  // the work: its stack, its progress, what is next
  await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('.stage');
    if (!stage) return;
    stage.style.transition = 'opacity .24s ease';
    stage.style.opacity = '0';
  });
  await a.wait(260);
  await a.wipe(true);
  await page.goto(`${URL}/#/work/${SLUG}/plan`);
  await page.getByText('CSV serializer and export endpoint').first().waitFor();
  await a.wipe(false);
  await a.caption('Plan', 'One work: the stack, its progress, what is next.');
  await a.ring(page.locator('.dp-segs').first(), 800);
  await a.scroll(280, { x: 620, y: 520 });
  await a.ring(page.locator('.dp-next').first(), 900);
  await a.wait(300);

  // a decision taken beside the plan
  await a.caption('', '');
  await a.wipe(true);
  await a.go(`#/work/${SLUG}/decisions`);
  await page.locator('.dp-dc-row').first().waitFor();
  await a.wipe(false);
  await a.caption('Decide', 'Answer the decision that blocks the build.');
  await a.wait(400);
  await a.ring(page.locator('.dp-dc-row').first(), 500);
  await a.click(page.locator('.dp-dc-row').first(), { pause: 900 });
  await a.ring(page.locator('.dp-dc-actions .dp-primary').first(), 700);
  await a.click(page.locator('.dp-dc-actions .dp-primary').first(), { pause: 400 });

  // review: files in reading order, a watch point and its fix beside the line
  await a.caption('', '');
  await a.wipe(true);
  await a.go(`#/work/${SLUG}/review-b:export-api`);
  await page.locator('.rv-card').first().waitFor();
  await a.wipe(false);
  await a.caption('Review', 'Files in reading order. Fixes beside the line.');
  await a.wait(500);
  const fileCard = page.locator('.rv-card-h', { hasText: 'csv-export.ts' }).first();
  await a.ring(fileCard, 500);
  await a.click(fileCard, { pause: 1100 });
  await a.scroll(320, { x: 860, y: 560 });
  await a.moveTo({ x: 900, y: 380 }, 18);
  await a.scroll(280);
  await a.wait(600);

  // findings: the whole PR in one board, the worst one read with its thread
  await a.caption('', '');
  await a.wipe(true);
  await a.go(`#/work/${SLUG}/findings`);
  await page.locator('.dp-fi-row').first().waitFor();
  await a.wipe(false);
  await a.caption('Findings', 'Every remark in one board. Accept starts the fix agent.');
  await a.wait(500);
  const worst = findingRow(page, 'Customer names').locator('.dp-fi-claim');
  await a.ring(findingRow(page, 'Customer names'), 500);
  await a.click(worst, { pause: 900 });
  const accept = page.locator('.dp-fi-actions button', { hasText: /^Accept/ }).first();
  await a.intoView(accept, { x: 900, y: 520 });
  await a.ring(accept, 600);
  await a.hover(accept);
  await a.wait(500);
  await a.caption('', '');
  await a.reveal(page.locator('.dp-fi-thread').first(), 'center');
  await a.wait(1200);

  await a.wipe(true);
  await page.setContent(OUTRO_CARD);
  await a.wait(3000);

  const raw = await page.video().path();
  await ctx.close();
  const webm = path.join(OUT, 'demo.raw.webm');
  fs.renameSync(raw, webm);
  fs.rmSync(dir, { recursive: true, force: true });
  encode(webm, 0.25);
}

// writes demo.mp4 (H.264, what GitHub plays), demo.webm (VP9), a demo.jpg poster and the README's demo.gif
function encode(raw: string, start: number) {
  const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    console.log('no ffmpeg: kept', raw);
    return;
  }
  const trim = ['-ss', start.toFixed(2)];
  ff([...trim, '-i', raw, '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', path.join(OUT, 'demo.mp4')]);
  ff([...trim, '-i', raw, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40', '-row-mt', '1', '-an', path.join(OUT, 'demo.webm')]);
  ff(['-ss', (start + 17.5).toFixed(2), '-i', raw, '-frames:v', '1', '-q:v', '3', path.join(OUT, 'demo.jpg')]);
  // the GIF is the README's inline hero: 860px, 8 fps, a 192-colour palette from the clip, under 8 MB
  const palette = path.join(OUT, '.palette.png');
  const gif = path.join(OUT, 'demo.gif');
  const scale = 'scale=860:-1:flags=lanczos';
  ff([...trim, '-i', raw, '-vf', `fps=8,${scale},palettegen=max_colors=192:stats_mode=diff`, '-y', palette]);
  ff([...trim, '-i', raw, '-i', palette, '-lavfi', `fps=8,${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`, '-loop', '0', gif]);
  fs.rmSync(palette);
  fs.rmSync(raw);
  const mb = (f: string) => (fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(1);
  console.log(`wrote demo.mp4 (${mb('demo.mp4')} MB), demo.webm (${mb('demo.webm')} MB), demo.jpg, demo.gif (${mb('demo.gif')} MB)`);
}

const browser = await chromium.launch();
try {
  if (MODE === 'shots' || MODE === 'all') await shots(browser);
  if (MODE === 'video' || MODE === 'all') await video(browser);
} finally {
  await browser.close();
}
