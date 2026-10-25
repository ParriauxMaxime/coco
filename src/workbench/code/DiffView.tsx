import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EDITOR_OPTIONS, acquireModel, attachCommentUx, flashLines, releaseModel, revealLine, useCommentLayer, useMonaco } from './editor-shared.ts';
import './code.css';

// original = base text, modified = head text; comments on side 'base' live in the left editor, 'head' in the right one
// options: extra createDiffEditor options (creation only) · onEditor(diffEditor | null)
const DiffView = forwardRef(function DiffView({ original, modified, path, sideBySide = true, readOnly = true, comments = [], onCreateComment, onJump, renderZone, decorationsRef, reveal = null, options, onEditor }, ref) {
  const { mod, error } = useMonaco();
  const hostRef = useRef(null);
  const [editor, setEditor] = useState(null);
  const handlers = useRef({});
  handlers.current = { onCreateComment, onJump, onEditor };

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
    const detach = [attachCommentUx(monaco, diff.getOriginalEditor(), 'base', handlers), attachCommentUx(monaco, diff.getModifiedEditor(), 'head', handlers)];
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
    const base = acquireModel(mod, 'base', path, original ?? '');
    const head = acquireModel(mod, 'head', path, modified ?? '');
    editor.setModel({ original: base, modified: head });
    return () => {
      try {
        editor.setModel(null);
      } catch {}
      releaseModel(base);
      releaseModel(head);
    };
  }, [mod, editor, path, original, modified]);

  useEffect(() => {
    if (!mod || !editor || !reveal?.line) return undefined;
    const target = reveal.side === 'base' ? editor.getOriginalEditor() : editor.getModifiedEditor();
    let undo = revealLine(mod.monaco, target, reveal.line);
    const sub = editor.onDidUpdateDiff(() => {
      sub.dispose();
      undo?.();
      undo = revealLine(mod.monaco, target, reveal.line);
    });
    return () => {
      sub.dispose();
      undo?.();
    };
  }, [mod, editor, path, original, modified, reveal]);

  const originalEditor = editor ? editor.getOriginalEditor() : null;
  const modifiedEditor = editor ? editor.getModifiedEditor() : null;
  const zones = [...useCommentLayer(mod, originalEditor, 'base', comments), ...useCommentLayer(mod, modifiedEditor, 'head', comments)];

  const api = {
    jumpTo(line, side = 'head') {
      if (mod && editor) revealLine(mod.monaco, side === 'base' ? originalEditor : modifiedEditor, line);
    },
    flash(startLine, endLine, side = 'head') {
      if (mod && editor) return flashLines(mod.monaco, side === 'base' ? originalEditor : modifiedEditor, startLine, endLine);
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
    <div className="cc-editor-wrap">
      <div ref={hostRef} className="cc-editor" />
      {!mod && <div className="cc-editor-status">{error ? `Editor failed to load: ${error.message}` : 'Loading editor…'}</div>}
      {renderZone && zones.map((z) => (byId.has(z.id) ? createPortal(renderZone(byId.get(z.id)), z.node, `${z.side}:${z.id}`) : null))}
    </div>
  );
});

export default DiffView;
