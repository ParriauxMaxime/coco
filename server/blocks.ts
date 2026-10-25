// Typed blocks: the structured body of a finding (and later of other cocopilot documents), rendered by src/components/Blocks.tsx.
// Inline text is a small markup: **bold**, *italic*, `code`, `path/file.ts:12` refs, and <risk|warn|ok|note>…</…> marks.

export const TONES = ['risk', 'warn', 'ok', 'note', 'mute'] as const;
export type Tone = (typeof TONES)[number];
export type Raw = Record<string, any>;
export type Cell = string | { text: string; tone?: Tone };
export type Block = Raw & { type: string };
export type Source = { label: string; path?: string; url?: string };
type Rich = { summary?: string | null; category?: string | null; recommendation?: string | null; sources?: Source[]; blocks?: Block[] | null };
const MAX_BLOCKS = 16;
const MAX_TEXT = 2000;
const MAX_CODE = 4000;
const MAX_ROWS = 40;
const MAX_COLS = 8;
const LANGS = /^[\w+-]{1,20}$/;
const MEDIA_SRC = /^\/api\/works\/[\w-]+\/media\/[\w.-]+$/;
// an https link, or a tab of the app itself (an artifact holding the long evidence)
const SOURCE_URL = /^(https:\/\/|#\/work\/[\w-]+\/[\w.~-]+$)/;

const str = (v: unknown, max: number, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} required`);
  if (v.length > max) throw new Error(`${field} longer than ${max}`);
  return v.trim();
};
const opt = (v: unknown, max: number, field: string) => (v == null || v === '' ? undefined : str(v, max, field));
const line = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`${field} must be a line number`);
  return v;
};
const optLine = (v: unknown, field: string) => (v == null ? undefined : line(v, field));
const isTone = (v: unknown): v is Tone => TONES.some((t) => t === v);
const tone = (v: unknown, field: string): Tone | undefined => {
  if (v == null) return undefined;
  if (!isTone(v)) throw new Error(`${field} must be one of ${TONES.join(', ')}`);
  return v;
};
const strip = (o: Raw): Raw => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const cell = (c: Raw | string | number, at: string): Cell => (typeof c === 'string' || typeof c === 'number' ? String(c).slice(0, 300) : { text: str(String(c?.text ?? ''), 300, `${at}.text`), ...strip({ tone: tone(c?.tone, `${at}.tone`) }) });

const TYPES: Record<string, (b: Raw, at: string) => Raw> = {
  text: (b: Raw, at: string) => ({ text: str(b.text, MAX_TEXT, `${at}.text`) }),
  callout: (b: Raw, at: string) => ({ tone: tone(b.tone, `${at}.tone`) || 'note', title: opt(b.title, 120, `${at}.title`), text: str(b.text, MAX_TEXT, `${at}.text`) }),
  steps: (b: Raw, at: string) => {
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 12) throw new Error(`${at}.items must hold 1-12 steps`);
    return { title: opt(b.title, 120, `${at}.title`), items: b.items.map((s: unknown, i: number) => str(s, 500, `${at}.items[${i}]`)), outcome: opt(b.outcome, 500, `${at}.outcome`) };
  },
  diagram: (b: Raw, at: string) => ({ mermaid: str(b.mermaid, MAX_CODE, `${at}.mermaid`), caption: opt(b.caption, 200, `${at}.caption`) }),
  code: (b: Raw, at: string) => ({ path: opt(b.path, 300, `${at}.path`), line: optLine(b.line, `${at}.line`), lang: b.lang && LANGS.test(b.lang) ? b.lang : undefined, code: str(b.code, MAX_CODE, `${at}.code`), caption: opt(b.caption, 200, `${at}.caption`) }),
  suggestion: (b: Raw, at: string) => {
    const startLine = line(b.startLine, `${at}.startLine`);
    const endLine = line(b.endLine ?? b.startLine, `${at}.endLine`);
    if (endLine < startLine) throw new Error(`${at}.endLine < startLine`);
    if (typeof b.after !== 'string' || b.after.length > MAX_CODE) throw new Error(`${at}.after required, max ${MAX_CODE}`);
    return { path: str(b.path, 300, `${at}.path`), startLine, endLine, lang: b.lang && LANGS.test(b.lang) ? b.lang : undefined, before: typeof b.before === 'string' ? b.before.slice(0, MAX_CODE) : undefined, after: b.after, caption: opt(b.caption, 200, `${at}.caption`) };
  },
  table: (b: Raw, at: string) => {
    if (!Array.isArray(b.columns) || !b.columns.length || b.columns.length > MAX_COLS) throw new Error(`${at}.columns must hold 1-${MAX_COLS} names`);
    if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > MAX_ROWS) throw new Error(`${at}.rows must hold 1-${MAX_ROWS} rows`);
    const columns = b.columns.map((c, i) => str(String(c ?? ''), 60, `${at}.columns[${i}]`));
    const rows = b.rows.map((r, i) => {
      if (!Array.isArray(r) || r.length !== columns.length) throw new Error(`${at}.rows[${i}] must hold ${columns.length} cells`);
      return r.map((c, j) => cell(c, `${at}.rows[${i}][${j}]`));
    });
    return { caption: opt(b.caption, 200, `${at}.caption`), columns, rows };
  },
  media: (b: Raw, at: string) => {
    if (b.kind !== 'image' && b.kind !== 'video') throw new Error(`${at}.kind must be image or video`);
    if (typeof b.src !== 'string' || !MEDIA_SRC.test(b.src)) throw new Error(`${at}.src must be a /api/works/<slug>/media/<file> path (upload it first)`);
    return { kind: b.kind, src: b.src, caption: opt(b.caption, 200, `${at}.caption`) };
  },
};
export const BLOCK_TYPES = Object.keys(TYPES);

// throws on the first bad field, naming it: blocks[2].rows[1] must hold 3 cells
export function validateBlocks(blocks: unknown): Block[] {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > MAX_BLOCKS) throw new Error(`blocks must hold 1-${MAX_BLOCKS} blocks`);
  return blocks.map((b: Raw, i: number): Block => {
    const at = `blocks[${i}]`;
    const make = TYPES[b?.type];
    if (!make) throw new Error(`${at}.type must be one of ${BLOCK_TYPES.join(', ')}`);
    return { type: b.type, ...strip(make(b, at)) };
  });
}

export function validateSources(sources: unknown): Source[] {
  if (!Array.isArray(sources) || sources.length > 8) throw new Error('sources must hold at most 8 entries');
  return sources.map((s: Raw, i: number): Source => ({ label: str(s?.label, 120, `sources[${i}].label`), ...strip({ path: opt(s.path, 300, `sources[${i}].path`), url: s.url && SOURCE_URL.test(s.url) ? String(s.url).slice(0, 500) : undefined }) }));
}

const MAX_SUMMARY = 400;
const MAX_CATEGORY = 80;
const MAX_RECOMMENDATION = 600;
const trimmed = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// the structured fields findings and decision cards share; only the keys present in `input` come back, so a patch leaves the others alone
export function validateRich(input: Raw): Rich {
  const out: Rich = {};
  if ('summary' in input) out.summary = trimmed(input.summary, MAX_SUMMARY);
  if ('category' in input) out.category = trimmed(input.category, MAX_CATEGORY);
  if ('recommendation' in input) out.recommendation = trimmed(input.recommendation, MAX_RECOMMENDATION);
  if ('sources' in input) out.sources = validateSources(input.sources || []);
  if ('blocks' in input) out.blocks = input.blocks == null ? null : validateBlocks(input.blocks);
  return out;
}

// a suggestion's `before` comes from the file at a known sha, never from the writer
export async function readSuggestionBefore(blocks: Block[] | null | undefined, fileLines: (path: string) => Promise<string[] | null | undefined>) {
  for (const b of (blocks || []).filter((x) => x.type === 'suggestion')) {
    const lines = await fileLines(b.path);
    b.before = lines && b.endLine <= lines.length ? lines.slice(b.startLine - 1, b.endLine).join('\n') : undefined;
  }
}

const plain = (text: unknown) => String(text || '').replace(/<\/?(risk|warn|ok|note|mute)>/g, '');
const fence = (lang: string | undefined, code: string) => `\`\`\`${lang || ''}\n${code.replace(/\n$/, '')}\n\`\`\``;

// the markdown twin every other reader of `body` gets: fix agents, threads, briefs, review import
export function blocksToMarkdown({ summary, category, recommendation, blocks = [], sources = [] }: Rich) {
  const out = summary ? [plain(summary)] : [];
  const head = [category && `**Class:** ${category}`, recommendation && `**Recommendation:** ${plain(recommendation)}`].filter(Boolean);
  if (head.length) out.push(head.join(' · '));
  for (const b of blocks ?? []) {
    if (b.type === 'text') out.push(plain(b.text));
    if (b.type === 'callout') out.push(`> **${b.title || b.tone}:** ${plain(b.text)}`);
    if (b.type === 'steps') out.push([b.title && `**${b.title}**`, ...b.items.map((s: string, i: number) => `${i + 1}. ${plain(s)}`), b.outcome && `→ ${plain(b.outcome)}`].filter(Boolean).join('\n'));
    if (b.type === 'diagram') out.push(fence('mermaid', b.mermaid));
    if (b.type === 'code') out.push([b.path && `\`${b.path}${b.line ? `:${b.line}` : ''}\``, fence(b.lang, b.code)].filter(Boolean).join('\n'));
    if (b.type === 'suggestion') out.push(`Suggested change at \`${b.path}:${b.startLine}${b.endLine !== b.startLine ? `-${b.endLine}` : ''}\`:\n${fence(b.lang, b.after)}`);
    if (b.type === 'table') {
      const text = (c: Cell) => plain(typeof c === 'string' ? c : c.text).replace(/\|/g, '\\|');
      out.push([b.caption && `**${b.caption}**`, `| ${b.columns.join(' | ')} |`, `| ${b.columns.map(() => '---').join(' | ')} |`, ...b.rows.map((r: Cell[]) => `| ${r.map(text).join(' | ')} |`)].filter(Boolean).join('\n'));
    }
    if (b.type === 'media') out.push(`![${b.caption || b.kind}](${b.src})`);
  }
  if (sources.length) out.push(`Source: ${sources.map((s) => (s.path ? `${s.label} (\`${s.path}\`)` : s.label)).join(', ')}`);
  return out.join('\n\n');
}
