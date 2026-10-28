import type { Board, LoginResult, StartResult, StopResult, PinResult } from '../dev-servers/shared/contracts.ts';
import type { BoardServer, Placement } from '../dev-servers/shared/contracts.ts';

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

export type PaseoAgent = { id: string; shortId: string; name: string; status: string; provider: string; thinking: string; created: string; cwd: string; usage?: { promptTokens?: number; systemTokens?: number; inputTokens?: number; costUsd?: number; contextTokens?: number; contextMax?: number } | null };
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

// milestones: open PRs by current milestone, missing until the stack view computed them once
export type WorkProgress = { merged: number; ready: number; draft: number; planned: number; closed: number; attention: boolean; restack: boolean; milestones?: Record<string, number> };
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
  judge: JudgeStat[];
  ruleFiles: string[];
};
// the judge's answers in a repo per kind and model: the main judge's, with how many items the user dropped, and the shadow's, with how often it made the same call
export type JudgeStat = { kind: string; model: string; role: 'judge' | 'shadow'; decisions: number; failed: number; items: number; dropped: number; agree: number };
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
  proposing?: { status: string; error?: string; added?: number; cardId?: string } | null;
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

export type CardKind = 'post' | 'choice' | 'rows' | 'form' | 'confirm';
// what picking an option of a thread card does in coco instead of a new turn of the agent
export type CardEffect = { type: 'take_decision'; option: string } | { type: 'dismiss_finding' };
export type CardOption = { key: string; label: string; details?: string; consequence?: string; recommended?: boolean; confidence?: number; effect?: CardEffect };
export type CardField = { key: string; label: string; type: 'text' | 'textarea' | 'number' | 'select' | 'toggle'; options?: string[]; default?: string | number | boolean; required?: boolean; placeholder?: string };
export type CardRow = { key: string; cells: TableCell[]; recommended?: string | boolean };
export type CardValue = string | number | boolean;
export type CardAnswer = {
  at: string;
  picked?: string[];
  rows?: string[];
  rowPicks?: Record<string, string>;
  values?: Record<string, CardValue>;
  approved?: boolean;
  other?: string;
  // closed by a message the owner typed to the agent instead
  chat?: boolean;
};
export type CardAnswerBody = Omit<CardAnswer, 'at'>;
export type Card = {
  id: string;
  agentId: string;
  work: string | null;
  pr: string | null;
  kind: CardKind;
  title: string;
  question?: string;
  blocks?: Block[];
  options?: CardOption[];
  multi?: boolean;
  columns?: string[];
  rows?: CardRow[];
  select?: 'many' | 'one';
  rowOptions?: CardOption[];
  fields?: CardField[];
  confirmLabel?: string;
  rejectLabel?: string;
  other?: boolean;
  // the thread key it asks in: shown there, its answer goes through it
  thread?: string;
  // a proposal card: approving it runs this action, and result is what it did
  action?: { type: string; input: Record<string, unknown> };
  status: 'open' | 'answered' | 'cancelled';
  createdAt: string;
  answer?: CardAnswer;
  result?: { at: string; ok: boolean; detail: string; link?: string };
  delivery?: { at: string; ok: boolean; error?: string; skipped?: boolean };
  // "Explain more" asked the agent for detail; the card is still open
  explained?: { at: string; ok: boolean; error?: string; skipped?: boolean };
};

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
  agentId?: string;
  request?: PermissionRequest;
  requestId?: string;
  resolution?: unknown;
  attachments?: UploadRef[];
};
// a file uploaded for a message to an agent, served back at /api/uploads/<id>
export type UploadRef = { id: string; fileName: string; mimeType: string; size: number };

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
  checks?: CheckRun;
};
// coco's own run of the repo checks on an agent's commit
export type CheckRun = { state: 'running' | 'passed' | 'failed' | 'unavailable'; at: string; head: string; why?: string; results?: { label: string; state: string; why?: string; command?: string; output?: string }[] };
export type ThreadMessage = {
  id: string;
  role: 'user' | 'agent' | 'system';
  text?: string;
  ts?: string;
  blocks?: Block[];
  agentId?: string;
  model?: string;
  steer?: boolean;
  turn?: string;
  suggestion?: Suggestion;
  // replies from before cards: options shown read-only
  choices?: ThreadChoice[];
  picked?: number;
  // the card whose answer or effect it records
  card?: string;
  files?: UploadRef[];
};
export type ThreadChoice = { label: string; text: string; change: boolean; option?: string };
export type ThreadStep = { text: string; at: string };
export type Thread = {
  messages: ThreadMessage[];
  waiting?: { msgId: string; agentId?: string; deps?: { since: string } } | null;
  groupId?: string | null;
  newGroup?: boolean;
  agent?: { live: boolean; status: string } | null;
  // what a message waits on before it is stored (a worktree, the agent's start); also streamed as `step` events
  starting?: ThreadStep | null;
  // the best-mapped persona of the commented file: the "Ask <persona>" chip prefills the box
  persona?: string | null;
  cards?: Card[];
  // a commit of the group agent for this comment, not on the PR branch yet; approve: the message holding its Approve
  ready?: { commit: string; subject: string; stat: string; approve?: string } | null;
  // the owner's Verify runs by commit sha
  verifies?: Record<string, VerifyRun>;
};
export type VerifyRun = { commit: string; startedAt: string; finishedAt?: string; status: 'running' | 'pass' | 'fail' | 'deps-pending' | 'stale-head'; checks: { name: string; ok: boolean; ms: number; tail?: string; skipped?: string }[]; note?: string; head?: string };
export type ThreadSummary = { label?: string; count: number; waiting?: boolean; lastTs?: string; groupId?: string | null; open?: number; asks?: number };
// unlinked: commits of a code group's agent that no item took (no Cc-Comment line naming one, no single item in its turn), to link by hand
export type UnlinkedCommit = { commit: string; subject: string; files: string[]; at: string };
export type ThreadGroup = { id: string; agentId?: string | null; model: string; files?: string[]; status: string; items: unknown[]; kind: string; n: string | number; unlinked?: UnlinkedCommit[] };
export type ThreadPostBody = { text: string; model?: string; thinking?: string; attachments?: string[] };
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
  state: string;
  derived: boolean | null;
  // why a derived milestone is not done yet
  detail: string;
  reason: string;
  at: string | null;
  skill: string | null;
  agentId: string | null;
  canRun: boolean;
};
export type GatesResponse = { key: string | number; branch: string | null; current: string | null; gates: Gate[]; agentChecks?: (CheckRun & { agentId: string }) | null };
export type GateActionBody = { action: 'run' | 'ready' | 'done' | 'skipped' | 'todo'; skill?: string; args?: string; reason?: string };
export type RowMilestone = { key: string | number; current: string | null; done: number };

export type BriefResponse = { text: string; worktree: string | null; agent: PaseoAgent | null; stored: string[] };
export type BriefActionResult = { name?: string; path?: string; agentId?: string; mode?: string };

export type KitPiece = { id: string; label: string; state: string; expected: boolean; madeFor: string | null; at: string | null; source: string | null };
export type KitScope = { by: 'agent' | 'owner'; why?: string; at: string };
export type KitBetaFlag = { code: string; name?: string; why?: string; enable?: string; inBody?: boolean; mode?: string };
export type DriftAction = { type: 'dispatch'; entry: string; label: string; persona?: string } | { type: 'copy'; command: string; label: string } | { type: 'run'; command: string; label: string } | { type: 'tab'; tab: string; label: string };
export type DriftItem = { id: string; key: string | number | null; kind: string; text: string; action: DriftAction | null; also?: DriftAction };
export type DriftHead = { key: string | number; state: 'pushed' | 'ahead' | 'behind' | 'diverged' | 'remote'; count?: number; commits?: number };
// heads is missing from a drift cached on disk before it existed
export type DriftResponse = { drift: DriftItem[]; next: DriftItem[]; heads?: DriftHead[]; at: string };
export type KitResponse = { key: string | number; head: { sha: string | null; at: string | null }; betaFlags: KitBetaFlag[]; scope: KitScope | null; pieces: KitPiece[] };

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
  // where an agent starting a server here is served, and the row's place in the warm-build queue (0 = next)
  placement?: Placement | null;
  prebuildQueued?: number | null;
  // the worktree holds a build cache (e.g. from a server run by hand) the plugin has no record of
  cacheOnDisk?: boolean;
};
export type DevServersResponse = { on: true; board: Board; rows: DevServerRowData[] } | { on: false; reason: string };
export type DevServerLogs = { lines: string[] };

// the tier a conversation runs at: global (repos, cross-repo), a repo (its works), a work (its plan)
export type AskScope = { kind: 'global' } | { kind: 'repo'; repoId: string } | { kind: 'work'; slug: string };
export type DispatchEntry = { id: string; kind: string; label: string; edits: boolean; needsPr: boolean; needsPrompt?: boolean; needsPersona?: boolean; gate?: string; skill?: string; ask?: string };
export type PreflightResult = { checks: { name: string; ok: boolean; detail: string; fix: string }[]; at?: string };
export type DispatchBody ={ entry: string; key?: string | number | null; prompt?: string; persona?: string; args?: string; edits?: boolean; commentIds?: string[] } & ModelChoice;
export type JobState = 'running' | 'needs-you' | 'done' | 'failed' | 'lost';
export type ServerInfo = { running: string | null; head: string | null; behind: number; dirty: boolean; startedAt: string; build: string | null };
export type Job = { id: string; work: string | null; pr: string | null; action: string; label: string; kind: 'agent' | 'command' | 'sync' | 'setup'; state: JobState; agentId: string | null; startedAt: string; endedAt: string | null; output: string; error: string };
export type WorkWorktree = { path: string; branch: string; title: string; key: string | null; workspaceIds: string[]; dirty: number; unpushed: number; error?: string };
export type WorktreeNotice = { id: string; kind: 'worktrees'; slug: string; title: string; at: string; count: number };
export type WorktreesRemoved = { removed: string[]; kept: { path: string; why: string }[]; unarchived: { workspaceId: string; why: string }[] };
export type AskRun = {
  id: string;
  prompt: string;
  scope?: AskScope;
  workSlug?: string | null;
  pr?: string | number | null;
  kind?: string | null;
  model?: string | null;
  thinking?: string | null;
  startedAt: string;
  lastActivity?: string;
  status: string;
  turns?: number;
  // the latest proposal card of the conversation
  proposed?: { kind: 'work' | 'agent' | 'dispatch' | 'repo'; title: string } | null;
  agentId?: string | null;
  cost?: number | null;
};
export type AskStartBody = { prompt: string; workSlug?: string | null; pr?: string | null; repoId?: string | null; nonce: string; attachments?: string[] } & ModelChoice;
// a composer's pick: provider is `<provider>/<model id>`; Paseo's model list and the mode every coco agent runs in
export type ModelChoice = { provider?: string; thinking?: string };
export type ModelThinking = { id: string; label: string };
export type ModelEntry = { id: string; label: string; description: string | null; aliases: string[]; thinking: ModelThinking[]; defaultThinking: string | null };
export type ModelCatalog = { mode: string; defaults: { default: string; fast: string }; providers: { id: string; models: ModelEntry[]; error: string | null }[] };
export type WorkAgentStatus = 'running' | 'done' | 'failed' | 'archived';
// one agent of a work; id is its tab: ask-<conversation> or ag-<Paseo agent>
export type WorkAgent = { id: string; agentId: string | null; askId: string | null; kind: string; title: string; pr: string | null; status: WorkAgentStatus; updatedAt: string | null; openCards: number; subagents?: { running: number; total: number } } & AgentMetrics;
// any Paseo agent, in a work or not (GET /api/agent-chat/<agentId>)
export type AgentInfo = { agentId: string; title: string; kind: string; work: string | null; pr: string | null; status: WorkAgentStatus; updatedAt: string | null; provider: string | null; thinking: string | null; serverId: string | null; openCards: number } & AgentMetrics;
// estimated tokens of the first prompt and system prompt; input tokens (cached reads included) and cost as Paseo reports them; the context window at the last turn
export type AgentMetrics = { promptTokens: number | null; systemTokens: number | null; inputTokens: number | null; costUsd: number | null; contextTokens?: number | null; contextMax?: number | null };
export type UsageWindow = { id: string; label: string; shortLabel?: string; summary?: boolean; usedPct?: number | null; resetsAt?: string | null; tone?: 'default' | 'ok' | 'warning' | 'danger' };
export type ProviderUsage = { providerId: string; displayName: string; status: 'available' | 'unavailable' | 'error'; planLabel: string | null; windows: UsageWindow[]; error?: string | null };
export type WorkAgents = { agents: WorkAgent[]; serverId: string | null; error?: string };
export type AddRepoResult = {
  ok: boolean;
  error?: string;
  existing?: string;
  repo?: { id: string; name: string; path: string; github: string; defaultBranch: string };
  how?: 'folder' | 'found' | 'cloned';
  project?: { projectId?: string; name?: string; error?: string };
  setup?: { agentId?: string | null; error?: string };
};

export type OverviewRituals = { kinds: string[]; rituals: Ritual[]; history: RitualRun[] };
export type RitualLaunchBody = { kind: string; login?: string; pr?: string; paths?: string; text?: string };
export type RitualLaunchResult = RitualRun | { ok: false; error: string };

export type WaitingAction = { id: string; kind: 'pick' | 'approve' | 'dismiss' | 'reply' | 'ack' | 'open'; label: string; url: string; body?: Record<string, unknown>; field?: string };
export type WaitingItem = { id: string; kind: 'card' | 'approve' | 'thread' | 'ask'; work: string | null; pr: string | null; key?: string; title: string; excerpt: string; at: string; link: string; actions: WaitingAction[] };
export type WaitingView = { items: WaitingItem[]; count: number };
