import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { editor } from 'monaco-editor/editor/editor.api';
import { EDITOR_OPTIONS, acquireModel, attachCommentUx, flashLines, releaseModel, revealLine, useCommentLayer, useMonaco } from './editor-shared.ts';
import type { CommentHandlers } from './editor-shared.ts';
import type { Reveal } from './DiffView.tsx';
import type { ReviewComment } from '../types.ts';
import './code.css';

export type CodeHandle = {
  jumpTo(line: number): void;
  flash(startLine: number, endLine: number): (() => void) | undefined;
};
type Props = {
  text?: string;
  path: string;
  line?: number;
  reveal?: Reveal | null;
  comments?: ReviewComment[];
  onCreateComment?: CommentHandlers['onCreateComment'];
  onJump?: CommentHandlers['onJump'];
  renderZone?: (comment: ReviewComment) => ReactNode;
};

// single editor on the head file (navigation targets outside the PR diff); every comment is side 'head'
const CodeView = forwardRef<CodeHandle, Props>(function CodeView({ text, path, line, reveal = null, comments = [], onCreateComment, onJump, renderZone }, ref) {
  const { mod, error } = useMonaco();
  const hostRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<editor.IStandaloneCodeEditor | null>(null);
  const handlers = useRef<CommentHandlers>({});
  handlers.current = { onCreateComment, onJump };

  useEffect(() => {
    if (!mod || !hostRef.current) return undefined;
    const { monaco } = mod;
    const single = monaco.editor.create(hostRef.current, EDITOR_OPTIONS);
    const detach = attachCommentUx(monaco, single, 'head', handlers);
    setEditor(single);
    return () => {
      detach.dispose();
      setEditor(null);
      single.setModel(null);
      single.dispose();
    };
  }, [mod]);

  useEffect(() => {
    if (!mod || !editor) return undefined;
    const model = acquireModel(mod, 'head', path, text ?? '');
    editor.setModel(model);
    return () => {
      try {
        editor.setModel(null);
      } catch {}
      releaseModel(model);
    };
  }, [mod, editor, path, text]);

  useEffect(() => {
    const target = reveal?.line || line;
    if (!mod || !editor || !target) return undefined;
    return revealLine(mod.monaco, editor, target);
  }, [mod, editor, path, text, line, reveal]);

  useImperativeHandle(ref, () => ({
    jumpTo(target) {
      if (mod && editor) revealLine(mod.monaco, editor, target);
    },
    flash(startLine, endLine) {
      return mod && editor ? flashLines(mod.monaco, editor, startLine, endLine) : undefined;
    },
  }));

  const zones = useCommentLayer(mod, editor, 'head', comments);
  const byId = new Map(comments.map((c) => [c.id, c]));
  return (
    <div className="cc-editor-wrap">
      <div ref={hostRef} className="cc-editor" />
      {!mod && <div className="cc-editor-status">{error ? `Editor failed to load: ${error.message}` : 'Loading editor…'}</div>}
      {renderZone && zones.map((z) => {
        const comment = byId.get(z.id);
        return comment ? createPortal(renderZone(comment), z.node, `${z.side}:${z.id}`) : null;
      })}
    </div>
  );
});

export default CodeView;
