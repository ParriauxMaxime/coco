import type { Board, LoginResult, StartResult, StopResult, PinResult } from '../dev-servers/shared/contracts.ts';
import type { BoardServer } from '../dev-servers/shared/contracts.ts';

export type { Board, LoginResult, StartResult, StopResult, PinResult, BoardServer };

export type Ritual = { kind: string; label?: string; title?: string; prompt?: string; hint?: string; fields?: string[] };

export type Config = {
  owner: { name: string; login: string };
  repo: { github: string; defaultBranch: string };
  baseUrl: string;
  models: { default: string; fast: string };
  kitKinds: string[];
  rituals: Ritual[];
  featureFlags: boolean;
  cloneDir?: string;
};

export type Persona = {
  login: string;
  title: string;
  kind: 'writer' | 'reviewer';
  github: string;
  avatar: string;
  mined: string | null;
  ageDays: number | null;
  stale: boolean;
  surfaces: number;
  checks: number;
  calibration: number;
  hasJson: boolean;
  hasSlack: boolean;
  files: string[];
};

export type Quote = [string, string];

export type PersonaJson = {
  kpis?: { label: string; value: string | number; note?: string }[];
  portrait?: string;
  scope?: { name: string; conf: string; rev?: boolean; strong?: boolean; paths: string; touch: number; primary?: number | null }[];
  scopeNote?: string;
  checks?: { q: string; hits: number; block?: boolean; quotes?: Quote[]; rule?: string }[];
  pass?: string[];
  voice?: string[];
  voiceQuotes?: Quote[];
  replyIntro?: string;
  replyQuotes?: Quote[];
  author?: string[];
  authorNotes?: string;
  commitExamples?: string[];
  codeExamples?: string[];
  avoids?: string;
};

export type FeedbackItem = { node: string; title?: string; verdict?: string; text?: string; ts: string };

export type PersonaDetail = Persona & { md: string; json: PersonaJson | null; feedback: FeedbackItem[] };

export type Skill = { name: string; description: string; argumentHint: string; userInvocable: boolean; mtime: string; files: string[] };
export type SkillDetail = Skill & { md: string };

export type PaseoAgent = { id: string; shortId: string; name: string; status: string; provider: string; thinking: string; created: string; cwd: string };
export type PaseoWorkspace = { workspaceId: string; project: string; name: string; cwd: string; isolation: string };
export type AgentsResponse = { agents: PaseoAgent[]; workspaces: PaseoWorkspace[]; error: string | null };
// an agent started by hand in a PR row workspace, linked to that row by the Paseo plugin
export type LinkedAgent = { agentId: string; slug: string; workTitle: string; key: number | string; label: string; workspaceId: string | null; title: string | null; linkedAt: string; briefAt: string | null };
export type AgentLog = { ok: boolean; out: string; err: string };

export type PaseoProject = {
  projectId: string;
  name: string;
  kind: string;
  path: string;
  workspaces: (PaseoWorkspace & { agents: (PaseoAgent & { cwdAbs: string })[] })[];
  agentCount: number;
  running: number;
  work: { slug: string; title: string } | null;
};
export type PaseoResponse = { projects: PaseoProject[]; orphanAgents: (PaseoAgent & { cwdAbs: string })[]; error: string | null };

export type WorkProgress = { merged: number; ready: number; draft: number; planned: number; closed: number; attention: boolean; restack: boolean };
export type WorkSummary = { slug: string; title: string; repo?: string; projectName?: string; stack: number; progress: WorkProgress; updatedAt?: string; archived: WorkArchived | null };
export type LoosePr = { number: number; title: string; url: string; state: string; isDraft: boolean; reviewDecision: string | null; headRefName: string; updatedAt: string };
// a repo's page: its live works in sidebar order with their what's-next line, the owner's open PRs no work holds, its brief lessons and rule files
export type RepoPage = {
  id: string;
  name: string;
  github: string;
  path: string;
  defaultBranch: string;
  works: (WorkSummary & { next: string | null })[];
  archivedCount: number;
  loose: { prs: LoosePr[]; error: string | null };
  lessons: { text: string; at?: string; work?: string }[];
  ruleFiles: string[];
};
export type RitualRun = { ts: string; kind: string; title: string; prompt: string; agentId: string | null; ok: boolean; out: string };

// a repo in sidebar order, its works' slugs in theirs
export type RepoGroup = { id: string; name: string; github: string; works: string[] };
export type Overview = {
  projectCount: number;
  personas: Persona[];
  skills: Skill[];
  works: WorkSummary[];
  repos: RepoGroup[];
  feedback: FeedbackItem[];
  feedbackCount: number;
  agents: PaseoAgent[];
  agentsError: string | null;
  backlog: string;
  changelog: string;
  rituals: RitualRun[];
  notices?: number;
};

export type SetupStep = { id: string; label: string; done: boolean; optional?: boolean; hint?: string; command?: string };
export type SetupStatus = { steps: SetupStep[]; done: boolean; restart: boolean; guide: string };
export type StartedAgent = { agentId: string | null; createdWorkspace: string | null };

export type PackContents = {
  personas: { login: string | null; files: string[] }[];
  skills: { name: string; files: string[]; bytes: number }[];
  config: boolean;
  provider: string | null;
};
export type PackFileStatus = 'new' | 'changed' | 'same';
export type PackFile = { file: string; status: PackFileStatus };
export type PackPreview = {
  id: string;
  by: string | null;
  createdAt: string | null;
  personas: PackFile[];
  skills: { name: string; files: PackFile[] }[];
  provider: PackFile | null;
  config: { added: string[]; changed: string[]; kept: string[] } | null;
};
export type PackApplied = { applied: { personas: number; skills: number; provider: number; config: number }; backup: string | null; restart: boolean };
export type PackExportBody = { personas: (string | null)[]; skills: string[]; config: boolean; provider: boolean };

export type Rule = { id: string; text: string; source: string; addedAt: string; status: string };
export type RuleScope = { scope: string; pr?: string };
export type RulesResponse = {
  global: Rule[];
  work?: Rule[];
  prs?: { key: string | number | null; title: string; rules: Rule[] }[];
  proposing?: { status: string; error?: string; added?: number } | null;
};

export type Link = { label: string; url: string };
export type TimelineEntry = { ts: string; kind: string; text: string };
export type WorkArchived = { at: string; reason: string };

export type DecisionOption = { key: string; label: string };
export type Decision = {
  id: string;
  title: string;
  status?: string;
  question?: string;
  options: DecisionOption[];
  rows?: { key: string; label: string }[];
  choice?: string | Record<string, string> | null;
  rationale?: string;
  decidedAt?: string | null;
  archivedAt?: string | null;
  pr?: string | number | null;
  sha?: string;
  summary?: string;
  blocks?: Block[];
  sources?: Source[];
  details?: string;
};

export type StackRow = {
  number?: number | string | null;
  branch?: string;
  planned?: { title?: string; scope?: string; branch?: string } | null;
  personas?: string[];
  rules?: Rule[];
  gates?: Record<string, { state: string; at: string; skill?: string; agentId?: string; reason?: string }>;
  kit?: Record<string, boolean>;
  precedents?: string[];
  forbidden?: string[];
  scope?: string;
  notionPage?: { url: string; title: string };
};

export type Artifact = {
  name: string;
  isDir: boolean;
  size: number;
  mtime: string;
  url: string;
  files: string[];
  meta?: { pr: string | null; kind: string | null; headSha: string | null; at: string };
};

export type PrCheck = { name: string; status: string; conclusion: string; url?: string };
export type PrInfo = {
  number: number | null;
  title?: string;
  url?: string;
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  head?: string;
  base?: string;
  sha?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  mergedAt?: string | null;
  updatedAt?: string;
  labels?: string[];
  ci?: string;
  checks?: PrCheck[];
  unresolvedThreads?: number;
  reviewers?: { login: string; state: string }[];
  error?: string;
  key?: string | number;
  personas?: string[];
};
export type PrFile = { filename: string; additions: number; deletions: number; status: string };
export type PlanPr = PrInfo & { body: string; files: PrFile[]; personas: string[]; planned: StackRow['planned'] };

export type Work = {
  slug: string;
  title: string;
  description?: string;
  notes?: string;
  tier?: string;
  summary?: string;
  projectId?: string;
  projectName?: string;
  stack?: StackRow[];
  links?: Link[];
  personas?: string[];
  timeline?: TimelineEntry[];
  decisions?: Decision[];
  rules?: Rule[];
  next?: unknown;
  archived?: WorkArchived | null;
  autoArchive?: boolean;
  createdAt?: string;
  updatedAt?: string;
};
export type WorkDetail = Work & { prs: PrInfo[]; artifacts: Artifact[]; notionStatus: NotionStatus; fetchedAt: string };
export type WorkPlan = Work & { prs: PlanPr[] };
export type NotionStatus = { running?: boolean; [key: string]: unknown };
export type NotionResult = { error?: string; [key: string]: unknown };
export type WorkInput = Partial<Omit<Work, 'slug' | 'archived'>>;
export type CreateWorkBody = { slug: string; title: string; repo?: string; projectId?: string; projectName?: string; stack: { number: number; personas: string[] }[]; links: Link[] };
export type ImportArtifactBody = { path: string; label?: string; pr?: string | number | null; kind?: string | null; headSha?: string };
export type ImportedArtifact = { name: string; dest: string; headSha: string | null };
export type PersonaSuggestion = { files: number; personas: { login: string; hits: number }[] };

export type BlockTone = 'risk' | 'warn' | 'ok' | 'note' | 'mute';
export type TableCell = string | { text: string; tone?: string };
export type Block =
  | { type: 'text'; text: string }
  | { type: 'callout'; tone: BlockTone; title?: string; text: string }
  | { type: 'steps'; title?: string; items: string[]; outcome?: string }
  | { type: 'diagram'; caption?: string; mermaid: string }
  | { type: 'code'; caption?: string; path?: string; line?: number; lang?: string; code: string }
  | { type: 'suggestion'; caption?: string; path: string; startLine: number; endLine?: number; before?: string | null; after: string }
  | { type: 'table'; caption?: string; columns: string[]; rows: TableCell[][] }
  | { type: 'media'; kind?: string; src: string; caption?: string };
export type Source = { label: string; url?: string; path?: string };

export type ActivityEvent = {
  type: string;
  id?: string;
  msgId?: string;
  name?: string;
  kind?: string;
  summary?: string;
  input?: string;
  output?: string;
  status?: string;
  text?: string;
  cost?: number | null;
  error?: string;
  reason?: string;
  conversation?: string;
  nonce?: string;
  steer?: boolean;
  proposal?: AskProposal | null;
  agentProposal?: AgentProposal | null;
  dispatchProposal?: DispatchProposal | null;
  repoProposal?: RepoProposal | null;
  agentId?: string;
  request?: PermissionRequest;
  requestId?: string;
  resolution?: unknown;
};

export type PermissionAction = { id: string; label: string; behavior: 'allow' | 'deny'; variant?: string; intent?: string };
export type PermissionRequest = { id: string; provider?: string; name: string; kind: string; title?: string; description?: string; input?: Record<string, unknown>; detail?: unknown; suggestions?: Record<string, unknown>[]; actions?: PermissionAction[]; metadata?: Record<string, unknown> };
export type PermissionResponse =
  | { behavior: 'allow'; selectedActionId?: string; updatedInput?: Record<string, unknown>; updatedPermissions?: Record<string, unknown>[] }
  | { behavior: 'deny'; selectedActionId?: string; message?: string; interrupt?: boolean };
export type PendingPermission = { agentId: string; agentTitle: string | null; request: PermissionRequest; since: string; where: { label: string; href: string } | null };

export type Suggestion = {
  state: string;
  kind: 'commit' | 'card';
  commit: string;
  files: string[];
  diff: string;
  fields: unknown;
  appliedCommit?: string;
  error?: string;
};
export type ThreadMessage = {
  id: string;
  role: 'user' | 'agent' | 'system';
  text?: string;
  blocks?: Block[];
  agentId?: string;
  model?: string;
  steer?: boolean;
  turn?: string;
  suggestion?: Suggestion;
};
export type Thread = {
  messages: ThreadMessage[];
  waiting?: { msgId: string } | null;
  groupId?: string | null;
  newGroup?: boolean;
  agent?: { live: boolean; status: string } | null;
};
export type ThreadSummary = { count: number; waiting?: boolean; lastTs?: string; groupId?: string | null; open?: number };
export type ThreadGroup = { id: string; model: string; files?: string[]; status: string; items: unknown[]; kind: string; n: string | number };
export type ThreadPostBody = { text: string; model?: string };
export type SuggestionAction = 'approve' | 'dismiss';

export type FindingRow = {
  key: string;
  n: string | number | null;
  path?: string;
  line?: number;
  endLine?: number;
  status: string;
  accepted?: boolean;
  source: string;
  by: { group: string; name: string };
  severity?: string;
  confidence?: number;
  claim?: string;
  body: string;
  summary?: string;
  category?: string;
  recommendation?: string;
  blocks?: Block[];
  sources?: Source[];
  url?: string;
  commentId?: string;
  ts: string;
  resolution?: { note?: string; commit?: string };
  dismissed?: { at: string; reason?: string };
};
export type FindingsResponse = {
  rows: FindingRow[];
  left: string[];
  stale?: boolean;
  at?: string;
  errors?: string[];
  pruned?: { outcome: string; group: string; others?: number; reason?: string }[];
};
export type FindingAction = 'accept' | 'dismiss' | 'reopen';
export type FindingActionBody = { action: FindingAction; keys: string[]; reason?: string; pr: string | null };

export type Gate = {
  id: string;
  label: string;
  skills: (string | { name: string; ask?: string })[];
  tab: string | null;
  command: string | null;
  state: string;
  derived: boolean | null;
  reason: string;
  at: string | null;
  skill: string | null;
  agentId: string | null;
};
export type GatesResponse = { key: string | number; branch: string | null; gates: Gate[] };
export type GateActionBody = { action: 'run' | 'done' | 'skipped' | 'todo'; skill?: string; args?: string; reason?: string };

export type BriefResponse = { text: string; worktree: string | null; agent: PaseoAgent | null; stored: string[] };
export type BriefActionResult = { name?: string; path?: string; agentId?: string; mode?: string };

export type KitPiece = { id: string; label: string; state: string; madeFor: string | null; at: string | null; source: string | null };
export type KitBetaFlag = { code: string; name?: string; why?: string; enable?: string; inBody?: boolean; mode?: string };
export type KitResponse = { key: string | number; head: { sha: string | null; at: string | null }; betaFlags: KitBetaFlag[]; pieces: KitPiece[] };

export type KeepStep = {
  key: string | number;
  number: number | null;
  branch: string;
  worktree: string | null;
  tipBefore?: string;
  upstream?: string;
  onto: { ref: string; name: string; full: string };
  skip: string | null;
  commands: string[];
  push: string;
  ghBase: string | null;
};
export type KeepPlan = { parent: { key: string | number; number: number; branch: string; headOid: string } | null; steps: KeepStep[] };
export type KeepResult = {
  key: string | number;
  branch: string;
  tipBefore?: string;
  tipAfter?: string;
  worktreeJson?: boolean;
  conflict?: string[];
  skipped?: string;
  error?: string;
  push?: string;
  ghBase?: string | null;
};
export type KeepApplied = { parent: KeepPlan['parent']; results: KeepResult[] };

export type DevServerRowData = {
  key: string | number;
  branch?: string | null;
  worktree?: string | null;
  holderId: string;
  server: (BoardServer & { leases: (BoardServer['leases'][number] & { mine: boolean })[] }) | null;
  servedFrom: string | null;
};
export type DevServersResponse = { on: true; board: Board; rows: DevServerRowData[] } | { on: false; reason: string };
export type DevServerLogs = { lines: string[] };

export type AskProposal = {
  title: string;
  slug: string;
  tier: string | number;
  summary: string;
  paseoProject?: { existingProjectId?: string; createNamed?: string };
  personas?: string[];
  stack?: { order: number; title: string; scope: string; branch: string; existingPr?: number; personas?: string[] }[];
  surfaces?: { surface: string; entryPoint: string; coverage: string }[];
  openQuestions?: { question: string; recommendation: string; tradeoff: string }[];
  notes: string;
  nextSteps?: string[];
};
export type AgentProposal = {
  title: string;
  provider: string;
  thinking: string;
  why: string;
  workspaceId?: string;
  cwd?: string;
  workSlug?: string;
  prompt: string;
};
// the tier a conversation runs at: global (repos, cross-repo), a repo (its works), a work (its plan)
export type AskScope = { kind: 'global' } | { kind: 'repo'; repoId: string } | { kind: 'work'; slug: string };
export type DispatchEntry = { id: string; kind: string; label: string; edits: boolean; needsPr: boolean; needsPrompt?: boolean; needsPersona?: boolean; gate?: string; skill?: string; ask?: string };
export type DispatchBody = { entry: string; key?: string | number | null; prompt?: string; persona?: string; args?: string; edits?: boolean; commentIds?: string[] };
export type DispatchResult = { kind: string; title: string; agentId: string | null; workspaceId?: string | null; edits: boolean; runId?: string; brief: 'written' | 'template' };
export type WorkWorktree = { path: string; branch: string; title: string; key: string | null; workspaceIds: string[]; dirty: number; unpushed: number; error?: string };
export type WorktreeNotice = { id: string; kind: 'worktrees'; slug: string; title: string; at: string; count: number };
export type WorktreesRemoved = { removed: string[]; kept: { path: string; why: string }[]; unarchived: { workspaceId: string; why: string }[] };
export type DispatchProposal = { entry: string; pr?: number | string; prompt?: string; persona?: string; edits?: boolean; workSlug?: string; why?: string };
export type AskRun = {
  id: string;
  prompt: string;
  scope?: AskScope;
  workSlug?: string | null;
  pr?: string | number | null;
  kind?: string | null;
  model?: string | null;
  startedAt: string;
  lastActivity?: string;
  status: string;
  turns?: number;
  proposal?: AskProposal | null;
  agentProposal?: AgentProposal | null;
  dispatchProposal?: DispatchProposal | null;
  repoProposal?: RepoProposal | null;
  agentId?: string | null;
  cost?: number | null;
};
export type AskStartBody = { prompt: string; workSlug?: string | null; pr?: string | null; repoId?: string | null; nonce: string };
export type WorkAgentStatus = 'running' | 'done' | 'failed' | 'archived';
// one agent of a work; id is its tab: ask-<conversation> or ag-<Paseo agent>
export type WorkAgent = { id: string; agentId: string | null; askId: string | null; kind: string; title: string; pr: string | null; status: WorkAgentStatus; updatedAt: string | null };
export type WorkAgents = { agents: WorkAgent[]; serverId: string | null; error?: string };
export type AskApplyResult = { ok?: boolean; error?: string; slug?: string; created?: boolean; stackKept?: boolean };
export type RepoProposal = { source: string; why?: string };
export type AddRepoResult = {
  ok: boolean;
  error?: string;
  existing?: string;
  repo?: { id: string; name: string; path: string; github: string; defaultBranch: string };
  how?: 'folder' | 'found' | 'cloned';
  project?: { projectId?: string; name?: string; error?: string };
  setup?: { agentId?: string | null; error?: string };
};
export type AskStartAgentResult = { ok?: boolean; error?: string; agentId?: string; out?: string };

export type OverviewRituals = { kinds: string[]; rituals: Ritual[]; history: RitualRun[] };
export type RitualLaunchBody = { kind: string; login?: string; pr?: string; paths?: string; text?: string };
export type RitualLaunchResult = RitualRun | { ok: false; error: string };
