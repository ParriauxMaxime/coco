import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Block, Source } from './blocks.ts';
import type { Decision } from './decisions.ts';
import type { createWorks } from './works.ts';
import type { createComments } from './comments.ts';
import type { createCode } from './code.ts';
import type { createReviewAgent } from './review-agent.ts';

export type { Decision };

export type Req = IncomingMessage;
export type Res = ServerResponse;
export type Send = (res: Res, code: number, body: unknown, type?: string, cache?: string) => void;
export type ReadBody = (req: Req) => Promise<string>;

export type RowKey = number | string;

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type ExecResult = RunResult;
export type Exec = (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<ExecResult>;

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const httpStatus = (e: unknown): number => (typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number' && e.status ? e.status : 500);

export interface Planned {
  title?: string;
  scope?: string;
  branch?: string;
  order?: number;
}

export interface Rule {
  id: string;
  text: string;
  source: string;
  addedAt: string;
  status: string;
}

export interface GateRecord {
  state: string;
  at: string;
  skill?: string;
  agentId?: string | null;
  reason?: string;
  // a finished skill run: the head it ran on
  sha?: string | null;
}

export interface StackRow {
  number?: number | null;
  planned?: Planned;
  personas?: string[];
  keeper?: { parent?: number | null; at?: string };
  rules?: Rule[];
  gates?: Record<string, GateRecord>;
  kit?: Record<string, boolean>;
  // who scoped the kit (row.kit then lists every kind); unscoped, the kit milestone counts the body alone
  kitScope?: { by: 'agent' | 'owner'; why?: string; at: string };
  precedents?: string[];
  forbidden?: string[];
  scope?: string;
  notionPage?: { url: string; title: string };
  // the Paseo workspace coco made or adopted for this row, once an agent needed its branch
  workspaceId?: string;
  // coco's last run of the repo checks on a PR-branch agent's commits
  agentChecks?: AgentCheck;
}

export interface AgentCheck {
  state: 'passed' | 'failed' | 'unavailable';
  at: string;
  head: string;
  agentId: string;
  results: { label: string; state: string; why?: string }[];
  why?: string;
}

export interface TimelineEntry {
  ts: string;
  kind: string;
  text: string;
}

export interface WorkLink {
  label: string;
  url: string;
}

export interface WorkNotion {
  pageId?: string;
  url?: string;
  syncedAt?: string | null;
  syncedHash?: string | null;
  editedInNotion?: string | null;
  lastError?: string | null;
  preview?: { hash: string; at?: string; [key: string]: unknown } | null;
}

export interface Work {
  slug: string;
  title: string;
  stack: StackRow[];
  description?: string;
  summary?: string;
  artifacts?: Artifact[];
  notes?: string;
  tier?: string;
  repo?: string;
  projectId?: string | null;
  projectName?: string | null;
  links?: WorkLink[];
  personas?: string[];
  timeline?: TimelineEntry[];
  decisions?: Decision[];
  rules?: Rule[];
  notion?: WorkNotion;
  next?: unknown;
  archived?: { at: string; reason: string };
  autoArchive?: boolean;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface PrInfo {
  number: number | null;
  title?: string;
  url?: string;
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  head?: string;
  base?: string;
  sha?: string;
  headOid?: string | null;
  isCrossRepository?: boolean;
  ci?: string;
  checks?: { name: string; status: string; conclusion: string; url?: string }[];
  unresolvedThreads?: number;
  reviewers?: { login: string; state: string }[];
  error?: string;
  [key: string]: unknown;
}

export interface ArtifactMeta {
  pr: string | null;
  kind: string | null;
  headSha: string | null;
  at: string;
  // demo beats the video agent could not show, from the lem-demo-video render report
  blocked?: { beat: string; what: string; unblock: string }[];
}

export interface Artifact {
  name: string;
  isDir: boolean;
  size: number;
  mtime: string;
  url: string;
  files: string[];
  meta?: ArtifactMeta;
}

export type Persona = { login: string; hits: number };

export type CommentStatus = 'open' | 'sent' | 'fixed' | 'declined' | 'outdated';
export type Severity = 'blocking' | 'major' | 'minor' | 'nit';
export type Resolution = { commit?: string | null; note?: string };
export type Comment = {
  id: string;
  path: string;
  side: 'head' | 'base';
  sha: string;
  startLine: number;
  endLine: number;
  snippet: string;
  ctxBefore: string[];
  ctxAfter: string[];
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  status: CommentStatus;
  runId: string | number | null;
  resolution: Resolution | null;
  severity?: Severity;
  confidence?: number;
  title?: string;
  summary?: string | null;
  category?: string | null;
  recommendation?: string | null;
  blocks?: Block[] | null;
  sources?: Source[];
  // an unanchored finding (flag_coco_issue): no path, sha or lines; from is the agent that raised it
  kind?: 'issue';
  from?: { agent: string | null; work: string | null; pr: string | null };
};
export type CommentFile = { number: RowKey; headSha: string | null; mergeBase: string | null; comments: Comment[] };
export type CommentUpdate = { status?: CommentStatus; runId?: string | number | null; resolution?: Resolution | null };

export type AgentComment = {
  id: string;
  path: string;
  body: string;
  author?: string;
  status: string;
  startLine: number;
  endLine: number;
  createdAt: string;
  resolution?: Resolution | null;
  severity?: string;
  confidence?: number;
  title?: string;
  summary?: string | null;
  category?: string | null;
  recommendation?: string | null;
  blocks?: Block[] | null;
  sources?: Source[];
};

export type Refs = { number: RowKey; branch?: string; headSha: string; baseSha: string; mergeBase: string };
export type RefsOptions = { headSha?: string; baseSha?: string; baseRef?: string; headRef?: string; fresh?: boolean };
export type PrFile = { filename: string; status: string; previous?: string; additions: number; deletions: number };

export type Works = Pick<ReturnType<typeof createWorks>, 'get' | 'list' | 'save' | 'prInfo' | 'remark' | 'personasForPaths'> & Partial<Pick<ReturnType<typeof createWorks>, 'changed'>>;
export type CommentsApi = ReturnType<typeof createComments>;
export type CodeApi = ReturnType<typeof createCode>;
export type ReviewAgentApi = ReturnType<typeof createReviewAgent>;

export type PaseoAgentInfo = { id: string; cwd?: string; status?: string };
export type PaseoAgentRow = PaseoAgentInfo;
export type ReviewPr = { number: RowKey | null; title: string; url: string; state: string; isDraft: boolean; head: string; base: string; sha: string; body: string };
export type Runner = { mode: string; agentId?: string; cwd?: string; workspaceId?: string; newBranch?: string; base?: string; slug?: string };
export type LaunchInput = { title: string; provider: string; thinking?: string; prompt: string; labels?: Record<string, unknown>; requestedBy?: unknown; n?: RowKey; branch?: string };

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const SEVERITY_NAMES: string[] = ['blocking', 'major', 'minor', 'nit'];
export const isSeverity = (x: unknown): x is Severity => typeof x === 'string' && SEVERITY_NAMES.includes(x);

export const errorStatus = (e: unknown): number => {
  if (typeof e === 'object' && e !== null) {
    if ('status' in e && typeof e.status === 'number' && e.status) return e.status;
    if ('code' in e && typeof e.code === 'number' && e.code) return e.code;
  }
  return 500;
};
