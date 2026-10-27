import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import Markdown from './Markdown.tsx';
import { api } from '../api.ts';
import { subscribe } from '../live.ts';
import { pendingClass, useAction } from './action.ts';
import { toolLabel } from './activity.ts';
import { actionResponse, actionsOf, answerSummary, buildAnswers, isAnswered, parseQuestions, planText, questionResponse, toolSummary } from './permission.ts';
import type { Question } from './permission.ts';
import type { PendingPermission, PermissionAction, PermissionRequest, PermissionResponse } from '../types.ts';

// every request coco's agents wait on, pushed by the server on each change; one stream for the whole page
const usePending = create<{ pending: PendingPermission[]; ready: boolean }>(() => ({ pending: [], ready: false }));
let following = false;
const connect = () => {
  if (following) return;
  following = true;
  subscribe('permissions', { message: (d: { pending?: PendingPermission[] }) => usePending.setState({ pending: d.pending || [], ready: true }) });
};
export function usePendingPermissions() {
  useEffect(connect, []);
  return usePending();
}

const KIND_LABEL: Record<string, string> = { question: 'question', plan: 'plan to approve', tool: 'permission', mode: 'mode change' };
const BUTTON: Record<string, string> = { primary: 'primary', danger: 'danger' };

function Actions({ request, onPick, pending }: { request: PermissionRequest; onPick: (a: PermissionAction) => void; pending: string | null }) {
  return (
    <div className="row perm-actions">
      {actionsOf(request).map((a) => <button key={a.id} type="button" className={`sm ${BUTTON[a.variant || ''] || ''}${pendingClass(pending === a.id)}`} disabled={pending !== null} onClick={() => onPick(a)}>{a.label}</button>)}
    </div>
  );
}

function QuestionForm({ questions, onSubmit, onDismiss, pending }: { questions: Question[]; onSubmit: (answers: Record<string, string>) => void; onDismiss: () => void; pending: string | null }) {
  const [picked, setPicked] = useState<number[][]>(() => questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ''));
  const at = <T,>(list: T[], i: number, v: T) => list.map((x, j) => (j === i ? v : x));
  const pick = (i: number, n: number) => {
    const q = questions[i];
    const now = picked[i];
    setPicked(at(picked, i, q.multiSelect ? (now.includes(n) ? now.filter((x) => x !== n) : [...now, n]) : now.includes(n) ? [] : [n]));
    if (!q.multiSelect) setOther(at(other, i, ''));
  };
  const type = (i: number, text: string) => {
    setOther(at(other, i, text));
    if (!questions[i].multiSelect && text) setPicked(at(picked, i, []));
  };
  const ready = questions.every((q, i) => isAnswered(q, picked[i], other[i]));
  return (
    <>
      {questions.map((q, i) => (
        <fieldset key={q.key} className="perm-q">
          <legend>{q.header && <span className="chip c-blue">{q.header}</span>} {q.question}{q.multiSelect && <span className="status"> · pick any</span>}</legend>
          {q.options.map((o, n) => (
            <label key={o.label} className="perm-opt">
              <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${q.key}-${i}`} checked={picked[i].includes(n)} onChange={() => pick(i, n)} onClick={() => !q.multiSelect && picked[i].includes(n) && pick(i, n)} />
              <span><b>{o.label}</b>{o.description && <span className="status"> {o.description}</span>}</span>
            </label>
          ))}
          {q.allowOther && <input className="perm-other" value={other[i]} placeholder={q.options.length ? 'Other: your own answer' : 'Your answer'} onChange={(e) => type(i, e.target.value)} />}
        </fieldset>
      ))}
      <div className="row perm-actions">
        <button type="button" className={`sm primary${pendingClass(pending === 'submit')}`} disabled={!ready || pending !== null} onClick={() => onSubmit(buildAnswers(questions, picked, other))}>Submit</button>
        <button type="button" className={`sm${pendingClass(pending === 'dismiss')}`} disabled={pending !== null} onClick={onDismiss}>Dismiss</button>
      </div>
    </>
  );
}

// one request of an agent: answered here, it folds to what was answered. resolution: the answer the agent's log recorded, if any
type CardProps = { agentId?: string | null; request: PermissionRequest; resolution?: unknown; where?: { label: string; href: string } | null };
export default function PermissionCard({ agentId, request: logged, resolution, where }: CardProps) {
  const { pending, ready } = usePendingPermissions();
  const { pending: sending, run } = useAction();
  const [answered, setAnswered] = useState<string | null>(null);
  const live = pending.find((p) => p.request.id === logged.id && (!agentId || p.agentId === agentId));
  const request = live?.request || logged;
  const target = live?.agentId || agentId || '';
  const label = KIND_LABEL[request.kind] || 'request';
  if (answered !== null || resolution !== undefined) return <div className="perm-done status">✓ {label} · you answered: {answered ?? (answerSummary(request, resolution) || 'answered')}</div>;
  if (ready && !live) return <div className="perm-done status">{label} · no longer waiting: answered in Paseo, or the agent moved on</div>;
  const respond = (key: string, response: PermissionResponse, said?: string) =>
    run(key, () => api.respondPermission(target, request.id, response)).then((r) => r && setAnswered(said || answerSummary(request, response) || 'answered'));
  const questions = request.kind === 'question' ? parseQuestions(request.input) : null;
  const plan = request.kind === 'plan' ? planText(request) : '';
  const summary = request.kind === 'tool' ? toolSummary(request) : '';
  return (
    <div className="card keep perm">
      <div className="row perm-head">
        <span className="chip c-orange">{label}</span>
        <b>{request.kind === 'tool' ? toolLabel(request.name) : questions ? 'The agent asks' : request.title || toolLabel(request.name)}</b>
        {where && (where.href ? <a className="status" href={where.href}>{where.label}</a> : <span className="status">{where.label}</span>)}
      </div>
      {request.kind === 'tool' && request.title && <div>{request.title}</div>}
      {request.description && !questions && <div className="status">{request.description}</div>}
      {summary && <pre className="perm-pre">{summary}</pre>}
      {plan && <div className="perm-plan"><Markdown text={plan} /></div>}
      {questions ? (
        <QuestionForm questions={questions} pending={sending} onSubmit={(answers) => respond('submit', questionResponse(request, answers))} onDismiss={() => respond('dismiss', { behavior: 'deny', message: 'Dismissed by user' })} />
      ) : (
        <Actions request={request} pending={sending} onPick={(a) => respond(a.id, actionResponse(request, a), a.label)} />
      )}
    </div>
  );
}

// the requests waiting on the owner (one agent's, or every agent's), kept on screen once answered so their card folds instead of vanishing
export function PendingPermissions({ agentId, withWhere = false }: { agentId?: string | null; withWhere?: boolean }) {
  const { pending } = usePendingPermissions();
  const [seen, setSeen] = useState<PendingPermission[]>([]);
  useEffect(() => {
    const fresh = pending.filter((p) => (agentId === undefined || p.agentId === agentId) && !seen.some((s) => s.request.id === p.request.id));
    if (fresh.length) setSeen([...seen, ...fresh]);
  }, [pending, agentId]);
  const whereOf = (p: PendingPermission) => ({ label: [p.agentTitle, p.where?.label].filter(Boolean).join(' · ') || p.agentId.slice(0, 8), href: p.where?.href || '' });
  return seen.map((p) => <PermissionCard key={p.request.id} agentId={p.agentId} request={p.request} where={withWhere ? whereOf(p) : null} />);
}
