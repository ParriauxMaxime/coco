import React, { useState } from 'react';
import type { ReactNode } from 'react';
import Markdown from '../../components/Markdown.tsx';
import { FindingBody } from '../../components/Blocks.tsx';
import Thread, { ThreadComposer, ThreadToggle, refreshThreads, threadKey } from '../../components/Thread.tsx';
import type { Verdict } from '../../components/Thread.tsx';
import type { UploadRef } from '../../types.ts';
import { Confidence, Severity } from '../../components/Signals.tsx';
import { api, errorMessage } from '../../api.ts';
import { toast } from '../../components/Toast.tsx';
import { useAction, pendingClass } from '../../components/action.ts';
import { Composer } from '../../preview/chat/Composer.tsx';
import type { ReviewHandle } from './use-comments.ts';
import type { LineRange, PrKey, Proposal, RefFile, ReviewComment, Side } from '../types.ts';
import './code.css';

type StatusChange = (comment: ReviewComment, status: string, note?: string) => unknown;
type RowVerdict = { icon: string; title: string; cls?: string; on: () => unknown };

const CHIP: Record<string, string> = { open: 'c-blue', sent: 'c-orange', fixed: 'c-green', declined: 'c-red', outdated: 'c-grey' };

function CommentBox({ initial = '', submitLabel, onSubmit, onCancel }: { initial?: string; submitLabel: string; onSubmit: (body: string) => void; onCancel: () => void }) {
  return (
    <Composer
      autoFocus
      attach={false}
      initial={initial}
      placeholder="Leave a comment (↵, ⇧↵ new line, esc cancels)"
      sendLabel={submitLabel}
      actions={() => <button type="button" className="dp-btn dp-sm dp-ghost" onClick={onCancel}>Cancel</button>}
      onCancel={onCancel}
      onSend={async (body) => { onSubmit(body); return true; }}
    />
  );
}

type IconBtnProps = { icon: ReactNode; title: string; cls?: string; pending?: boolean; disabled?: boolean; onClick: () => void };
const IconBtn = ({ icon, title, cls = '', pending = false, disabled = false, onClick }: IconBtnProps) => <button type="button" className={`cc-ib ${cls}${pendingClass(pending)}`} title={title} disabled={disabled} onClick={onClick}>{icon}</button>;

// icon row; verdicts: [{ icon, title, cls, on() }]: the clicked one spins until its promise settles, the others wait
function VerdictRow({ onJump, verdicts, extra }: { onJump?: () => void; verdicts: RowVerdict[]; extra?: ReactNode }) {
  const { pending, busy, run } = useAction();
  return (
    <div className="cc-pa">
      {onJump && <IconBtn icon="↗" title="Jump to the lines" onClick={onJump} />}
      {verdicts.map((v) => <IconBtn key={v.title} icon={v.icon} title={v.title} cls={v.cls} pending={pending === v.title} disabled={busy} onClick={() => run(v.title, async () => v.on())} />)}
      {extra}
    </div>
  );
}

// a coco watch point: ✓ accept, ✕ dismiss, or talk it over: Dispatch accepts it as a comment and sends the text to a scoped agent,
// thread keys shown open in the diff: survives a dispatched proposal turning into a comment and windowed card unmounts
const openThreads = new Set<string>();

// Accept / Dismiss in the box keep the text as the reason (work notes). onDispatched(threadKey) once the agent has it
export function WatchActions({ wp, rv, onJump, onDispatched }: { wp: Proposal; rv: ReviewHandle; onJump?: (c: ReviewComment) => void; onDispatched?: (key: string) => void }) {
  const [talking, setTalking] = useState(false);
  const [busy, setBusy] = useState(false);
  const { accept, dismiss } = proposalActions(rv);
  const dispatch = async (text: string, model?: string, files: UploadRef[] = []) => {
    setBusy(true);
    try {
      const c = await accept(wp);
      const key = threadKey.comment(rv.n, c.id);
      openThreads.add(key);
      await api.postThread(rv.slug, key, { text, model, ...(files.length ? { attachments: files.map((f) => f.id) } : {}) });
      refreshThreads(rv.slug);
      onDispatched?.(key);
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <VerdictRow
        onJump={onJump && (() => onJump(wp))}
        verdicts={[
          { icon: '✓', title: 'Accept: becomes an open comment', cls: 'ok', on: () => accept(wp) },
          { icon: '✕', title: 'Dismiss', cls: 'no', on: () => dismiss(wp) },
        ]}
        extra={rv.slug && <button type="button" className={`thread-toggle ${talking ? 'on' : ''}`} title="Talk it over with a scoped agent, or accept / dismiss with a reason" onClick={() => setTalking(!talking)}>💬 ask an agent</button>}
      />
      {talking && (
        <div className="thread">
          <ThreadComposer
            autoFocus
            busy={busy}
            withModel
            verdicts={[
              { label: '✓ Accept', title: 'Accept as a comment, the text saved as reason in the work notes', on: (note) => accept(wp, note).catch((e) => toast.error(errorMessage(e))) },
              { label: '✕ Dismiss', title: 'Dismiss, the text saved as reason in the work notes', on: (note) => dismiss(wp, note) },
            ]}
            placeholder="Ask a scoped agent whether it holds or to fix it (accepts it as a comment), or accept / dismiss with this text as reason (markdown, ↵)"
            onSend={dispatch}
          />
        </div>
      )}
    </>
  );
}

// resolve / decline / reopen a comment; onStatus(comment, status, note) · onDelete(comment) · onEdit() · thread: the agent thread toggle
export const isLive = (comment: ReviewComment) => comment.status === 'open' || comment.status === 'sent';
// verdicts a thread box offers on a live comment, the box text going along as reason
export const remarkVerdicts = (comment: ReviewComment, onStatus: StatusChange): Verdict[] => (isLive(comment) ? [
  { label: '✓ Resolve', title: 'Resolve (fixed), the text saved as reason in the work notes', on: (note) => onStatus(comment, 'fixed', note) },
  { label: '✕ Decline', title: 'Decline: will not fix, the text saved as reason in the work notes', on: (note) => onStatus(comment, 'declined', note) },
] : []);

type CommentActionsProps = {
  comment: ReviewComment;
  onJump?: (c: ReviewComment) => void;
  onStatus: StatusChange;
  onDelete: (c: ReviewComment) => unknown;
  onEdit?: () => void;
  thread?: ReactNode;
};

// the thread box is the one text box of a comment: dispatch to the agent, or resolve / decline with the text as reason
export function CommentActions({ comment, onJump, onStatus, onDelete, onEdit, thread }: CommentActionsProps) {
  const verdicts: RowVerdict[] = isLive(comment)
    ? [
      { icon: '✓', title: 'Resolve (fixed)', cls: 'ok', on: () => onStatus(comment, 'fixed') },
      { icon: '✕', title: 'Decline: will not fix', cls: 'no', on: () => onStatus(comment, 'declined') },
    ]
    : [{ icon: '↺', title: 'Reopen', on: () => onStatus(comment, 'open') }];
  return (
    <VerdictRow
      onJump={onJump && (() => onJump(comment))}
      verdicts={verdicts}
      extra={(
        <>
          {onEdit && <IconBtn icon="✎" title="Edit the comment" onClick={onEdit} />}
          {thread}
          <span className="cc-spacer" />
          <IconBtn icon="🗑" title="Delete" cls="no" onClick={() => onDelete(comment)} />
        </>
      )}
    />
  );
}

// coco watch point from the review plan: accept turns it into a real open comment
export function ProposalZone({ comment, rv }: { comment: Proposal; rv: ReviewHandle }) {
  const [folded, toggle] = useFolded(comment.id);
  return (
    <div className={`cc-zone cc-zone-proposed${folded ? ' cc-folded' : ''}`}>
      <div className="cc-head">
        <FoldCaret folded={folded} onClick={toggle} />
        <span className="chip c-purple">coco suggests</span>
        <Severity value={comment.severity} />
        <Confidence value={comment.confidence} />
        {folded && <FoldLine text={comment.title || comment.body} onClick={toggle} />}
      </div>
      {!folded && (
        <>
          <Markdown text={comment.body} />
          <WatchActions wp={comment} rv={rv} />
        </>
      )}
    </div>
  );
}

// comment cards folded down to their head line, to read the code under them; kept across windowed unmounts
const foldedCards = new Set<string>();
function useFolded(id: string): [boolean, () => void] {
  const [folded, setFolded] = useState(() => foldedCards.has(id));
  return [folded, () => {
    foldedCards[folded ? 'delete' : 'add'](id);
    setFolded(!folded);
  }];
}
const FoldCaret = ({ folded, onClick }: { folded: boolean; onClick: () => void }) => (
  <button type="button" className="cc-fold-caret" aria-expanded={!folded} title={folded ? 'Expand the comment' : 'Collapse the comment to its head line'} onClick={onClick}>{folded ? '▸' : '▾'}</button>
);
const FoldLine = ({ text, onClick }: { text: string; onClick: () => void }) => <span className="cc-fold-line" onClick={onClick}>{text.split('\n').find((l) => l.trim())?.replace(/[#*`>]/g, '').trim()}</span>;

type CommentZoneProps = {
  comment: ReviewComment;
  onSave?: (comment: ReviewComment, body: string) => unknown;
  onDelete?: (comment: ReviewComment) => unknown;
  onStatus?: StatusChange;
  draft?: boolean;
  thread?: { slug: string; n: PrKey; onSettled?: () => void };
};

// onSave(comment, body) · onDelete(comment) (also cancels a draft) · onStatus(comment, status) · thread: { slug, n, onSettled } to talk with the PR agent
export default function CommentZone({ comment, onSave, onDelete, onStatus, draft = false, thread }: CommentZoneProps) {
  const [editing, setEditing] = useState(false);
  const [folded, toggleFold] = useFolded(comment.id);
  const key = thread?.slug ? threadKey.comment(thread.n, comment.id) : null;
  const [talking, setTalking] = useState(() => Boolean(key && openThreads.has(key)));
  const toggleTalking = () => {
    if (key) openThreads[talking ? 'delete' : 'add'](key);
    setTalking(!talking);
  };
  if (draft) {
    return (
      <div className="cc-zone">
        <CommentBox submitLabel="Add comment" onSubmit={(body) => onSave?.(comment, body)} onCancel={() => onDelete?.(comment)} />
      </div>
    );
  }
  const { status, resolution } = comment;
  const commit = resolution?.commit ? String(resolution.commit).slice(0, 7) : '';
  return (
    <div className={`cc-zone cc-zone-${status}${folded ? ' cc-folded' : ''}`}>
      <div className="cc-head">
        <FoldCaret folded={folded} onClick={toggleFold} />
        <span className={`chip ${CHIP[status] || 'c-grey'}`}>{commit && (status === 'fixed' || status === 'declined') ? `${status} · ${commit}` : status}</span>
        <Severity value={comment.severity} />
        <Confidence value={comment.confidence} />
        {folded && <FoldLine text={comment.title || comment.body} onClick={toggleFold} />}
      </div>
      {folded ? null : editing ? (
        <CommentBox
          initial={comment.body}
          submitLabel="Save"
          onSubmit={(body) => {
            setEditing(false);
            onSave?.(comment, body);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : comment.blocks ? (
        <>{comment.title && <b>{comment.title}</b>}<FindingBody r={comment} /></>
      ) : (
        <Markdown text={comment.body} />
      )}
      {!folded && (status === 'fixed' || status === 'declined') && resolution?.note && <div className="cc-note">{resolution.note}</div>}
      {!folded && status === 'outdated' && comment.snippet && <pre className="cc-snippet">{comment.snippet}</pre>}
      {!folded && !editing && <CommentActions comment={comment} onStatus={(c, s, note) => onStatus?.(c, s, note)} onDelete={(c) => onDelete?.(c)} onEdit={() => setEditing(true)} thread={thread && key && <ThreadToggle slug={thread.slug} threadKey={key} open={talking} onClick={toggleTalking} />} />}
      {!folded && thread && key && talking && <Thread slug={thread.slug} threadKey={key} onSettled={thread.onSettled} verdicts={remarkVerdicts(comment, (c, s, note) => onStatus?.(c, s, note))} />}
    </div>
  );
}

// a status change with a remark keeps the remark on the comment and sends it to the work notes
export const setStatus = (rv: ReviewHandle, c: ReviewComment, status: string, note?: string) => rv.update(c.id, { status, ...(note ? { resolution: { ...(c.resolution || {}), note }, remark: note } : {}) });

// accept resolves with the new comment, which keeps the watch point's severity and confidence
export function proposalActions(rv: ReviewHandle) {
  return {
    accept: async (c: Proposal, note?: string) => {
      const comment = await rv.add({ path: c.path, side: 'head', sha: c.sha, startLine: c.startLine, endLine: c.endLine, body: c.body, severity: c.severity, confidence: c.confidence });
      await rv.setWatch(c.index, 'accepted', note);
      return comment;
    },
    dismiss: (c: Proposal, note?: string) => rv.setWatch(c.index, 'dismissed', note).catch((e) => toast.error(errorMessage(e))),
  };
}

const isProposal = (c: ReviewComment): c is Proposal => Boolean(c.proposal) && typeof c.index === 'number';

// Comments of one diff file (head path, or its previous path on the base side) and the handlers DiffView / LiteDiff take
export function fileCommentProps(rv: ReviewHandle, path: string, file?: RefFile) {
  const { refs } = rv;
  const prev = file?.previous;
  const mine = [...rv.comments, ...rv.drafts, ...rv.proposals].filter((c) => c.path === path || (c.side === 'base' && prev && c.path === prev));
  const onCreate = ({ side, startLine, endLine }: LineRange & { side: Side }) => {
    if (!refs) return;
    rv.addDraft({ side, path: side === 'base' && prev ? prev : path, sha: side === 'head' ? refs.headSha : refs.mergeBase, startLine, endLine });
  };
  const fail = (e: unknown) => toast.error(errorMessage(e));
  const save = async (c: ReviewComment, body: string) => {
    if (!c.draft) return rv.update(c.id, { body }).catch(fail);
    try {
      if (!refs) throw new Error('the review is not loaded yet');
      await rv.add({ path: c.path, side: c.side, sha: c.side === 'head' ? refs.headSha : refs.mergeBase, startLine: c.startLine, endLine: c.endLine, body });
      rv.dropDraft(c.id);
    } catch (e) { fail(e); }
  };
  const del = (c: ReviewComment) => (c.draft ? rv.dropDraft(c.id) : confirm('Delete this comment?') && rv.remove(c.id).catch(fail));
  const zone = (c: ReviewComment) => (isProposal(c) ? <ProposalZone comment={c} rv={rv} /> : <CommentZone comment={c} draft={Boolean(c.draft)} onSave={save} onDelete={del} onStatus={(x, status, note) => setStatus(rv, x, status, note).catch(fail)} thread={rv.slug ? { slug: rv.slug, n: rv.n, onSettled: rv.load } : undefined} />);
  return { mine, onCreate, zone };
}
