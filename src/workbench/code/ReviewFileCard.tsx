import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { PathLabel, useTexts, sha256 } from '../tabs/Code.tsx';
import { SevChip, fileCommentProps, lineSpan } from './CommentZone.tsx';
import DiffView from './DiffView.tsx';
import { useMonaco } from './editor-shared.ts';
import { attachFolds } from './folds.ts';
import LiteDiff from './LiteDiff.tsx';
import Icon from '../../preview/Icon.tsx';
import { prUrl, useConfig } from '../../config.ts';
import type { editor } from 'monaco-editor/editor/editor.api';
import type { Reveal } from './DiffView.tsx';
import type { ReviewHandle } from './use-comments.ts';
import type { FileCategory, FileGroup, PrKey, Proposal, RefFile, ReviewComment } from '../types.ts';
import './code.css';

const LINE_PX = 19;
const SCROLLBAR_PX = 20;
const STATUS: Record<string, string> = { added: 'dp-ok', removed: 'dp-bad', renamed: 'dp-tone dp-st-merged' };
// The card takes the diff's full height, so the editor never scrolls vertically and the wheel scrolls the page.
const CARD_OPTIONS: editor.IDiffEditorConstructionOptions = {
  scrollbar: { vertical: 'hidden', verticalScrollbarSize: 0, alwaysConsumeMouseWheel: false },
  stickyScroll: { enabled: false },
  fixedOverflowWidgets: true,
  renderOverviewRuler: false,
};

export const estimateHeight = (f: RefFile) => (f.additions + f.deletions + 6) * LINE_PX;

function Placeholder({ file, height, label = '' }: { file: RefFile; height?: number; label?: string }) {
  return <div className="rv-ph" style={{ height: height || estimateHeight(file) }}>{label}</div>;
}

type DesktopDiffProps = {
  n: PrKey;
  rv: ReviewHandle;
  file: RefFile;
  reveal: Reveal | null;
  sbs: boolean;
  knownHeight?: number;
  onReveal: (y: number, center: boolean) => void;
  onHeight: (height: number) => void;
};

// onReveal(y, center): y in px from the card top, center = scroll so y sits mid-viewport · onHeight(h): measured diff height
function DesktopDiff({ n, rv, file, reveal, sbs, knownHeight, onReveal, onHeight }: DesktopDiffProps) {
  const path = file.filename;
  const texts = useTexts(n, rv.refs, path, file, 'diff', true);
  const { mod } = useMonaco();
  const [diff, setDiff] = useState<editor.IStandaloneDiffEditor | null>(null);
  const [contentH, setContentH] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const revealed = useRef<number | undefined>(undefined);
  const { mine, onCreate, zone } = fileCommentProps(rv, path, file);
  const mineRef = useRef(mine);
  mineRef.current = mine;
  const folds = useRef<ReturnType<typeof attachFolds> | null>(null);
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

  // before the diff is computed, folds are not applied yet and the line sits at its unfolded height
  useEffect(() => {
    if (!reveal?.line || !diff || !contentH || !diff.getLineChanges() || revealed.current === reveal.at) return;
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

function PhoneDiff({ n, rv, file }: { n: PrKey; rv: ReviewHandle; file: RefFile }) {
  const texts = useTexts(n, rv.refs, file.filename, file, 'diff', false);
  const { mine, onCreate, zone } = fileCommentProps(rv, file.filename, file);
  if (texts.loading) return <Placeholder file={file} label="Loading…" />;
  if (texts.error) return <div className="rv-note">{texts.error}</div>;
  return <LiteDiff unified={texts.unified} comments={mine} onCreateComment={onCreate} renderZone={zone} />;
}

// cardRef(path, el) registers the card for windowed mount and scroll tracking · knownHeight keeps an unmounted card at its last measured height
type CardProps = {
  n: PrKey;
  rv: ReviewHandle;
  file: RefFile;
  open: boolean;
  mounted: boolean;
  knownHeight?: number;
  reveal: Reveal | null;
  sbs: boolean;
  desktop: boolean;
  category?: FileCategory;
  note?: string;
  watch?: Proposal[];
  fresh: boolean;
  reviewed: boolean;
  cardRef: (path: string, el: HTMLElement | null) => void;
  onToggle: (path: string) => void;
  onTick: ((path: string, on: boolean) => void) | null;
  onOpenTab: (path: string) => void;
  onReveal: (path: string, y: number, center: boolean) => void;
  onHeight: (path: string, height: number) => void;
  onJump: (c: ReviewComment) => void;
};

function ReviewFileCard({ n, rv, file, open, mounted, knownHeight, reveal, sbs, desktop, category, note, watch, fresh, reviewed, cardRef, onToggle, onTick, onOpenTab, onReveal, onHeight, onJump }: CardProps) {
  const path = file.filename;
  const [anchor, setAnchor] = useState('');
  const github = useConfig((s) => s.repo.github);
  const ref = useCallback((el: HTMLElement | null) => cardRef(path, el), [cardRef, path]);
  useEffect(() => { sha256(path).then(setAnchor); }, [path]);
  const revealHere = useCallback((y: number, center: boolean) => onReveal(path, y, center), [onReveal, path]);
  const heightHere = useCallback((h: number) => onHeight(path, h), [onHeight, path]);

  let body = null;
  if (open && file.status === 'removed') body = <div className="rv-note">File deleted, {file.deletions} lines.</div>;
  else if (open && !mounted) body = <Placeholder file={file} height={desktop ? knownHeight : 0} />;
  else if (open && desktop) body = <DesktopDiff n={n} rv={rv} file={file} reveal={reveal} sbs={sbs} knownHeight={knownHeight} onReveal={revealHere} onHeight={heightHere} />;
  else if (open) body = <div className="rv-lite"><PhoneDiff n={n} rv={rv} file={file} /></div>;

  return (
    <section className={`rv-card${open ? '' : ' shut'}${reviewed ? ' done' : ''}`} ref={ref} data-path={path}>
      <header className="rv-card-h">
        <button type="button" className={`dp-caret${open ? ' dp-open' : ''}`} aria-label={open ? 'Collapse file' : 'Expand file'} onClick={() => onToggle(path)}><Icon name="chevron-right" size={12} /></button>
        <span className="rv-path" title={file.previous ? `${file.previous} → ${path}` : path} onClick={() => onToggle(path)}>
          {file.previous && <span className="rv-prev">{file.previous} → </span>}
          <PathLabel path={path} />
        </span>
        {STATUS[file.status] && <span className={`dp-chip ${STATUS[file.status]}`}>{file.status}</span>}
        {fresh && <span className="dp-chip dp-warn" title="pushed after coco planned, placed by folder">new</span>}
        {category && <span className={`dp-chip dp-tone rv-cat-${category.category}`} title={category.reason}>{category.category}</span>}
        <span className="rv-stat"><span className="dp-add">+{file.additions}</span> <span className="dp-del">−{file.deletions}</span></span>
        <span className="dp-sp" />
        {onTick && (
          <label className={`rv-tick${reviewed ? ' dp-on' : ''}`} title="Mark the file reviewed (folds it)">
            <input className="dp-vh" type="checkbox" checked={reviewed} onChange={(e) => onTick(path, e.target.checked)} />
            <span className="dp-check" />
            <span className="rv-tick-l">Reviewed</span>
          </label>
        )}
        {github && <a className="dp-ibtn" href={prUrl(github, n, anchor) ?? undefined} target="_blank" rel="noreferrer" title="Open on GitHub"><Icon name="external-link" size={14} /></a>}
        <button type="button" className="dp-btn dp-sm dp-ghost rv-opentab" title="Open in a tab in the other group" onClick={() => onOpenTab(path)}><Icon name="file" size={12} /><span>Open in tab</span></button>
      </header>
      {note && <div className="rv-focus" title={open ? undefined : note}><span className="dp-bot"><Icon name="bot" size={12} /></span><span>{note}</span></div>}
      {watch && watch.length > 0 && (
        <div className="rv-card-wps">
          {watch.map((wp) => (
            <button key={wp.id} type="button" className="rv-card-wp" title={`${wp.body}\n\njump to the line`} onClick={() => onJump(wp)}>
              <span className="rv-lines">{lineSpan(wp)}</span>
              <SevChip value={wp.severity} />
              <span className="rv-card-wp-t">{wp.body.split('\n')[0]}</span>
            </button>
          ))}
        </div>
      )}
      {body}
    </section>
  );
}

export default memo(ReviewFileCard);

// a plan step above its cards in the diff column: title, why, progress; a click folds its cards
export function StepHeader({ group, done, watch, folded, onFold }: { group: FileGroup; done: number; watch: number; folded: boolean; onFold: (key: string) => void }) {
  return (
    <header className="rv-step" onClick={() => onFold(group.key)}>
      <div className="rv-step-h">
        <span className={`dp-caret${folded ? '' : ' dp-open'}`}><Icon name="chevron-right" size={12} /></span>
        <b>{group.title}</b>
        {watch > 0 && <span className="dp-chip dp-tone dp-st-merged" title="coco watch points">{watch} watch</span>}
        <span className={`fl-progress${done === group.files.length ? ' all' : ''}`}>{done}/{group.files.length}</span>
      </div>
      {group.why && <div className="rv-step-why">{group.why}</div>}
    </header>
  );
}
