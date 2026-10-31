// Records the README media (docs/media) against a demo coco seeded with fictional data, never your own server.
// Usage: node scripts/record-demo.ts [shots|video|all]   (reseed between two runs: the video takes a decision and accepts nothing)
// Env: COCO_URL (default http://127.0.0.1:8793), OUT_DIR (default docs/media), DEMO_SLUG, PLAYWRIGHT_MODULE (path to playwright's index.mjs when not installed here).
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
  fill(v: string): Promise<void>;
  evaluate<T>(fn: (el: DomElement, arg: T) => unknown, arg?: T): Promise<unknown>;
  locator(sel: string, o?: LocatorOptions): Locator;
  getByRole(role: string, o?: { name?: string | RegExp; exact?: boolean }): Locator;
}
interface Page {
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  setContent(html: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: (arg: T) => unknown, arg?: T): Promise<T>;
  keyboard: { press(k: string): Promise<void> };
  mouse: { move(x: number, y: number, o?: { steps?: number }): Promise<void>; down(): Promise<void>; up(): Promise<void>; wheel(dx: number, dy: number): Promise<void> };
  video(): { path(): Promise<string> };
  addInitScript(script: string): Promise<void>;
  locator(sel: string, o?: LocatorOptions): Locator;
  getByText(t: string | RegExp): Locator;
  getByRole(role: string, o?: { name?: string | RegExp }): Locator;
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
const VIEWPORT = { width: 1440, height: 900 };
fs.mkdirSync(OUT, { recursive: true });

// coco's palette, the one docs/media/banner.svg is drawn in
const CREAM = '#f3ecdc';
const INK = '#1c1f29';
const VIOLET = '#7b7bf5';
const AMBER = '#f2b84b';
const MUTED = '#4a4d5c';

const MARK = `<svg width="186" height="171" viewBox="150 190 700 645" aria-hidden="true">
  <path d="M630.7 320.5 A250 250 0 1 0 686.5 637" fill="none" stroke="${VIOLET}" stroke-width="140" stroke-linecap="round"/>
  <path fill="${AMBER}" d="M640 372 C770 360 852 455 842 600 C838 652 816 684 790 692 C794 622 762 574 684 566 C672 500 660 430 640 372 Z"/>
  <circle cx="560" cy="440" r="54" fill="${INK}"/>
</svg>`;

const card = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:${CREAM};color:${INK};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px}
  .name{font-size:132px;font-weight:700;letter-spacing:-5px;line-height:1}
  .line{font-size:52px;font-weight:500;color:${MUTED}}
  .line b{color:${VIOLET}}
  .where{font-size:26px;color:${MUTED};letter-spacing:.2px}
</style></head><body><div class="wrap">${body}</div></body></html>`;

const TITLE_CARD = card(`${MARK}<div class="name">coco</div><div class="line">ADE, but <b>your way.</b></div>`);
const OUTRO_CARD = card(`${MARK}<div class="line">ADE, but <b>your way.</b></div><div class="where">github.com/ParriauxMaxime/coco</div>`);

const CURSOR = `(() => {
  const add = () => {
    if (document.getElementById('__demo_cursor')) return;
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 2.5l13.5 10.2-6.1 1.1-3.3 6.2z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-100px,-100px)', transition: 'transform 0s' });
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => (c.style.transform = 'translate(' + (e.clientX - 5) + 'px,' + (e.clientY - 3) + 'px)'), true);
    addEventListener('mousedown', () => (c.firstChild.style.transform = 'scale(.82)'), true);
    addEventListener('mouseup', () => (c.firstChild.style.transform = ''), true);
    const cap = document.createElement('div');
    cap.id = '__demo_cap';
    cap.innerHTML = '<i></i><span></span>';
    Object.assign(cap.style, { position: 'fixed', left: '50%', bottom: '22px', zIndex: '2147483646', display: 'flex', alignItems: 'center', gap: '10px', maxWidth: '760px', padding: '9px 16px', borderRadius: '10px', background: '${INK}', color: '${CREAM}', font: '600 15px/1.35 -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif', boxShadow: '0 10px 28px rgba(28,31,41,.30)', pointerEvents: 'none', opacity: '0', transform: 'translate(-50%, 10px)', transition: 'opacity .28s ease, transform .28s ease' });
    const dot = cap.firstChild;
    Object.assign(dot.style, { flex: '0 0 8px', width: '8px', height: '8px', borderRadius: '50%', background: '${AMBER}' });
    document.documentElement.appendChild(cap);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})()`;

// the caption bar is part of the page, so it is in the recording: one line per beat, out between them
async function caption(page: Page, text: string) {
  await page.evaluate((t: string) => {
    const cap = document.getElementById('__demo_cap');
    if (!cap) return;
    const span = cap.lastChild as HTMLElement;
    if (t) span.textContent = t;
    cap.style.opacity = t ? '1' : '0';
    cap.style.transform = t ? 'translate(-50%, 0)' : 'translate(-50%, 10px)';
  }, text);
}

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
    await wait(750);
  };
  const click = async (loc: Locator, { pause = 350, steps = 22 }: { pause?: number; steps?: number } = {}) => {
    await loc.waitFor({ state: 'visible', timeout: 15000 });
    const b = await loc.boundingBox();
    if (!b || b.y < 60 || b.y + b.height > VIEWPORT.height - 10) await reveal(loc);
    await moveTo(await center(loc), steps);
    await wait(120);
    await page.mouse.down();
    await page.mouse.up();
    await wait(pause);
  };
  const hover = async (loc: Locator) => {
    await loc.waitFor({ state: 'visible', timeout: 15000 });
    await moveTo(await center(loc), 20);
    await wait(500);
  };
  const scroll = async (dy: number, at?: Point) => {
    if (at) await moveTo(at, 14);
    const step = dy > 0 ? 40 : -40;
    for (let done = 0; Math.abs(done) < Math.abs(dy); done += step) {
      await page.mouse.wheel(0, step);
      await wait(14);
    }
    await wait(250);
  };
  // wheel the pane under `at` until the element sits in view: a detail pane's button is often below the fold
  const intoView = async (loc: Locator, at: Point) => {
    for (let i = 0; i < 8; i++) {
      const b = await loc.boundingBox();
      if (b && b.y > 80 && b.y + b.height < VIEWPORT.height - 80) return;
      await moveTo(at, 6);
      await page.mouse.wheel(0, 260);
      await wait(200);
    }
  };
  const go = (hash: string) => page.evaluate((h: string) => (location.hash = h), hash);
  return { wait, moveTo, reveal, click, hover, scroll, intoView, go };
}

const findingRow = (page: Page, text: string) => page.locator('.dp-fi-row', { has: page.locator('.dp-fi-claim', { hasText: text }) });

// the four README stills, in the demo's own state: plan, review, findings, thread
async function shots(browser: Browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light' });
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
  await shot('plan.png');

  await page.goto(`${URL}/#/work/${SLUG}/review-b:export-api`);
  await page.locator('.rv-card').first().waitFor();
  await a.wait(1200);
  await page.locator('.rv-card-h', { hasText: 'csv-export.ts' }).first().click();
  await a.wait(2200);
  await shot('review.png');

  await page.goto(`${URL}/#/work/${SLUG}/findings`);
  await page.locator('.dp-fi-row').first().waitFor();
  await a.wait(1200);
  await page.locator('.dp-fi-claim', { hasText: 'Customer names' }).first().click();
  await a.wait(1000);
  await shot('findings.png');

  const thread = page.locator('.dp-fi-thread').first();
  await a.reveal(thread, 'end');
  await a.wait(900);
  await shot('thread.png');
  await ctx.close();
}

// one pass, title card to outro card, captions under each beat
async function video(browser: Browser) {
  const dir = fs.mkdtempSync(path.join(OUT, '.rec-'));
  const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light', recordVideo: { dir, size: VIEWPORT } });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  const a = actor(page);

  await page.setContent(TITLE_CARD);
  await a.wait(3000);

  // the work: its stack, its progress, what is next
  await page.goto(`${URL}/#/work/${SLUG}/plan`);
  await page.getByText('CSV serializer and export endpoint').first().waitFor();
  await caption(page, 'One work, its stack, its progress, its next step.');
  await a.wait(1500);
  await a.scroll(320, { x: 520, y: 520 });
  await a.wait(1500);

  // a decision taken beside the plan
  await caption(page, 'Answer the decision that blocks the build.');
  await a.go(`#/work/${SLUG}/decisions`);
  await page.locator('.dp-dc-row').first().waitFor();
  await a.wait(1400);
  await a.click(page.locator('.dp-dc-row').first(), { pause: 1400 });
  await a.click(page.locator('button', { hasText: /^Take decision$/ }).first(), { pause: 700 });

  // review: files in reading order, a watch point and its fix beside the line
  await caption(page, 'Review a PR like an editor: files in reading order, fixes beside the line.');
  await a.go(`#/work/${SLUG}/review-b:export-api`);
  await page.locator('.rv-card').first().waitFor();
  await a.wait(1600);
  await a.click(page.locator('.rv-card-h', { hasText: 'csv-export.ts' }).first(), { pause: 1600 });
  await a.scroll(340, { x: 860, y: 560 });
  await a.wait(1600);
  await a.moveTo({ x: 900, y: 380 }, 20);
  await a.scroll(300);
  await a.wait(1400);

  // findings: the whole PR in one board, the worst one read with its thread
  await caption(page, 'Every remark on a PR in one board, with the agent that answers it.');
  await a.go(`#/work/${SLUG}/findings`);
  await page.locator('.dp-fi-row').first().waitFor();
  await a.wait(1500);
  await a.click(findingRow(page, 'Customer names').locator('.dp-fi-claim'), { pause: 1300 });
  const accept = page.locator('.dp-fi-actions button', { hasText: /^Accept/ }).first();
  await a.intoView(accept, { x: 900, y: 520 });
  await a.hover(accept);
  await a.wait(1400);
  await a.reveal(page.locator('.dp-fi-thread').first(), 'center');
  await a.wait(1600);

  await caption(page, '');
  await page.setContent(OUTRO_CARD);
  await a.wait(3000);

  const raw = await page.video().path();
  await ctx.close();
  const webm = path.join(OUT, 'overview.raw.webm');
  fs.renameSync(raw, webm);
  fs.rmSync(dir, { recursive: true, force: true });
  encode(webm, 0.25);
}

// writes overview.mp4 (H.264, what GitHub plays), overview.webm (VP9), an overview.jpg poster and the README's overview.gif
function encode(raw: string, start: number) {
  const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    console.log('no ffmpeg: kept', raw);
    return;
  }
  const trim = ['-ss', start.toFixed(2)];
  ff([...trim, '-i', raw, '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', path.join(OUT, 'overview.mp4')]);
  ff([...trim, '-i', raw, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40', '-row-mt', '1', '-an', path.join(OUT, 'overview.webm')]);
  ff(['-ss', (start + 11.5).toFixed(2), '-i', raw, '-frames:v', '1', '-q:v', '3', path.join(OUT, 'overview.jpg')]);
  // the GIF is the README's inline hero: 960px, 10 fps, a palette built from the clip, under 8 MB
  const palette = path.join(OUT, '.palette.png');
  const gif = path.join(OUT, 'overview.gif');
  const scale = 'scale=900:-1:flags=lanczos';
  ff([...trim, '-i', raw, '-vf', `fps=9,${scale},palettegen=stats_mode=diff`, '-y', palette]);
  ff([...trim, '-i', raw, '-i', palette, '-lavfi', `fps=9,${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`, '-loop', '0', gif]);
  fs.rmSync(palette);
  fs.rmSync(raw);
  const mb = (f: string) => (fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(1);
  console.log(`wrote overview.mp4 (${mb('overview.mp4')} MB), overview.webm (${mb('overview.webm')} MB), overview.jpg, overview.gif (${mb('overview.gif')} MB)`);
}

const browser = await chromium.launch();
try {
  if (MODE === 'shots' || MODE === 'all') await shots(browser);
  if (MODE === 'video' || MODE === 'all') await video(browser);
} finally {
  await browser.close();
}
