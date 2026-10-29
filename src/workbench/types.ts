import type * as Monaco from 'monaco-editor/editor/editor.api';
import type { Block, Decision, DecisionOption, ImportArtifactBody, ImportedArtifact, PrFile, PrInfo, StackRow, WorkDetail, WorkPlan } from '../types.ts';

export type Group = { type: 'group'; id: number; tabs: string[]; active: string | null; preview: string | null };
export type Split = { type: 'split'; dir: 'row' | 'col'; children: LayoutNode[]; sizes: number[] };
export type LayoutNode = Group | Split;
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export type Rect = { left: number; top: number; width: number; height: number };
export type Handle = Rect & { path: number[]; i: number; dir: 'row' | 'col'; sizes: number[]; origin: number; avail: number };
export type LayoutRects = { groups: (Rect & { id: number })[]; handles: Handle[] };
export type PendingLine = { line: number; side: string };

export type MonacoApi = typeof Monaco;
export type MonacoModule = { monaco: MonacoApi; languageFor: (path: string) => string };
export type ModelHost = Pick<MonacoModule, 'monaco' | 'languageFor'>;

export type PrKey = number | string;
export type Side = 'base' | 'head';
export type LineRange = { startLine: number; endLine: number };
export type Resolution = { commit?: string; note?: string };

export type ReviewComment = LineRange & {
  id: string;
  path: string;
  side: Side;
  status: string;
  body: string;
  sha?: string;
  severity?: string;
  confidence?: number;
  title?: string;
  blocks?: Block[];
  resolution?: Resolution;
  snippet?: string;
  draft?: boolean;
  proposal?: boolean;
  kind?: 'issue';
  index?: number;
  createdAt?: string;
  updatedAt?: string;
};
export type Proposal = ReviewComment & { index: number; proposal: true };
export type CommentInput = LineRange & { path: string; side: Side; sha?: string; body?: string; severity?: string; confidence?: number };
export type CommentPatch = { body?: string; status?: string; resolution?: Resolution; remark?: string };

export type RefFile = PrFile & { previous?: string };
export type Refs = { headSha: string; mergeBase: string; files: RefFile[] };
export type PlanStep = { title: string; why?: string; files: { path: string; focus?: string }[] };
export type WatchPoint = LineRange & { path: string; body: string; severity?: string; confidence?: number };
export type PlanBody = {
  steps: PlanStep[];
  skim: { path: string; reason?: string }[];
  watchPoints: WatchPoint[];
  createdAt: string;
  headSha: string;
  summary: string;
  personas: string[];
  surface: { area: string; risk: string; entryPoints: string; note?: string }[];
};
export type PlanLogEntry = { kind: string; text: string };
export type PlanRun = { status: string; startedAt: string; headSha?: string; progress: string[]; log?: PlanLogEntry[]; error?: string };
export type FileCategory = { category: string; reason?: string };
export type ReviewPlanState = {
  plan: PlanBody | null;
  stale?: boolean;
  placed?: Record<string, number>;
  headSha: string;
  ticks: string[];
  watch: Record<number, unknown>;
  categories: Record<string, FileCategory | undefined>;
  suggested: string[];
  run?: PlanRun | null;
};
export type ReviewRun = {
  runId: string;
  number: PrKey;
  mode: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  commentIds: string[];
  commits: string;
  provider: string;
  agentId?: string;
  cwd?: string;
  briefPath?: string;
  pushWarned?: boolean;
  pushedByUser?: boolean;
};

export type StackFixOpenRow = { key: PrKey; count: number; accepted?: number };
export type StackFixRunRow = { key: PrKey; branch: string; commentIds: string[]; tipBefore?: string; tipAfter?: string; restacked?: boolean; error?: string };
export type StackFixRun = {
  id: string;
  status: string;
  mode: string;
  startedAt: string;
  finishedAt?: string;
  pushWarned?: boolean;
  commits: string;
  provider: string;
  agentId?: string;
  cwd?: string;
  briefPath?: string;
  rows: StackFixRunRow[];
};
export type StackFixState = { runs: StackFixRun[]; open: StackFixOpenRow[] };
export type ImportReviewFile = { path: string; name: string; mtime: number };
export type ImportReviewResult = { added: { id: string; where: string; key: PrKey }[]; skipped: { where: string; reason: string }[] };

export type FileGroup ={ key: string; title: string; why?: string; files: RefFile[] };

export type DecisionView = Omit<Decision, 'options' | 'rows'> & {
  options: (DecisionOption & { details?: string; confidence?: number })[];
  rows?: { key: string; label: string; details?: string; confidence?: number; recommended?: string }[];
  recommended?: string;
  confidence?: number;
  positions?: Record<string, string>;
  source?: string;
};
export type DecisionChoice = string | Record<string, string>;

export type WhatsNextData = { by?: string; at?: string; summary?: string; blocks?: Block[] };

export type WorkPr = PrInfo & { body?: string; planned?: StackRow['planned']; files?: PrFile[] };

export type WorkData = {
  slug: string;
  w: WorkDetail;
  plan: WorkPlan | null;
  prs: WorkPr[];
  refreshing: boolean;
  err: string;
  load: (fresh?: boolean) => Promise<void>;
  saveStack: (stack: StackRow[]) => Promise<void>;
  saveMeta: (meta: { title: string; description?: string }) => Promise<void>;
  saveNotes: (notes: string) => Promise<void>;
  addNote: (text: string) => Promise<void>;
  importArtifact: (body: ImportArtifactBody) => Promise<ImportedArtifact>;
  addLink: () => Promise<void>;
  decide: (body: Record<string, unknown>) => Promise<void>;
};
