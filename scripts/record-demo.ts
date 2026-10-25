// Records the README media (docs/media) against a demo cocopilot seeded with fictional data, never your own server.
// Usage: node scripts/record-demo.ts [shots|video|all]   (reseed between two runs: the video accepts a finding and ticks gates)
// Env: COCO_URL (default http://127.0.0.1:8790), OUT_DIR (default docs/media), DEMO_SLUG, PLAYWRIGHT_MODULE (path to playwright's index.mjs when not installed here).
// Expects the demo work: rows b:export-api, b:export-ui, b:export-toggle, findings titled "Double click…" and "Customer names…", a thread on the latter.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Point {
  x: number;
  y: number;
}
interface DomElement {
  parentElement: DomElement | null;
  scrollHeight: number;
  clientHeight: number;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
  scrollBy(opts: { top: number; behavior: string }): void;
  scrollIntoView(opts: { block: string }): void;
}
interface LocatorOptions {
  hasText?: string | RegExp;
  has?: Locator;
}
interface Locator {
  boundingBox(): Promise<Box | null>;
  evaluate<A = undefined>(fn: (el: DomElement, arg: A) => unknown, arg?: A): Promise<unknown>;
  waitFor(opts?: { state?: string; timeout?: number }): Promise<void>;
  click(): Promise<void>;
  count(): Promise<number>;
  first(): Locator;
  last(): Locator;
  locator(selector: string, opts?: LocatorOptions): Locator;
  getByRole(role: string, opts: { name: string | RegExp }): Locator;
}
interface Page {
  waitForTimeout(ms: number): Promise<void>;
  mouse: { move(x: number, y: number, opts?: { steps: number }): Promise<void>; down(): Promise<void>; up(): Promise<void>; wheel(dx: number, dy: number): Promise<void> };
  keyboard: { press(key: string): Promise<void> };
  locator(selector: string, opts?: LocatorOptions): Locator;
  getByText(text: string): Locator;
  getByRole(role: string, opts: { name: string | RegExp }): Locator;
  evaluate<A>(fn: (arg: A) => unknown, arg: A): Promise<unknown>;
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  screenshot(opts: { path: string }): Promise<unknown>;
  video(): { path(): Promise<string> };
}
interface BrowserContext {
  newPage(): Promise<Page>;
  addInitScript(script: string): Promise<void>;
  close(): Promise<void>;
}
interface Browser {
  newContext(opts: Record<string, unknown>): Promise<BrowserContext>;
  close(): Promise<void>;
}

declare const getComputedStyle: (el: DomElement) => { overflowY: string };
declare const location: { hash: string };

const { chromium }: { chromium: { launch(): Promise<Browser> } } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.COCO_URL || 'http://127.0.0.1:8790';
const OUT = path.resolve(process.env.OUT_DIR || path.join(HERE, '../docs/media'));
const SLUG = process.env.DEMO_SLUG || 'invoice-csv-export';
const MODE = process.argv[2] || 'all';
const VIEWPORT = { width: 1440, height: 900 };
fs.mkdirSync(OUT, { recursive: true });

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
  const scroll = async (dy: number, at?: Point) => {
    if (at) await moveTo(at, 14);
    const step = dy > 0 ? 40 : -40;
    for (let done = 0; Math.abs(done) < Math.abs(dy); done += step) {
      await page.mouse.wheel(0, step);
      await wait(14);
    }
    await wait(250);
  };
  const go = (hash: string) => page.evaluate((h: string) => (location.hash = h), hash);
  return { wait, moveTo, reveal, click, scroll, go };
}

const unfoldedChevrons = (page: Page) => page.locator('.fd-spot > .fd-row > .fd-claimcell > .fd-chev', { hasText: '▾' });
const spotByClaim = (page: Page, text: string) => page.locator('.fd-spot > .fd-row', { has: page.locator('.fd-claim', { hasText: text }) });

async function foldAll(page: Page, a: ReturnType<typeof actor>, { animate }: { animate: boolean }) {
  for (let i = 0; i < 12; i++) {
    const chev = unfoldedChevrons(page).first();
    if (!(await chev.count())) break;
    if (animate) await a.click(chev, { pause: 220, steps: 10 });
    else await chev.click();
  }
}

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
  await a.wait(1500);
  await shot('plan.png');

  await page.goto(`${URL}/#/work/${SLUG}/review-b:export-api/max`);
  await page.getByText('Review plan').first().waitFor();
  await page.locator('text=csv-export.ts').first().click();
  await page.locator('text=ready').first().waitFor({ timeout: 30000 }).catch(() => {});
  await a.wait(2500);
  await shot('review.png');

  await page.goto(`${URL}/#/work/${SLUG}/findings`);
  await page.locator('.fd-row').first().waitFor();
  await a.wait(1200);
  await foldAll(page, a, { animate: false });
  await spotByClaim(page, 'Double click').locator('.fd-claim').click();
  await a.wait(800);
  await shot('findings.png');

  await page.reload();
  await page.locator('.thread').first().waitFor();
  await a.wait(1200);
  await page.locator('.thread').first().evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await page.mouse.move(720, 450);
  await page.mouse.wheel(0, 40);
  await shot('thread.png');
  await ctx.close();
}

async function video(browser: Browser) {
  const dir = fs.mkdtempSync(path.join(OUT, '.rec-'));
  const born = Date.now();
  const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light', recordVideo: { dir, size: VIEWPORT } });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  const a = actor(page);

  // dashboard
  await page.goto(`${URL}/#/`);
  await page.getByText('Reviewer personas').waitFor();
  await a.wait(600);
  const start = (Date.now() - born) / 1000;
  await a.moveTo({ x: 700, y: 420 }, 12);
  await a.wait(700);
  await a.click(page.locator('.card', { hasText: 'Export invoices as CSV' }).first(), { pause: 900 });

  // plan, a decision taken beside it, then the PR cards
  await page.getByText('CSV serializer and export endpoint').first().waitFor();
  await a.wait(1600);
  await a.click(page.locator('button', { hasText: /^Decisions$/ }).first(), { pause: 1600 });
  await a.moveTo({ x: 1100, y: 345 }, 16);
  await a.wait(900);
  await a.click(page.getByRole('button', { name: 'Take decision' }).first(), { pause: 1600 });
  await a.scroll(420, { x: 520, y: 520 });
  await a.wait(1200);
  await a.scroll(380);
  await a.wait(1200);

  // review: plan steps, a file with a coco watch point and a finding in the diff
  await a.click(page.getByRole('button', { name: 'review ▸' }).first(), { pause: 1400 });
  await a.click(page.locator('button:has-text("⤢")').last(), { pause: 400 });
  await page.getByText('Review plan').first().waitFor();
  await a.wait(1500);
  await a.click(page.locator('text=csv-export.ts').first(), { pause: 1500 });
  await a.scroll(260, { x: 700, y: 560 });
  await a.wait(2800);
  await a.moveTo({ x: 1250, y: 400 }, 18);
  await a.scroll(300);
  await a.wait(1200);

  // findings board: regroup, fold to the list, accept one, read a thread
  await a.go(`#/work/${SLUG}/findings/max`);
  await page.locator('.fd-row').first().waitFor();
  await a.wait(1600);
  await a.click(page.locator('.rv-seg button', { hasText: 'reviewer' }), { pause: 1400 });
  await a.click(page.locator('.rv-seg button', { hasText: 'spot' }), { pause: 900 });
  await foldAll(page, a, { animate: true });
  await a.moveTo({ x: 1150, y: 300 }, 30);
  await a.wait(1600);
  await a.click(spotByClaim(page, 'Double click').locator('.fd-claim'), { pause: 1000 });
  await a.scroll(260, { x: 820, y: 520 });
  await a.wait(900);
  await a.click(spotByClaim(page, 'Double click').getByRole('button', { name: /✓ Accept/ }), { pause: 1400 });
  await a.click(spotByClaim(page, 'Customer names').locator('.fd-claim'), { pause: 600 });
  await a.reveal(page.locator('.thread').first(), 'center');
  await a.wait(600);
  await a.scroll(320, { x: 820, y: 520 });
  await a.wait(2200);

  // checklist gates on the PR card
  await page.keyboard.press('Escape');
  await a.wait(500);
  await a.click(page.locator('.wb-tab-h', { hasText: /^Plan/ }).first(), { pause: 800 });
  const rail = page.locator('.gate-rail').first();
  await a.reveal(rail, 'center');
  await a.wait(500);
  await a.click(rail.locator('.gate', { hasText: 'fixes picked' }), { pause: 900 });
  await a.click(page.locator('.gate-detail button', { hasText: '✓ done' }).first(), { pause: 1000 });
  await a.click(rail.locator('.gate', { hasText: 'push' }), { pause: 2200 });
  await a.moveTo({ x: 900, y: 300 }, 16);
  await a.wait(800);

  const raw = await page.video().path();
  await ctx.close();
  const webm = path.join(OUT, 'overview.raw.webm');
  fs.renameSync(raw, webm);
  fs.rmSync(dir, { recursive: true, force: true });
  encode(webm, start);
}

// trims the idle start, writes overview.webm (VP9), overview.mp4 (H.264, what GitHub plays) and an overview.jpg poster
function encode(raw: string, start: number) {
  const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    console.log('no ffmpeg: kept', raw);
    return;
  }
  const ss = ['-ss', start.toFixed(2), '-i', raw];
  ff([...ss, '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', path.join(OUT, 'overview.mp4')]);
  ff([...ss, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40', '-row-mt', '1', '-an', path.join(OUT, 'overview.webm')]);
  ff(['-ss', (start + 3.5).toFixed(2), '-i', raw, '-frames:v', '1', '-q:v', '3', path.join(OUT, 'overview.jpg')]);
  fs.rmSync(raw);
  console.log('wrote overview.mp4, overview.webm, overview.jpg');
}

const browser = await chromium.launch();
try {
  if (MODE === 'shots' || MODE === 'all') await shots(browser);
  if (MODE === 'video' || MODE === 'all') await video(browser);
} finally {
  await browser.close();
}
