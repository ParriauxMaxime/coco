// GitLens-style blame in a review editor: the line under the mouse, else the cursor's, ends with who changed it last, when and why;
// hovering that text shows the commit. The file's blame loads on the first line it would show on.
import type { editor as Ed, IDisposable } from 'monaco-editor/editor/editor.api';
import type { Blame, BlameCommit } from '../../../server/blame.ts';
import type { MonacoApi } from '../types.ts';

const UNITS: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
const ago = (time: number) => {
  const s = Date.now() / 1000 - time;
  const [n, unit] = UNITS.find(([u]) => s >= u) ?? [0, ''];
  if (!n) return 'just now';
  const k = Math.floor(s / n);
  return `${k} ${unit}${k > 1 ? 's' : ''} ago`;
};

const hover = (sha: string, c: BlameCommit, github?: string | null) => [
  `**${c.author}** · ${new Date(c.time * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`,
  c.summary,
  [`\`${sha.slice(0, 8)}\``, c.inPr && 'made in this PR', github && `[Open on GitHub](https://github.com/${github}/commit/${sha})`].filter(Boolean).join(' · '),
].join('\n\n');

export function attachBlame(monaco: MonacoApi, editor: Ed.ICodeEditor, load: () => Promise<Blame>): IDisposable {
  const deco = editor.createDecorationsCollection();
  const { MouseTargetType: T } = monaco.editor;
  const onText = [T.CONTENT_TEXT, T.CONTENT_EMPTY, T.GUTTER_LINE_NUMBERS, T.GUTTER_GLYPH_MARGIN];
  let blame: Blame | null = null;
  let asked = false;
  let hovered = 0;
  const show = () => {
    const line = hovered || (editor.hasTextFocus() ? editor.getPosition()?.lineNumber : 0) || 0;
    const model = editor.getModel();
    const sha = blame?.lines[line - 1];
    const c = sha ? blame?.commits[sha] : undefined;
    if (line && !asked) {
      asked = true;
      load().then((b) => { blame = b; show(); }, () => {});
    }
    if (!model || !sha || !c) return deco.clear();
    const end = model.getLineMaxColumn(line);
    deco.set([{
      range: new monaco.Range(line, end, line, end),
      options: {
        after: { content: `${c.author}, ${ago(c.time)} • ${c.summary}`, inlineClassName: `cc-blame${c.inPr ? ' cc-blame-pr' : ''}` },
        hoverMessage: { value: hover(sha, c, blame?.github) },
      },
    }]);
  };
  const subs = [
    // over a widget, a comment zone or the hover itself, the line shown stays
    editor.onMouseMove((e) => {
      const line = e.target.position?.lineNumber ?? 0;
      if (!onText.includes(e.target.type) || line === hovered) return;
      hovered = line;
      show();
    }),
    editor.onMouseLeave(() => {
      hovered = 0;
      show();
    }),
    editor.onDidChangeCursorPosition(show),
    editor.onDidBlurEditorText(show),
    editor.onDidChangeModel(() => {
      blame = null;
      asked = false;
      deco.clear();
    }),
  ];
  return { dispose: () => { subs.forEach((s) => s.dispose()); deco.clear(); } };
}
