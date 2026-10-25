import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EDITOR_OPTIONS, acquireModel, attachCommentUx, flashLines, releaseModel, revealLine, useCommentLayer, useMonaco } from './editor-shared.ts';
import './code.css';

// single editor on the head file (navigation targets outside the PR diff); every comment is side 'head'
const CodeView = forwardRef(function CodeView({ text, path, line, reveal = null, comments = [], onCreateComment, onJump, renderZone }, ref) {
  const { mod, error } = useMonaco();
  const hostRef = useRef(null);
  const [editor, setEditor] = useState(null);
  const handlers = useRef({});
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
      {renderZone && zones.map((z) => (byId.has(z.id) ? createPortal(renderZone(byId.get(z.id)), z.node, `${z.side}:${z.id}`) : null))}
    </div>
  );
});

export default CodeView;
