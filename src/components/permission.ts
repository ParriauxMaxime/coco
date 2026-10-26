// An agent's request to the owner as Paseo sends it, and the answer Paseo's own app gives: a question's answers keyed by its header,
// the picked labels joined by ", ", the Other text replacing them (single choice) or joining them (multiple choice).
import type { PermissionAction, PermissionRequest, PermissionResponse } from '../types.ts';

export type Question = { key: string; question: string; header: string; options: { label: string; description?: string }[]; multiSelect: boolean; allowOther: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function parseQuestions(input: unknown): Question[] | null {
  if (!isRecord(input) || !Array.isArray(input.questions)) return null;
  const out = input.questions.filter(isRecord).flatMap((q): Question[] => {
    const question = str(q.question);
    if (!question) return [];
    const options = (Array.isArray(q.options) ? q.options : []).flatMap((o) => (typeof o === 'string' ? [{ label: o }] : isRecord(o) && str(o.label) ? [{ label: str(o.label), ...(str(o.description) ? { description: str(o.description) } : {}) }] : []));
    return [{ key: str(q.header) || question, question, header: str(q.header), options, multiSelect: q.multiSelect === true, allowOther: q.allowOther === true || q.isOther === true || options.length === 0 }];
  });
  return out.length ? out : null;
}

export const isAnswered = (q: Question, picked: number[] = [], other = '') => picked.length > 0 || (q.allowOther && other.trim().length > 0);

export function buildAnswers(questions: Question[], picked: number[][], other: string[]) {
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const labels = (picked[i] || []).map((n) => q.options[n]?.label).filter(Boolean);
    const text = q.allowOther ? (other[i] || '').trim() : '';
    if (text) answers[q.key] = q.multiSelect ? [...labels, text].join(', ') : text;
    else if (labels.length) answers[q.key] = labels.join(', ');
  });
  return answers;
}

export const questionResponse = (request: PermissionRequest, answers: Record<string, string>): PermissionResponse => ({ behavior: 'allow', updatedInput: { ...(request.input || {}), answers } });

const FALLBACK: PermissionAction[] = [
  { id: 'allow', label: 'Allow', behavior: 'allow', variant: 'primary' },
  { id: 'deny', label: 'Deny', behavior: 'deny', variant: 'danger' },
];
export const actionsOf = (request: PermissionRequest) => (request.actions?.length ? request.actions : FALLBACK);
export const actionResponse = (request: PermissionRequest, action: PermissionAction): PermissionResponse => {
  const selected = request.actions?.some((a) => a.id === action.id) ? { selectedActionId: action.id } : {};
  return action.behavior === 'allow' ? { behavior: 'allow', ...selected } : { behavior: 'deny', ...selected };
};

// what the agent asks, in one line: the tool's command, file, query or URL, else its input's first text field
export function toolSummary(request: PermissionRequest) {
  const d = isRecord(request.detail) ? request.detail : {};
  const fromDetail = str(d.command) || str(d.filePath) || str(d.query) || str(d.url) || str(d.text) || str(d.description);
  if (fromDetail) return fromDetail;
  const input = request.input || {};
  const known = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'].map((k) => str(input[k])).find(Boolean);
  if (known) return known;
  return Object.keys(input).length ? JSON.stringify(input, null, 1) : '';
}

export const planText = (request: PermissionRequest) => str(request.input?.plan) || str(request.metadata?.planText) || (isRecord(request.detail) ? str(request.detail.text) : '');

// "Which items: widgets, gadgets · Depth: quick", "Implement", "denied"
export function answerSummary(request: PermissionRequest, resolution: unknown) {
  if (!isRecord(resolution)) return '';
  const action = request.actions?.find((a) => a.id === resolution.selectedActionId);
  if (resolution.behavior === 'deny') return action?.label || (str(resolution.message) ? `denied: ${str(resolution.message)}` : 'denied');
  const answers = isRecord(resolution.updatedInput) && isRecord(resolution.updatedInput.answers) ? resolution.updatedInput.answers : null;
  if (answers) {
    const questions = parseQuestions(request.input) || [];
    return Object.entries(answers).map(([k, v]) => `${questions.find((q) => q.key === k || q.question === k)?.header || k}: ${str(v)}`).join(' · ');
  }
  return action?.label || 'allowed';
}
