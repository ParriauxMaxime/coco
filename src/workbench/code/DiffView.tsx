import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { MutableRefObject, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { editor } from 'monaco-editor/editor/editor.api';
import { EDITOR_OPTIONS, acquireModel, attachCommentUx, flashLines, releaseModel, revealLine, useCommentLayer, useMonaco } from './editor-shared.ts';
import type { CommentHandlers } from './editor-shared.ts';
import { attachBlame } from './blame.ts';
import type { Blame } from '../../../server/blame.ts';
import type { MonacoApi, ReviewComment, Side } from '../types.ts';
import './code.css';

export type Reveal = { line?: number; side?: string; at?: number; path?: string };
export type DiffHandle = {
  jumpTo(line: number, side?: Side): void;
  flash(startLine: number, endLine: number, side?: Side): (() => void) | undefined;
};
export type DecorationsHandle = DiffHandle & { monaco: MonacoApi; original: editor.ICodeEditor | null; modified: editor.ICodeEditor | null };
type Props = {
  original?: string;
  modified?: string;
  path: string;
  sideBySide?: boolean;
  readOnly?: boolean;
  comments?: ReviewComment[];
  onCreateComment?: CommentHandlers['onCreateComment'];
  onJump?: CommentHandlers['onJump'];
  renderZone?: (comment: ReviewComment) => ReactNode;
  decorationsRef?: MutableRefObject<DecorationsHandle | null>;
  reveal?: Reveal | null;
  options?: editor.IDiffEditorConstructionOptions;
  onEditor?: (diff: editor.IStandaloneDiffEditor | null) => void;
  scope?: string;
  blame?: (side: Side) => Promise<Blame>;
};

// original = base text, modified = head text; comments on side 'base' live in the left editor, 'head' in the right one
// options: extra createDiffEditor options (creation only) · onEditor(diffEditor | null) · blame(side): the side's blame, shown GitLens style
const DiffView = forwardRef<DiffHandle, Props>(function DiffView({ original, modified, path, sideBySide = true, readOnly = true, comments = [], onCreateComment, onJump, renderZone, decorationsRef, reveal = null, options, onEditor, scope, blame }, ref) {
  const { mod, error } = useMonaco();
  const hostRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<editor.IStandaloneDiffEditor | null>(null);
  const handlers = useRef<CommentHandlers & { onEditor?: Props['onEditor'] }>({});
  handlers.current = { onCreateComment, onJump, onEditor };
  const blameRef = useRef(blame);
  blameRef.current = blame;

  useEffect(() => {
    if (!mod || !hostRef.current) return undefined;
    const { monaco } = mod;
    const diff = monaco.editor.createDiffEditor(hostRef.current, {
      ...EDITOR_OPTIONS,
      readOnly,
      originalEditable: false,
      renderSideBySide: sideBySide,
      useInlineViewWhenSpaceIsLimited: false,
      diffAlgorithm: 'advanced',
      ...options,
    });
    const sides: [editor.ICodeEditor, Side][] = [[diff.getOriginalEditor(), 'base'], [diff.getModifiedEditor(), 'head']];
    const detach = sides.flatMap(([ed, side]) => [attachCommentUx(monaco, ed, side, handlers), ...(blameRef.current ? [attachBlame(monaco, ed, () => blameRef.current!(side))] : [])]);
    setEditor(diff);
    handlers.current.onEditor?.(diff);
    return () => {
      handlers.current.onEditor?.(null);
      detach.forEach((d) => d.dispose());
      setEditor(null);
      diff.setModel(null);
      diff.dispose();
    };
  }, [mod]);

  useEffect(() => {
    editor?.updateOptions({ renderSideBySide: sideBySide, readOnly });
  }, [editor, sideBySide, readOnly]);

  useEffect(() => {
    if (!mod || !editor) return undefined;
    const base = acquireModel(mod, 'base', path, original ?? '', scope);
    const head = acquireModel(mod, 'head', path, modified ?? '', scope);
    editor.setModel({ original: base, modified: head });
    return () => {
      try {
        editor.setModel(null);
      } catch {}
      releaseModel(base);
      releaseModel(head);
    };
  }, [mod, editor, path, original, modified, scope]);

  useEffect(() => {
    if (!mod || !editor || !reveal?.line) return undefined;
    const line = reveal.line;
    const target = reveal.side === 'base' ? editor.getOriginalEditor() : editor.getModifiedEditor();
    let undo = revealLine(mod.monaco, target, line);
    const sub = editor.onDidUpdateDiff(() => {
      sub.dispose();
      undo?.();
      undo = revealLine(mod.monaco, target, line);
    });
    return () => {
      sub.dispose();
      undo?.();
    };
  }, [mod, editor, path, original, modified, reveal]);

  const originalEditor = editor ? editor.getOriginalEditor() : null;
  const modifiedEditor = editor ? editor.getModifiedEditor() : null;
  const zones = [...useCommentLayer(mod, originalEditor, 'base', comments), ...useCommentLayer(mod, modifiedEditor, 'head', comments)];

  const api: DiffHandle = {
    jumpTo(line, side = 'head') {
      const target = side === 'base' ? originalEditor : modifiedEditor;
      if (mod && editor && target) revealLine(mod.monaco, target, line);
    },
    flash(startLine, endLine, side = 'head') {
      const target = side === 'base' ? originalEditor : modifiedEditor;
      if (mod && editor && target) return flashLines(mod.monaco, target, startLine, endLine);
      return undefined;
    },
  };
  useImperativeHandle(ref, () => api);
  useEffect(() => {
    if (!decorationsRef) return undefined;
    decorationsRef.current = mod && editor ? { monaco: mod.monaco, original: originalEditor, modified: modifiedEditor, ...api } : null;
    return () => {
      decorationsRef.current = null;
    };
  }, [mod, editor, decorationsRef]);

  const byId = new Map(comments.map((c) => [c.id, c]));
  return (
    <div className={`cc-editor-wrap${!original && modified ? ' cc-diff-new' : ''}`}>
      <div ref={hostRef} className="cc-editor" />
      {!mod && <div className="cc-editor-status">{error ? `Editor failed to load: ${error.message}` : 'Loading editor…'}</div>}
      {renderZone && zones.map((z) => {
        const comment = byId.get(z.id);
        return comment ? createPortal(renderZone(comment), z.node, `${z.side}:${z.id}`) : null;
      })}
    </div>
  );
});

export default DiffView;
