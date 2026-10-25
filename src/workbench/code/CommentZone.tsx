import React, { useEffect, useRef, useState } from 'react';
import Markdown from '../../components/Markdown.tsx';
import { FindingBody } from '../../components/Blocks.tsx';
import Thread, { ThreadComposer, ThreadToggle, refreshThreads, threadKey } from '../../components/Thread.tsx';
import { Confidence, Severity } from '../../components/Signals.tsx';
import { api } from '../../api.ts';
import { toast } from '../../components/Toast.tsx';
import { useAction, pendingClass } from '../../components/action.ts';
import './code.css';

const CHIP = { open: 'c-blue', sent: 'c-orange', fixed: 'c-green', declined: 'c-red', outdated: 'c-grey' };

function Composer({ initial = '', submitLabel, onSubmit, onCancel }) {
  const [body, setBody] = useState(initial);
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const submit = () => body.trim() && onSubmit(body.trim());
  return (
    <>
      <textarea
        ref={ref}
        className="cc-textarea"
        rows={3}
        value={body}
        placeholder="Leave a comment"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="cc-actions">
        <button type="button" className="sm primary" disabled={!body.trim()} onClick={submit}>{submitLabel}</button>
        <button type="button" className="sm" onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

const IconBtn = ({ icon, title, cls = '', pending = false, disabled = false, onClick }) => <button type="button" className={`cc-ib ${cls}${pendingClass(pending)}`} title={title} disabled={disabled} onClick={onClick}>{icon}</button>;

// icon row; verdicts: [{ icon, title, cls, on() }]: the clicked one spins until its promise settles, the others wait
function VerdictRow({ onJump, verdicts, extra }) {
  const { pending, busy, run } = useAction();
  return (
    <div className="cc-pa">
      {onJump && <IconBtn icon="↗" title="Jump to the lines" onClick={onJump} />}
      {verdicts.map((v) => <IconBtn key={v.title} icon={v.icon} title={v.title} cls={v.cls} pending={pending === v.title} disabled={busy} onClick={() => run(v.title, () => v.on())} />)}
      {extra}
    </div>
  );
}

// a coco watch point: ✓ accept, ✕ dismiss, or talk it over: Dispatch accepts it as a comment and sends the text to a scoped agent,
// Accept / Dismiss in the box keep the text as the reason (work notes). onDispatched(threadKey) once the agent has it
export function WatchActions({ wp, rv, onJump, onDispatched }) {
  const [talking, setTalking] = useState(false);
  const [busy, setBusy] = useState(false);
  const { accept, dismiss } = proposalActions(rv);
  const dispatch = async (text, model) => {
    setBusy(true);
    try {
      const c = await accept(wp);
      const key = threadKey.comment(rv.n, c.id);
      await api.postThread(rv.slug, key, { text, model });
      refreshThreads(rv.slug);
      onDispatched?.(key);
    } catch (e) {
      toast.error(e.message);
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
        extra={rv.slug && <button type="button" className={`thread-toggle ${talking ? 'on' : ''}`} title="Talk it over with a scoped agent, or accept / dismiss with a reason" onClick={() => setTalking(!talking)}>💬 discuss or dispatch</button>}
      />
      {talking && (
        <div className="thread">
          <ThreadComposer
            autoFocus
            busy={busy}
            withModel
            verdicts={[
              { label: '✓ Accept', title: 'Accept as a comment, the text saved as reason in the work notes', on: (note) => accept(wp, note).catch((e) => toast.error(e.message)) },
              { label: '✕ Dismiss', title: 'Dismiss, the text saved as reason in the work notes', on: (note) => dismiss(wp, note) },
            ]}
            placeholder="Ask a scoped agent whether it holds or to fix it (accepts it as a comment), or accept / dismiss with this text as reason (markdown, ⌘↵)"
            onSend={dispatch}
          />
        </div>
      )}
    </>
  );
}

// resolve / decline / reopen a comment; onStatus(comment, status, note) · onDelete(comment) · onEdit() · thread: the agent thread toggle
export const isLive = (comment) => comment.status === 'open' || comment.status === 'sent';
// verdicts a thread box offers on a live comment, the box text going along as reason
export const remarkVerdicts = (comment, onStatus) => (isLive(comment) ? [
  { label: '✓ Resolve', title: 'Resolve (fixed), the text saved as reason in the work notes', on: (note) => onStatus(comment, 'fixed', note) },
  { label: '✕ Decline', title: 'Decline: will not fix, the text saved as reason in the work notes', on: (note) => onStatus(comment, 'declined', note) },
] : []);

// the thread box is the one text box of a comment: dispatch to the agent, or resolve / decline with the text as reason
export function CommentActions({ comment, onJump, onStatus, onDelete, onEdit, thread }) {
  const verdicts = isLive(comment)
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
export function ProposalZone({ comment, rv }) {
  return (
    <div className="cc-zone cc-zone-proposed">
      <div className="cc-head">
        <span className="chip c-purple">coco suggests</span>
        <Severity value={comment.severity} />
        <Confidence value={comment.confidence} />
      </div>
      <Markdown text={comment.body} />
      <WatchActions wp={comment} rv={rv} />
    </div>
  );
}

// onSave(comment, body) · onDelete(comment) (also cancels a draft) · onStatus(comment, status) · thread: { slug, n, onSettled } to talk with the PR agent
export default function CommentZone({ comment, onSave, onDelete, onStatus, draft = false, thread }) {
  const [editing, setEditing] = useState(false);
  const [talking, setTalking] = useState(false);
  if (draft) {
    return (
      <div className="cc-zone">
        <Composer submitLabel="Add comment" onSubmit={(body) => onSave?.(comment, body)} onCancel={() => onDelete?.(comment)} />
      </div>
    );
  }
  const { status, resolution } = comment;
  const key = thread?.slug && threadKey.comment(thread.n, comment.id);
  const commit = resolution?.commit ? String(resolution.commit).slice(0, 7) : '';
  return (
    <div className={`cc-zone cc-zone-${status}`}>
      <div className="cc-head">
        <span className={`chip ${CHIP[status] || 'c-grey'}`}>{commit && (status === 'fixed' || status === 'declined') ? `${status} · ${commit}` : status}</span>
        <Severity value={comment.severity} />
        <Confidence value={comment.confidence} />
      </div>
      {editing ? (
        <Composer
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
      {(status === 'fixed' || status === 'declined') && resolution?.note && <div className="cc-note">{resolution.note}</div>}
      {status === 'outdated' && comment.snippet && <pre className="cc-snippet">{comment.snippet}</pre>}
      {!editing && <CommentActions comment={comment} onStatus={(c, s, note) => onStatus?.(c, s, note)} onDelete={(c) => onDelete?.(c)} onEdit={() => setEditing(true)} thread={key && <ThreadToggle slug={thread.slug} threadKey={key} open={talking} onClick={() => setTalking(!talking)} />} />}
      {key && talking && <Thread slug={thread.slug} threadKey={key} onSettled={thread.onSettled} verdicts={remarkVerdicts(comment, (c, s, note) => onStatus?.(c, s, note))} />}
    </div>
  );
}

// a status change with a remark keeps the remark on the comment and sends it to the work notes
export const setStatus = (rv, c, status, note) => rv.update(c.id, { status, ...(note ? { resolution: { ...(c.resolution || {}), note }, remark: note } : {}) });

// accept resolves with the new comment, which keeps the watch point's severity and confidence
export function proposalActions(rv) {
  return {
    accept: async (c, note) => {
      const comment = await rv.add({ path: c.path, side: 'head', sha: c.sha, startLine: c.startLine, endLine: c.endLine, body: c.body, severity: c.severity, confidence: c.confidence });
      await rv.setWatch(c.index, 'accepted', note);
      return comment;
    },
    dismiss: (c, note) => rv.setWatch(c.index, 'dismissed', note).catch((e) => toast.error(e.message)),
  };
}

// Comments of one diff file (head path, or its previous path on the base side) and the handlers DiffView / LiteDiff take
export function fileCommentProps(rv, path, file) {
  const { refs } = rv;
  const prev = file?.previous;
  const mine = [...rv.comments, ...rv.drafts, ...rv.proposals].filter((c) => c.path === path || (c.side === 'base' && prev && c.path === prev));
  const onCreate = ({ side, startLine, endLine }) => {
    if (!refs) return;
    rv.addDraft({ side, path: side === 'base' && prev ? prev : path, sha: side === 'head' ? refs.headSha : refs.mergeBase, startLine, endLine });
  };
  const fail = (e) => toast.error(e.message);
  const save = async (c, body) => {
    if (!c.draft) return rv.update(c.id, { body }).catch(fail);
    try {
      await rv.add({ path: c.path, side: c.side, sha: c.side === 'head' ? refs.headSha : refs.mergeBase, startLine: c.startLine, endLine: c.endLine, body });
      rv.dropDraft(c.id);
    } catch (e) { fail(e); }
  };
  const del = (c) => (c.draft ? rv.dropDraft(c.id) : confirm('Delete this comment?') && rv.remove(c.id).catch(fail));
  const zone = (c) => (c.proposal ? <ProposalZone comment={c} rv={rv} /> : <CommentZone comment={c} draft={Boolean(c.draft)} onSave={save} onDelete={del} onStatus={(x, status, note) => setStatus(rv, x, status, note).catch(fail)} thread={rv.slug && { slug: rv.slug, n: rv.n, onSettled: rv.load }} />);
  return { mine, onCreate, zone };
}
