// Typed blocks: the structured body of a finding (and later of other cocopilot documents), rendered by src/components/Blocks.jsx.
// Inline text is a small markup: **bold**, *italic*, `code`, `path/file.ts:12` refs, and <risk|warn|ok|note>…</…> marks.

export const TONES = ['risk', 'warn', 'ok', 'note', 'mute'];
const MAX_BLOCKS = 16;
const MAX_TEXT = 2000;
const MAX_CODE = 4000;
const MAX_ROWS = 40;
const MAX_COLS = 8;
const LANGS = /^[\w+-]{1,20}$/;
const MEDIA_SRC = /^\/api\/works\/[\w-]+\/media\/[\w.-]+$/;

const str = (v, max, field) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} required`);
  if (v.length > max) throw new Error(`${field} longer than ${max}`);
  return v.trim();
};
const opt = (v, max, field) => (v == null || v === '' ? undefined : str(v, max, field));
const line = (v, field) => {
  if (!Number.isInteger(v) || v < 1) throw new Error(`${field} must be a line number`);
  return v;
};
const optLine = (v, field) => (v == null ? undefined : line(v, field));
const tone = (v, field) => {
  if (v == null) return undefined;
  if (!TONES.includes(v)) throw new Error(`${field} must be one of ${TONES.join(', ')}`);
  return v;
};
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const cell = (c, at) => (typeof c === 'string' || typeof c === 'number' ? String(c).slice(0, 300) : strip({ text: str(String(c?.text ?? ''), 300, `${at}.text`), tone: tone(c?.tone, `${at}.tone`) }));

const TYPES = {
  text: (b, at) => ({ text: str(b.text, MAX_TEXT, `${at}.text`) }),
  callout: (b, at) => ({ tone: tone(b.tone, `${at}.tone`) || 'note', title: opt(b.title, 120, `${at}.title`), text: str(b.text, MAX_TEXT, `${at}.text`) }),
  steps: (b, at) => {
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 12) throw new Error(`${at}.items must hold 1-12 steps`);
    return { title: opt(b.title, 120, `${at}.title`), items: b.items.map((s, i) => str(s, 500, `${at}.items[${i}]`)), outcome: opt(b.outcome, 500, `${at}.outcome`) };
  },
  diagram: (b, at) => ({ mermaid: str(b.mermaid, MAX_CODE, `${at}.mermaid`), caption: opt(b.caption, 200, `${at}.caption`) }),
  code: (b, at) => ({ path: opt(b.path, 300, `${at}.path`), line: optLine(b.line, `${at}.line`), lang: b.lang && LANGS.test(b.lang) ? b.lang : undefined, code: str(b.code, MAX_CODE, `${at}.code`), caption: opt(b.caption, 200, `${at}.caption`) }),
  suggestion: (b, at) => {
    const startLine = line(b.startLine, `${at}.startLine`);
    const endLine = line(b.endLine ?? b.startLine, `${at}.endLine`);
    if (endLine < startLine) throw new Error(`${at}.endLine < startLine`);
    if (typeof b.after !== 'string' || b.after.length > MAX_CODE) throw new Error(`${at}.after required, max ${MAX_CODE}`);
    return { path: str(b.path, 300, `${at}.path`), startLine, endLine, lang: b.lang && LANGS.test(b.lang) ? b.lang : undefined, before: typeof b.before === 'string' ? b.before.slice(0, MAX_CODE) : undefined, after: b.after, caption: opt(b.caption, 200, `${at}.caption`) };
  },
  table: (b, at) => {
    if (!Array.isArray(b.columns) || !b.columns.length || b.columns.length > MAX_COLS) throw new Error(`${at}.columns must hold 1-${MAX_COLS} names`);
    if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > MAX_ROWS) throw new Error(`${at}.rows must hold 1-${MAX_ROWS} rows`);
    const columns = b.columns.map((c, i) => str(String(c ?? ''), 60, `${at}.columns[${i}]`));
    const rows = b.rows.map((r, i) => {
      if (!Array.isArray(r) || r.length !== columns.length) throw new Error(`${at}.rows[${i}] must hold ${columns.length} cells`);
      return r.map((c, j) => cell(c, `${at}.rows[${i}][${j}]`));
    });
    return { caption: opt(b.caption, 200, `${at}.caption`), columns, rows };
  },
  media: (b, at) => {
    if (b.kind !== 'image' && b.kind !== 'video') throw new Error(`${at}.kind must be image or video`);
    if (typeof b.src !== 'string' || !MEDIA_SRC.test(b.src)) throw new Error(`${at}.src must be a /api/works/<slug>/media/<file> path (upload it first)`);
    return { kind: b.kind, src: b.src, caption: opt(b.caption, 200, `${at}.caption`) };
  },
};
export const BLOCK_TYPES = Object.keys(TYPES);

// throws on the first bad field, naming it: blocks[2].rows[1] must hold 3 cells
export function validateBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > MAX_BLOCKS) throw new Error(`blocks must hold 1-${MAX_BLOCKS} blocks`);
  return blocks.map((b, i) => {
    const at = `blocks[${i}]`;
    const make = TYPES[b?.type];
    if (!make) throw new Error(`${at}.type must be one of ${BLOCK_TYPES.join(', ')}`);
    return strip({ type: b.type, ...make(b, at) });
  });
}

export function validateSources(sources) {
  if (!Array.isArray(sources) || sources.length > 8) throw new Error('sources must hold at most 8 entries');
  return sources.map((s, i) => strip({ label: str(s?.label, 120, `sources[${i}].label`), path: opt(s.path, 300, `sources[${i}].path`), url: s.url && /^https:\/\//.test(s.url) ? String(s.url).slice(0, 500) : undefined }));
}

const plain = (text) => String(text || '').replace(/<\/?(risk|warn|ok|note|mute)>/g, '');
const fence = (lang, code) => `\`\`\`${lang || ''}\n${code.replace(/\n$/, '')}\n\`\`\``;

// the markdown twin every other reader of `body` gets: fix agents, threads, briefs, review import
export function blocksToMarkdown({ summary, category, recommendation, blocks = [], sources = [] }) {
  const out = summary ? [plain(summary)] : [];
  const head = [category && `**Class:** ${category}`, recommendation && `**Recommendation:** ${plain(recommendation)}`].filter(Boolean);
  if (head.length) out.push(head.join(' · '));
  for (const b of blocks) {
    if (b.type === 'text') out.push(plain(b.text));
    if (b.type === 'callout') out.push(`> **${b.title || b.tone}:** ${plain(b.text)}`);
    if (b.type === 'steps') out.push([b.title && `**${b.title}**`, ...b.items.map((s, i) => `${i + 1}. ${plain(s)}`), b.outcome && `→ ${plain(b.outcome)}`].filter(Boolean).join('\n'));
    if (b.type === 'diagram') out.push(fence('mermaid', b.mermaid));
    if (b.type === 'code') out.push([b.path && `\`${b.path}${b.line ? `:${b.line}` : ''}\``, fence(b.lang, b.code)].filter(Boolean).join('\n'));
    if (b.type === 'suggestion') out.push(`Suggested change at \`${b.path}:${b.startLine}${b.endLine !== b.startLine ? `-${b.endLine}` : ''}\`:\n${fence(b.lang, b.after)}`);
    if (b.type === 'table') {
      const text = (c) => plain(typeof c === 'string' ? c : c.text).replace(/\|/g, '\\|');
      out.push([b.caption && `**${b.caption}**`, `| ${b.columns.join(' | ')} |`, `| ${b.columns.map(() => '---').join(' | ')} |`, ...b.rows.map((r) => `| ${r.map(text).join(' | ')} |`)].filter(Boolean).join('\n'));
    }
    if (b.type === 'media') out.push(`![${b.caption || b.kind}](${b.src})`);
  }
  if (sources.length) out.push(`Source: ${sources.map((s) => (s.path ? `${s.label} (\`${s.path}\`)` : s.label)).join(', ')}`);
  return out.join('\n\n');
}
