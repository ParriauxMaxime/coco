import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { editor } from 'monaco-editor/editor/editor.api';
import { useWork } from '../use-work.ts';
import { commitApi, isDesktop } from '../code/code-api.ts';
import { parseCommitTab } from '../code/ids.ts';
import { CommentBox, lineSpan } from '../code/CommentZone.tsx';
import DiffView from '../code/DiffView.tsx';
import LiteDiff from '../code/LiteDiff.tsx';
import { estimateHeight } from '../code/ReviewFileCard.tsx';
import { useMonaco } from '../code/editor-shared.ts';
import { attachFolds } from '../code/folds.ts';
import { PathLabel, useLocal } from './Code.tsx';
import Markdown from '../../components/Markdown.tsx';
import { SuggestionActions, SuggestionState, isOpenSuggestion, openCommitTab, postToThread, refreshThreads } from '../../components/Thread.tsx';
import { useAction } from '../../components/action.ts';
import { toast } from '../../components/Toast.tsx';
import { Composer } from '../../preview/chat/Composer.tsx';
import Icon from '../../preview/Icon.tsx';
import { api, errorMessage } from '../../api.ts';
import { subscribe, topic } from '../../live.ts';
import type { Thread as ThreadData } from '../../types.ts';
import type { LineRange, RefFile, Refs, ReviewComment, Side } from '../types.ts';
import '../code/code.css';

const SCROLLBAR_PX = 20;
const CARD_OPTIONS: editor.IDiffEditorConstructionOptions = {
  scrollbar: { vertical: 'hidden', verticalScrollbarSize: 0, alwaysConsumeMouseWheel: false },
  stickyScroll: { enabled: false },
  fixedOverflowWidgets: true,
  renderOverviewRuler: false,
};
const STATUS: Record<string, string> = { added: 'dp-ok', removed: 'dp-bad', renamed: 'dp-tone dp-st-merged' };

// line comments on a suggested commit, by `slug:sha`, until they are sent to the agent; kept across tab switches
const useNotes = create<Record<string, ReviewComment[]>>(() => ({}));
const NO_NOTES: ReviewComment[] = [];
const editNotes = (key: string, fn: (notes: ReviewComment[]) => ReviewComment[]) => useNotes.setState((s) => ({ [key]: fn(s[key] ?? NO_NOTES) }));

const indent = (text: string) => text.trim().split('\n').join('\n  ');
const reviewMessage =(sha: string, notes: ReviewComment[], note: string) => [
  `Review of your commit \`${sha.slice(0, 7)}\`${notes.length ? ', line comments:' : ':'}`,
  ...notes.map((c) => `- \`${c.path}\` ${c.side === 'base' ? 'before the change, ' : ''}${lineSpan(c)}: ${indent(c.body)}`),
  ...(note ? ['', note] : []),
].join('\n');

type Texts = { loading?: boolean; error?: string; original?: string; modified?: string; unified?: string; binary?: boolean; tooLarge?: boolean };
function useCommitTexts(sha: string, file: RefFile, desktop: boolean) {
  const [texts, setTexts] = useState<Texts>({ loading: true });
  useEffect(() => {
    let live = true;
    const blank = Promise.resolve({ text: '' });
    const job: Promise<Texts> = desktop
      ? Promise.all([file.status === 'added' ? blank : commitApi.file(sha, 'base', file.previous || file.filename), file.status === 'removed' ? blank : commitApi.file(sha, 'head', file.filename)])
        .then(([b, h]) => ({ original: b.text, modified: h.text, binary: b.binary || h.binary, tooLarge: b.tooLarge || h.tooLarge }))
      : commitApi.diff(sha, file.filename, file.previous).then((d) => ({ unified: d.unified }));
    job.then((t) => live && setTexts(t), (e: Error) => live && setTexts({ error: e.message }));
    return () => { live = false; };
  }, [sha, file.filename, desktop]);
  return texts;
}

type NoteProps = { note: ReviewComment; onSave: (body: string) => void; onDelete: () => void };
function NoteZone({ note, onSave, onDelete }: NoteProps) {
  const [editing, setEditing] = useState(false);
  const lines = <span className="cc-lines">{note.side === 'base' ? 'base · ' : ''}{lineSpan(note)}</span>;
  if (note.draft || editing) {
    return (
      <div className="cc-zone dp-card-q cc-draft">
        <div className="dp-cq-h cc-head"><span className="dp-chip dp-acc">{note.draft ? 'new comment' : 'edit'}</span>{lines}</div>
        <CommentBox initial={note.body} submitLabel={note.draft ? 'Add comment' : 'Save'} onSubmit={(body) => { setEditing(false); onSave(body); }} onCancel={() => (note.draft ? onDelete() : setEditing(false))} />
      </div>
    );
  }
  const sent = note.status === 'sent';
  return (
    <div className={`cc-zone dp-card-q cc-st-${sent ? 'sent' : 'open'}`}>
      <div className="dp-cq-h cc-head">
        <span className={`dp-chip ${sent ? 'dp-info' : 'dp-warn'}`}>{sent ? 'sent to the agent' : 'not sent yet'}</span>
        <span className="dp-sp" />
        {lines}
      </div>
      <div className="cc-body">
        <Markdown text={note.body} />
        {!sent && (
          <div className="cc-pa">
            <button type="button" className="dp-ibtn cc-ib" title="Edit the comment" onClick={() => setEditing(true)}><Icon name="pencil" size={14} /></button>
            <span className="dp-sp" />
            <button type="button" className="dp-ibtn cc-ib no" title="Delete" onClick={onDelete}><Icon name="trash" size={14} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

type FileProps = { sha: string; file: RefFile; notes: ReviewComment[]; desktop: boolean; sbs: boolean; onCreate: (range: LineRange & { side: Side }) => void; zone: (c: ReviewComment) => React.ReactNode };
function CommitFile({ sha, file, notes, desktop, sbs, onCreate, zone }: FileProps) {
  const texts = useCommitTexts(sha, file, desktop);
  const { mod } = useMonaco();
  const [diff, setDiff] = useState<editor.IStandaloneDiffEditor | null>(null);
  const [height, setHeight] = useState(0);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!diff) return undefined;
    const sides = [diff.getOriginalEditor(), diff.getModifiedEditor()];
    const measure = () => diff.getModel() && setHeight(Math.max(...sides.map((e) => e.getContentHeight())) + SCROLLBAR_PX);
    const subs = [diff.onDidUpdateDiff(measure), ...sides.map((e) => e.onDidContentSizeChange(measure))];
    measure();
    return () => subs.forEach((s) => s.dispose());
  }, [diff]);
  const folds = useRef<ReturnType<typeof attachFolds> | null>(null);
  useEffect(() => {
    if (!diff || !mod) return undefined;
    const f = attachFolds(mod.monaco, diff);
    folds.current = f;
    return () => {
      folds.current = null;
      f.dispose();
    };
  }, [diff, mod]);
  useEffect(() => {
    folds.current?.setComments(notes);
  }, [notes, diff, mod]);

  const body = () => {
    if (texts.loading) return <div className="rv-note">Loading…</div>;
    if (texts.error) return <div className="rv-note">{texts.error}</div>;
    if (texts.binary || texts.tooLarge) return <div className="rv-note">{texts.binary ? 'Binary file.' : 'File too large to show.'}</div>;
    if (!desktop) return <div className="rv-lite"><LiteDiff unified={texts.unified} comments={notes} onCreateComment={onCreate} renderZone={zone} /></div>;
    return (
      <div className="rv-diff" style={{ height: height || estimateHeight(file) }}>
        <DiffView scope={sha.slice(0, 12)} original={texts.original} modified={texts.modified} path={file.filename} sideBySide={sbs} comments={notes} onCreateComment={onCreate} renderZone={zone} options={CARD_OPTIONS} onEditor={setDiff} />
      </div>
    );
  };

  return (
    <section className={`rv-card${open ? '' : ' shut'}`}>
      <header className="rv-card-h">
        <button type="button" className={`dp-caret${open ? ' dp-open' : ''}`} aria-label={open ? 'Collapse file' : 'Expand file'} onClick={() => setOpen(!open)}><Icon name="chevron-right" size={12} /></button>
        <span className="rv-path" title={file.previous ? `${file.previous} → ${file.filename}` : file.filename} onClick={() => setOpen(!open)}>
          {file.previous && <span className="rv-prev">{file.previous} → </span>}
          <PathLabel path={file.filename} />
        </span>
        {STATUS[file.status] && <span className={`dp-chip ${STATUS[file.status]}`}>{file.status}</span>}
        <span className="rv-stat"><span className="dp-add">+{file.additions}</span> <span className="dp-del">−{file.deletions}</span></span>
        <span className="dp-sp" />
        {notes.length > 0 && <span className="dp-chip">{notes.length} comment{notes.length > 1 ? 's' : ''}</span>}
      </header>
      {open && body()}
    </section>
  );
}

// an agent's suggested commit read file by file: line comments are gathered, then sent together to the thread's agent; approve, dismiss or verify from the header
export default function CommitTab({ tabId }: { tabId: string }) {
  const { slug } = useWork();
  const { threadKey: key, msgId } = parseCommitTab(tabId) ?? { threadKey: '', msgId: '' };
  const desktop = useMemo(isDesktop, []);
  const [sbs, setSbs] = useLocal('cc.sbs', innerWidth >= 1300);
  const [thread, setThread] = useState<ThreadData | null>(null);
  const [refs, setRefs] = useState<Refs | null>(null);
  const [error, setError] = useState('');
  const { pending, busy, run } = useAction();

  const reload = useCallback(() => api.thread(slug, key).then(setThread, (e) => setError(errorMessage(e))), [slug, key]);
  useEffect(() => {
    reload();
    return subscribe(topic('thread', slug, key), { message: (ev: { type?: string }) => ev.type === 'thread' && reload() });
  }, [reload]);

  const at = thread?.messages.findIndex((m) => m.id === msgId) ?? -1;
  const s = at >= 0 ? thread?.messages[at].suggestion : undefined;
  const sha = s?.kind === 'commit' ? s.commit : '';
  const newer = at >= 0 ? thread?.messages.slice(at + 1).findLast((m) => m.suggestion?.kind === 'commit') : undefined;
  useEffect(() => {
    if (!sha) return;
    commitApi.refs(sha).then(setRefs, (e: Error) => setError(e.message));
  }, [sha]);

  const notesKey = `${slug}:${sha}`;
  const notes = useNotes((st) => st[notesKey] ?? NO_NOTES);
  const unsent = notes.filter((c) => !c.draft && c.status !== 'sent');
  const notesOf = (path: string) => notes.filter((c) => c.path === path);

  const onCreate = (path: string) => ({ side, startLine, endLine }: LineRange & { side: Side }) =>
    editNotes(notesKey, (list) => [...list.filter((c) => !c.draft), { id: `n${Date.now().toString(36)}`, path, side, startLine, endLine, body: '', status: 'open', draft: true }]);
  const zone = (c: ReviewComment) => (
    <NoteZone
      note={c}
      onSave={(body) => editNotes(notesKey, (list) => list.map((x) => (x.id === c.id ? { ...x, body, draft: false } : x)))}
      onDelete={() => editNotes(notesKey, (list) => list.filter((x) => x.id !== c.id))}
    />
  );
  const send = async (text: string) => {
    const sent = new Set(unsent.map((c) => c.id));
    try {
      await postToThread(slug, key, { text: reviewMessage(sha, unsent, text) });
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    }
    editNotes(notesKey, (list) => list.map((c) => (sent.has(c.id) ? { ...c, status: 'sent' } : c)));
    return true;
  };

  if (error) return <div className="dp-empty">{error}</div>;
  if (!thread) return <div className="dp-empty">Loading…</div>;
  if (!s || s.kind !== 'commit') return <div className="dp-empty">This thread has no such suggested commit.</div>;
  const adds = refs?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
  const dels = refs?.files.reduce((n, f) => n + f.deletions, 0) ?? 0;
  return (
    <div className="cm-tab">
      <div className="cm-head">
        <div className="cm-head-r">
          <SuggestionState s={s} />
          <code>{sha.slice(0, 7)}</code>
          {refs && <span className="rv-stat">{refs.files.length} file{refs.files.length > 1 ? 's' : ''} · <span className="dp-add">+{adds}</span> <span className="dp-del">−{dels}</span></span>}
          <span className="dp-sp" />
          {desktop && <button type="button" className={`dp-btn dp-sm dp-ghost${sbs ? ' dp-on' : ''}`} onClick={() => setSbs(!sbs)}><Icon name="columns" size={12} />Side by side</button>}
        </div>
        {newer && (
          <div className="cm-newer">
            <span>The agent suggested a newer commit: <code>{newer.suggestion?.commit.slice(0, 7)}</code></span>
            <button type="button" className="dp-btn dp-sm" onClick={() => openCommitTab(key, newer.id)}>Open it</button>
          </div>
        )}
        <SuggestionActions
          s={s}
          verify={thread.verifies?.[sha]}
          busy={busy}
          pending={pending}
          onDecide={(action) => run(action, async () => { setThread(await api.suggestion(slug, key, msgId, action)); refreshThreads(slug); })}
          onVerify={() => run('verify', async () => { await api.verifyThread(slug, key, sha); await reload(); })}
        />
      </div>
      <div className="cm-files">
        {refs ? refs.files.map((f) => (
          <CommitFile key={f.filename} sha={sha} file={f} notes={notesOf(f.filename)} desktop={desktop} sbs={sbs} onCreate={onCreate(f.filename)} zone={zone} />
        )) : <div className="rv-note">Loading the commit…</div>}
      </div>
      {isOpenSuggestion(s) && (
        <div className="cm-send">
          <Composer
            attach={false}
            allowEmpty={unsent.length > 0}
            placeholder={unsent.length ? 'A note sent along with the line comments (optional, ↵ sends)' : 'Comment a line of the diff, or write to the agent about this commit (↵)'}
            sendLabel={unsent.length ? `Send ${unsent.length} comment${unsent.length > 1 ? 's' : ''} to the agent` : 'Send to the agent'}
            onSend={send}
          />
        </div>
      )}
    </div>
  );
}
