import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTexts, sha256 } from '../tabs/Code.jsx';
import { fileCommentProps } from './CommentZone.jsx';
import DiffView from './DiffView.jsx';
import { useMonaco } from './editor-shared.js';
import { attachFolds } from './folds.js';
import LiteDiff from './LiteDiff.jsx';
import { CAT_CHIP } from './review-order.js';
import { prUrl, useConfig } from '../../config.js';
import './code.css';

const LINE_PX = 19;
const SCROLLBAR_PX = 20;
const STATUS = { added: 'c-green', removed: 'c-red', renamed: 'c-purple' };
// The card takes the diff's full height, so the editor never scrolls vertically and the wheel scrolls the page.
const CARD_OPTIONS = {
  scrollbar: { vertical: 'hidden', verticalScrollbarSize: 0, alwaysConsumeMouseWheel: false },
  stickyScroll: { enabled: false },
  fixedOverflowWidgets: true,
  renderOverviewRuler: false,
};

export const estimateHeight = (f) => (f.additions + f.deletions + 6) * LINE_PX;

function Placeholder({ file, height, label = '' }) {
  return <div className="rv-ph" style={{ height: height || estimateHeight(file) }}>{label}</div>;
}

// onReveal(y, center): y in px from the card top, center = scroll so y sits mid-viewport · onHeight(h): measured diff height
function DesktopDiff({ n, rv, file, reveal, sbs, knownHeight, onReveal, onHeight }) {
  const path = file.filename;
  const texts = useTexts(n, rv.refs, path, file, 'diff', true);
  const { mod } = useMonaco();
  const [diff, setDiff] = useState(null);
  const [contentH, setContentH] = useState(0);
  const hostRef = useRef(null);
  const revealed = useRef(null);
  const { mine, onCreate, zone } = fileCommentProps(rv, path, file);
  const mineRef = useRef(mine);
  mineRef.current = mine;
  const folds = useRef(null);
  const commented = mine.map((c) => `${c.side}:${c.startLine}:${c.endLine}`).join('|');
  // Declared before the folds: cleanups run in order, so an unmount stops measuring before the folds unhide every line.
  useEffect(() => {
    if (!diff) return undefined;
    const sides = [diff.getOriginalEditor(), diff.getModifiedEditor()];
    const measure = () => {
      if (!diff.getModel()) return;
      const h = Math.max(...sides.map((e) => e.getContentHeight())) + SCROLLBAR_PX;
      setContentH(h);
      onHeight(h);
    };
    const subs = [diff.onDidUpdateDiff(measure), ...sides.map((e) => e.onDidContentSizeChange(measure))];
    measure();
    return () => subs.forEach((s) => s.dispose());
  }, [diff]);
  useEffect(() => {
    if (!diff || !mod) return undefined;
    const f = attachFolds(mod.monaco, diff);
    f.setComments(mineRef.current);
    folds.current = f;
    return () => {
      folds.current = null;
      f.dispose();
    };
  }, [diff, mod]);
  useEffect(() => {
    folds.current?.setComments(mineRef.current);
  }, [commented]);

  useEffect(() => {
    if (!reveal?.line || !diff || !contentH || revealed.current === reveal.at) return;
    revealed.current = reveal.at;
    const side = reveal.side === 'base' && sbs ? diff.getOriginalEditor() : diff.getModifiedEditor();
    onReveal((hostRef.current?.offsetTop || 0) + side.getTopForLineNumber(reveal.line), true);
  }, [reveal, diff, contentH, sbs]);

  if (texts.loading) return <Placeholder file={file} height={knownHeight} label="Loading…" />;
  if (texts.error) return <div className="rv-note">{texts.error}</div>;
  if (texts.binary || texts.tooLarge) return <div className="rv-note">{texts.binary ? 'Binary file.' : 'File too large to show.'}</div>;
  return (
    <div className="rv-diff" ref={hostRef} style={{ height: contentH || knownHeight || estimateHeight(file) }}>
      <DiffView original={texts.original} modified={texts.modified} path={path} sideBySide={sbs} comments={mine} onCreateComment={onCreate} renderZone={zone} reveal={reveal} options={CARD_OPTIONS} onEditor={setDiff} />
    </div>
  );
}

function PhoneDiff({ n, rv, file }) {
  const texts = useTexts(n, rv.refs, file.filename, file, 'diff', false);
  const { mine, onCreate, zone } = fileCommentProps(rv, file.filename, file);
  if (texts.loading) return <Placeholder file={file} label="Loading…" />;
  if (texts.error) return <div className="rv-note">{texts.error}</div>;
  return <LiteDiff unified={texts.unified} comments={mine} onCreateComment={onCreate} renderZone={zone} />;
}

function PathLabel({ path }) {
  const cut = path.lastIndexOf('/') + 1;
  return <>{path.slice(0, cut)}<b>{path.slice(cut)}</b></>;
}

// cardRef(path, el) registers the card for windowed mount and scroll tracking · knownHeight keeps an unmounted card at its last measured height
function ReviewFileCard({ n, rv, file, open, mounted, knownHeight, reveal, sbs, desktop, category, note, reviewed, cardRef, onToggle, onTick, onOpenTab, onReveal, onHeight }) {
  const path = file.filename;
  const [anchor, setAnchor] = useState('');
  const github = useConfig((s) => s.repo.github);
  const ref = useCallback((el) => cardRef(path, el), [cardRef, path]);
  useEffect(() => { sha256(path).then(setAnchor); }, [path]);
  const revealHere = useCallback((y, center) => onReveal(path, y, center), [onReveal, path]);
  const heightHere = useCallback((h) => onHeight(path, h), [onHeight, path]);

  let body = null;
  if (open && file.status === 'removed') body = <div className="rv-note">File deleted, {file.deletions} lines.</div>;
  else if (open && !mounted) body = <Placeholder file={file} height={desktop ? knownHeight : 0} />;
  else if (open && desktop) body = <DesktopDiff n={n} rv={rv} file={file} reveal={reveal} sbs={sbs} knownHeight={knownHeight} onReveal={revealHere} onHeight={heightHere} />;
  else if (open) body = <div className="rv-lite"><PhoneDiff n={n} rv={rv} file={file} /></div>;

  return (
    <section className={`rv-card ${open ? '' : 'shut'}`} ref={ref} data-path={path}>
      <header className="rv-card-h">
        <button type="button" className="rv-caret" aria-label={open ? 'Collapse file' : 'Expand file'} onClick={() => onToggle(path)}>{open ? '▾' : '▸'}</button>
        <span className="rv-path" title={file.previous ? `${file.previous} → ${path}` : path} onClick={() => onToggle(path)}>
          {file.previous && <span className="rv-prev">{file.previous} → </span>}
          <PathLabel path={path} />
        </span>
        {STATUS[file.status] && <span className={`chip ${STATUS[file.status]}`}>{file.status}</span>}
        {category && <span className={`chip ${CAT_CHIP[category.category]}`} title={category.reason}>{category.category}</span>}
        <span className="ct-stat"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></span>
        <span className="cc-spacer" />
        {onTick && <label className="rv-tick"><input type="checkbox" checked={reviewed} onChange={(e) => onTick(path, e.target.checked)} /> reviewed</label>}
        {github && <a className="wb-act" href={prUrl(github, n, anchor)} target="_blank" rel="noreferrer" title="Open on GitHub">↗</a>}
        <button type="button" className="wb-act" title="Open in a tab in the other group" onClick={() => onOpenTab(path)}>open in tab</button>
      </header>
      {open && note && <div className="rv-focus"><b>coco</b> {note}</div>}
      {body}
    </section>
  );
}

export default memo(ReviewFileCard);
