import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api.ts';
import { subscribe } from '../../live.ts';
import Markdown from '../../components/Markdown.tsx';
import { pendingClass, useAction } from '../../components/action.ts';
import { toolLabel } from '../../components/activity.ts';
import { actionResponse, actionsOf, answerSummary, buildAnswers, isAnswered, parseQuestions, planText, questionResponse, toolSummary } from '../../components/permission.ts';
import type { Question } from '../../components/permission.ts';
import Icon from '../Icon.tsx';
import type { IconName } from '../Icon.tsx';
import type { PendingPermission, PermissionAction, PermissionRequest, PermissionResponse } from '../../types.ts';
import './chat.css';

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

const KIND: Record<string, [string, IconName]> = { question: ['question', 'message-square'], plan: ['plan to approve', 'list'], tool: ['permission', 'terminal'], mode: ['mode change', 'settings'] };
const VARIANT: Record<string, string> = { primary: ' dp-primary', danger: ' dp-danger' };

function Actions({ request, onPick, pending }: { request: PermissionRequest; onPick: (a: PermissionAction) => void; pending: string | null }) {
  return (
    <div className="dp-cq-f">
      {actionsOf(request).map((a) => <button key={a.id} type="button" className={`dp-btn dp-sm${VARIANT[a.variant || ''] || ''}${pendingClass(pending === a.id)}`} disabled={pending !== null} onClick={() => onPick(a)}>{a.label}</button>)}
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
      <div className="dp-cq-b">
        {questions.map((q, i) => (
          <fieldset key={q.key} className="dp-q dp-perm-q">
            <legend className="dp-q-t">{q.header && <span className="dp-chip dp-info">{q.header}</span>}<span>{q.question}</span>{q.multiSelect && <span className="dp-n">pick any</span>}</legend>
            {q.options.map((o, n) => {
              const on = picked[i].includes(n);
              return (
                <label key={o.label} className={`dp-opt${on ? ' dp-on' : ''}`}>
                  <input className="dp-vh"type={q.multiSelect ? 'checkbox' : 'radio'} name={`${q.key}-${i}`} checked={on} onChange={() => pick(i, n)} onClick={() => !q.multiSelect && on && pick(i, n)} />
                  <span className={q.multiSelect ? 'dp-check' : 'dp-radio'} />
                  <span className="dp-ol"><b>{o.label}</b>{o.description && <span className="dp-q-d"> {o.description}</span>}</span>
                </label>
              );
            })}
            {q.allowOther && <input className="dp-inp dp-perm-other" value={other[i]} placeholder={q.options.length ? 'Other: your own answer' : 'Your answer'} onChange={(e) => type(i, e.target.value)} />}
          </fieldset>
        ))}
      </div>
      <div className="dp-cq-f">
        <button type="button" className={`dp-btn dp-primary dp-sm${pendingClass(pending === 'submit')}`} disabled={!ready || pending !== null} onClick={() => onSubmit(buildAnswers(questions, picked, other))}>Submit</button>
        <button type="button" className={`dp-btn dp-ghost dp-sm${pendingClass(pending === 'dismiss')}`} disabled={pending !== null} onClick={onDismiss}>Dismiss</button>
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
  const [label, icon] = KIND[request.kind] || ['request', 'bot'];
  if (answered !== null || resolution !== undefined) return <div className="dp-perm-done"><Icon name="check" size={12} /><span className="dp-ell">{label} · you answered: {answered ?? (answerSummary(request, resolution) || 'answered')}</span></div>;
  if (ready && !live) return <div className="dp-perm-done dp-perm-gone"><Icon name="clock" size={12} /><span className="dp-ell">{label} · no longer waiting: answered in Paseo, or the agent moved on</span></div>;
  const respond = (key: string, response: PermissionResponse, said?: string) =>
    run(key, () => api.respondPermission(target, request.id, response)).then((r) => r && setAnswered(said || answerSummary(request, response) || 'answered'));
  const questions = request.kind === 'question' ? parseQuestions(request.input) : null;
  const plan = request.kind === 'plan' ? planText(request) : '';
  const summary = request.kind === 'tool' ? toolSummary(request) : '';
  const body = (request.kind === 'tool' && request.title) || (request.description && !questions) || summary || plan;
  return (
    <div className="dp-card-q dp-attn dp-perm">
      <div className="dp-cq-h">
        <span className="dp-ic"><Icon name={icon} size={14} /></span>
        <span className="dp-chip dp-warn">{label}</span>
        <b className="dp-ell">{request.kind === 'tool' ? toolLabel(request.name) : questions ? 'The agent asks' : request.title || toolLabel(request.name)}</b>
        {where && <span className="dp-perm-where dp-ell">{where.href ? <a href={where.href}>{where.label}</a> : where.label}</span>}
      </div>
      {body && (
        <div className="dp-cq-b dp-perm-b">
          {request.kind === 'tool' && request.title && <div>{request.title}</div>}
          {request.description && !questions && <div className="dp-q-d">{request.description}</div>}
          {summary && <pre className="dp-cmdline">{summary}</pre>}
          {plan && <div className="dp-perm-plan"><Markdown text={plan} /></div>}
        </div>
      )}
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
  if (!seen.length) return null;
  return <div className="dp-perms">{seen.map((p) => <PermissionCard key={p.request.id} agentId={p.agentId} request={p.request} where={withWhere ? whereOf(p) : null} />)}</div>;
}
