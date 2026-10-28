import type {
  AddRepoResult, AgentLog, AgentsResponse, AskRun, AskStartBody, BriefActionResult, BriefResponse, Config, CreateWorkBody, DevServerLogs,
  DevServersResponse, DispatchBody, DispatchEntry, PreflightResult, FeedbackItem, FindingActionBody, FindingsResponse, GateActionBody, GatesResponse, ImportArtifactBody, ImportedArtifact, KeepApplied, KeepPlan,
  KitResponse, KitScope, LinkedAgent, RowMilestone, LoginResult, NotionResult, NotionStatus, Overview, OverviewRituals, PackApplied, PackContents, PackExportBody, PackPreview, PaseoHealth, PaseoResponse, PermissionResponse, PersonaDetail,
  PersonaSuggestion, Persona, PinResult, RepoPage, RitualLaunchBody, RitualLaunchResult, Rule, RuleScope, RulesResponse, SetupStatus, Skill, SkillDetail,
  StartResult, StartedAgent, StopResult, SuggestionAction, Thread, ThreadGroup, ThreadPostBody, ThreadSummary, TimelineEntry, VerifyRun, Work, WorkDetail, WorkInput, WorkPlan,
  WorkAgents, WorktreeNotice, WorktreesRemoved, WorkWorktree,
} from './types.ts';
import type { Card, CardAnswerBody, DriftResponse, Job, ServerInfo } from './types.ts';
import type { UploadRef, WaitingAction, WaitingView } from './types.ts';
import type { AgentCommand, AgentInfo, AgentModes, AgentPrompt, ModelCatalog, ModelChoice, NewAgentBody, NewAgentPlaces, NewAgentStarted, ProviderUsage } from './types.ts';
import type { AgentHandoffs, Handoff, HandoffBody } from './types.ts';
import type { FsEntry, FsFile, GitCommit, GitFile, GitPr, GitStatus, GitTexts } from './types.ts';
import type { WorkspaceScript, WorkspaceTerminal } from './types.ts';

export type * from './types.ts';

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const JSON_HEADERS ={ 'Content-Type': 'application/json' };

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
};

// coco routes answer errors as { error: message }: throw the message, not the raw body
const jsonOrError = async <T>(res: Response): Promise<T> => {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
};

const get = <T>(url: string) => fetch(url).then(json<T>);
const send = <T>(method: string, url: string, body: unknown) => fetch(url, { method, headers: JSON_HEADERS, body: JSON.stringify(body) }).then(json<T>);
const post = <T>(url: string, body: unknown) => send<T>('POST', url, body);
const postEmpty = <T>(url: string) => fetch(url, { method: 'POST' }).then(json<T>);
const postJson = (url: string, body?: unknown) => fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body || {}) });
const text = (url: string) => fetch(url).then((r) => r.text());
const putText = <T>(url: string, body: string) => fetch(url, { method: 'PUT', body }).then(json<T>);

// a server started before threads existed answers thread routes with the work itself
const asThread = (t: Thread) => {
  if (!Array.isArray(t.messages)) throw new Error('the cocopilot server predates threads: restart it');
  return t;
};

export type RowAction = 'start' | 'stop' | 'pin' | 'warm';
type RowActionResult = { start: StartResult; stop: StopResult; pin: PinResult; warm: { queued: boolean; why: string } };

const works = (slug: string) => `/api/works/${slug}`;
const rulesBase = (slug: string | null | undefined) => (slug ? `${works(slug)}/rules` : '/api/rules');

// a workspace's git (server/workspace-git.ts): wsId is a Paseo workspace id, or `p.<base64url path>` for a worktree no workspace holds
const gitBase = (wsId: string) => `/api/workspaces/${encodeURIComponent(wsId)}/git`;
const getOrError = <T>(url: string) => fetch(url).then(jsonOrError<T>);
const gitPost = <T = { ok: boolean }>(wsId: string, action: string, body?: unknown) => postJson(`${gitBase(wsId)}/${action}`, body).then(jsonOrError<T>);
export const gitApi = {
  base: gitBase,
  status: (wsId: string) => getOrError<GitStatus>(`${gitBase(wsId)}/status`),
  diff: (wsId: string) => getOrError<{ files: GitFile[]; via: string }>(`${gitBase(wsId)}/diff`),
  texts: (wsId: string, path: string, previous?: string, unified = false) => getOrError<GitTexts>(`${gitBase(wsId)}/diff/file?${new URLSearchParams({ path, ...(previous ? { previous } : {}), ...(unified ? { unified: '1' } : {}) })}`),
  commits: (wsId: string) => getOrError<{ commits: GitCommit[] }>(`${gitBase(wsId)}/commits`),
  pr: (wsId: string, fresh = false) => getOrError<{ pr: GitPr | null }>(`${gitBase(wsId)}/pr${fresh ? '?fresh=1' : ''}`),
  commit: (wsId: string, message: string, paths?: string[]) => gitPost<{ ok: boolean; sha: string }>(wsId, 'commit', { message, ...(paths ? { paths } : {}) }),
  pull: (wsId: string) => gitPost(wsId, 'pull'),
  push: (wsId: string) => gitPost(wsId, 'push'),
  createPr: (wsId: string, body: { title: string; body: string; draft: boolean }) => gitPost<{ ok: boolean; url: string | null; number: number | null }>(wsId, 'pr', body),
  discard: (wsId: string, paths: string[]) => gitPost(wsId, 'discard', { paths }),
  stash: (wsId: string, action: 'save' | 'pop') => gitPost(wsId, 'stash', { action }),
};
// a workspace's files (server/workspace-files.ts); a save over a file changed on disk since it was read throws FileConflict
export class FileConflict extends Error {
  modifiedAt: string | null;
  constructor(message: string, modifiedAt: string | null) {
    super(message);
    this.modifiedAt = modifiedAt;
  }
}
const filesBase = (wsId: string) => `/api/workspaces/${encodeURIComponent(wsId)}/files`;
export const filesApi = {
  list: (wsId: string, dir: string) => getOrError<{ path: string; entries: FsEntry[]; truncated: boolean }>(`${filesBase(wsId)}/list?${new URLSearchParams({ path: dir })}`),
  read: (wsId: string, path: string) => getOrError<FsFile>(`${filesBase(wsId)}/read?${new URLSearchParams({ path })}`),
  tree: (wsId: string) => getOrError<{ files: string[]; truncated: boolean }>(`${filesBase(wsId)}/tree`),
  write: async (wsId: string, body: { path: string; content: string; expectedModifiedAt: string; expectedRevision?: string }) => {
    const res = await postJson(`${filesBase(wsId)}/write`, body);
    const out = await res.json().catch(() => null);
    if (out?.conflict) throw new FileConflict(out.error, out.modifiedAt ?? null);
    if (!res.ok) throw new Error(out?.error || `${res.status} ${res.statusText}`);
    return out as { ok: boolean; modifiedAt: string; size: number; revision?: string };
  },
};
// a workspace's terminals and scripts (server/workspace-terminals.ts), live through the topics workspace-terminals and terminal
const wsBase = (wsId: string) => `/api/workspaces/${encodeURIComponent(wsId)}`;
const termPost = <T = { ok: boolean }>(url: string, body?: unknown) => postJson(url, body).then(jsonOrError<T>);
export const termApi = {
  create: (wsId: string, size?: { rows: number; cols: number }) => termPost<{ terminal: WorkspaceTerminal }>(`${wsBase(wsId)}/terminals`, size),
  input: (wsId: string, id: string, data: string) => termPost(`${wsBase(wsId)}/terminals/${encodeURIComponent(id)}/input`, { data }),
  resize: (wsId: string, id: string, rows: number, cols: number) => termPost(`${wsBase(wsId)}/terminals/${encodeURIComponent(id)}/resize`, { rows, cols }),
  kill: (wsId: string, id: string) => termPost(`${wsBase(wsId)}/terminals/${encodeURIComponent(id)}/kill`),
  script: (wsId: string, name: string, action: 'start' | 'stop') => termPost<{ script: WorkspaceScript | null }>(`${wsBase(wsId)}/scripts/${encodeURIComponent(name)}/${action}`),
  planWorkspace: (slug: string) => termPost<{ workspaceId: string; cwd: string }>(`${works(encodeURIComponent(slug))}/plan-workspace`),
};
// a worktree with no Paseo workspace, by its path
export const pathWsId = (dir: string) => `p.${btoa(String.fromCharCode(...new TextEncoder().encode(dir))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

export const api = {
  config: () => get<Partial<Config>>('/api/config'),
  server: () => get<ServerInfo>('/api/server'),
  restartServer: () => postEmpty<{ restarting: boolean }>('/api/server/restart'),
  overview: () => get<Overview>('/api/overview'),
  saveLayout: (body: { repos: string[] } | { repo: string; works: string[] }) => send<unknown>('PUT', '/api/layout', body),
  addRepo: (source: string) => postJson('/api/repos', { source }).then(jsonOrError<AddRepoResult>),
  repo: (id: string, fresh?: boolean) => get<RepoPage>(`/api/repos/${encodeURIComponent(id)}${fresh ? '?fresh=1' : ''}`),
  dropLesson: (id: string, text: string) => fetch(`/api/repos/${encodeURIComponent(id)}/lessons`, { method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify({ text }) }).then(jsonOrError<{ ok: boolean }>),
  setup: () => get<SetupStatus>('/api/setup'),
  setupAgent: () => postEmpty<StartedAgent>('/api/setup/agent'),
  personas: () => get<Persona[]>('/api/personas'),
  persona: (login: string) => get<PersonaDetail>(`/api/personas/${login}`),
  personaFile: (login: string, name: string) => text(`/api/personas/${login}/files/${encodeURIComponent(name)}`),
  savePersonaFile: (login: string, name: string, body: string) => putText<{ ok: boolean; bytes: number }>(`/api/personas/${login}/files/${encodeURIComponent(name)}`, body),
  skills: () => get<Skill[]>('/api/skills'),
  skill: (name: string) => get<SkillDetail>(`/api/skills/${name}`),
  skillFile: (name: string, file: string) => text(`/api/skills/${name}/files/${encodeURIComponent(file)}`),
  saveSkillFile: (name: string, file: string, body: string) => putText<{ ok: boolean; bytes: number }>(`/api/skills/${name}/files/${encodeURIComponent(file)}`, body),
  agents: () => get<AgentsResponse>('/api/agents'),
  agentActivity: (id: string) => get<AgentLog>(`/api/agents-activity/${id}`),
  usage: () => get<{ usage: ProviderUsage | null }>('/api/usage').then((r) => r.usage),
  respondPermission: (agentId: string, requestId: string, body: PermissionResponse) => postJson(`/api/agents/${encodeURIComponent(agentId)}/permissions/${encodeURIComponent(requestId)}`, body).then(jsonOrError<{ ok: boolean }>),
  askConversation: (id: string) => get<AskRun>(`/api/ask/${encodeURIComponent(id)}`),
  linkedAgents: (slug?: string) => get<{ agents: LinkedAgent[] }>(`/api/paseo-link/agents${slug ? `?work=${encodeURIComponent(slug)}` : ''}`).then((r) => r.agents),
  reviews: () => get<{ name: string; dir: boolean; mtime: string; entries: string[] }[]>('/api/reviews'),
  feedback: () => get<FeedbackItem[]>('/api/feedback'),
  sendFeedback: (item: Omit<FeedbackItem, 'ts'>) => post<{ ok: boolean }>('/api/feedback', item),
  rituals: () => get<OverviewRituals>('/api/rituals'),
  paseo: () => get<PaseoResponse>('/api/paseo'),
  paseoHealth: () => get<PaseoHealth>('/api/paseo/health'),
  restartPaseo: () => postEmpty<PaseoHealth>('/api/paseo/restart'),
  refreshPaseoProviders: () => postEmpty<PaseoHealth>('/api/paseo/providers/refresh'),
  works: () => get<Work[]>('/api/works'),
  work: (slug: string, fresh?: boolean) => get<WorkDetail>(`${works(slug)}${fresh ? '?fresh=1' : ''}`),
  createWork: (body: CreateWorkBody) => post<Work>('/api/works', body),
  notionStatus: (slug: string) => get<NotionStatus>(`${works(slug)}/notion`),
  notionAction: (slug: string, body: Record<string, unknown>) => post<NotionResult>(`${works(slug)}/notion`, body),
  archiveWork: (slug: string, archived: boolean) => post<Work>(`${works(slug)}/archive`, { archived }),
  deleteWork: (slug: string, full = false) => fetch(`${works(slug)}${full ? '?full=1' : ''}`, { method: 'DELETE' }).then(json<{ ok: boolean; done: string[] }>),
  worktrees: (slug: string) => get<WorkWorktree[]>(`${works(slug)}/worktrees`),
  removeWorktrees: (slug: string, paths: string[]) => postJson(`${works(slug)}/worktrees/remove`, { paths }).then(jsonOrError<WorktreesRemoved>),
  notices: () => get<WorktreeNotice[]>('/api/notices'),
  dismissNotice: (id: string) => postEmpty<{ ok: boolean }>(`/api/notices/${encodeURIComponent(id)}/dismiss`),
  updateWork: (slug: string, body: WorkInput) => send<Work>('PUT', works(slug), body),
  addTimeline: (slug: string, body: { kind: string; text: string }) => post<TimelineEntry | Work>(`${works(slug)}/timeline`, body),
  threads: (slug: string) => get<Record<string, ThreadSummary>>(`${works(slug)}/threads`),
  thread: (slug: string, key: string, agents?: boolean) => get<Thread>(`${works(slug)}/threads/${key}${agents ? '?agents=1' : ''}`).then(asThread),
  postThread: (slug: string, key: string, body: ThreadPostBody) => post<Thread>(`${works(slug)}/threads/${key}`, body),
  regroup: (slug: string, key: string, groupId: string) => send<Thread>('PUT', `${works(slug)}/threads/${key}`, { groupId }).then(asThread),
  suggestion: (slug: string, key: string, msgId: string, action: SuggestionAction) => post<Thread>(`${works(slug)}/threads/${key}/suggestions/${msgId}`, { action }).then(asThread),
  verifyThread: (slug: string, key: string, commit?: string) => post<VerifyRun>(`${works(slug)}/threads/${key}/verify`, { commit }),
  groups: (slug: string) => get<ThreadGroup[]>(`${works(slug)}/groups`),
  closeGroup: (slug: string, id: string) => postEmpty<unknown>(`${works(slug)}/groups/${id}/close`),
  // key null drops the commit
  linkCommit: (slug: string, id: string, commit: string, key: string | null) => post<ThreadGroup>(`${works(slug)}/groups/${id}/link`, { commit, key }),
  findings: (slug: string, pr: string | null, fresh?: boolean, stale?: boolean) => get<FindingsResponse>(`${works(slug)}/findings?${new URLSearchParams({ ...(pr ? { pr } : {}), ...(fresh ? { fresh: '1' } : {}), ...(stale ? { stale: '1' } : {}) })}`),
  findingAction: (slug: string, body: FindingActionBody) => post<FindingsResponse>(`${works(slug)}/findings`, body),
  brief: (slug: string, n: string | number, handoff?: boolean) => get<BriefResponse>(`${works(slug)}/briefs/${encodeURIComponent(n)}${handoff ? '?handoff=1' : ''}`),
  briefAction: (slug: string, n: string | number, action: string) => postEmpty<BriefActionResult>(`${works(slug)}/briefs/${encodeURIComponent(n)}/${action}`),
  rules: (slug?: string | null) => get<RulesResponse>(slug ? `${works(slug)}/rules` : '/api/rules'),
  addRule: (slug: string | null | undefined, body: RuleScope & { text: string; source: string }) => post<RulesResponse>(rulesBase(slug), body),
  updateRule: (slug: string | null | undefined, id: string, body: RuleScope & { status?: Rule['status']; drop?: boolean }) => send<RulesResponse>('PUT', `${rulesBase(slug)}/${id}`, body),
  proposeRules: (slug: string | null | undefined, body: Partial<RuleScope> & { text?: string; threadKey?: string }) => post<RulesResponse>(`${rulesBase(slug)}/propose`, body),
  gates: (slug: string, n: string | number) => get<GatesResponse>(`${works(slug)}/gates/${encodeURIComponent(n)}`),
  milestones: (slug: string) => get<{ rows: RowMilestone[] }>(`${works(slug)}/gates`),
  gateAction: (slug: string, n: string | number, id: string, body: GateActionBody) => post<GatesResponse>(`${works(slug)}/gates/${encodeURIComponent(n)}/${id}`, body),
  dispatchCatalog: (slug: string) => get<{ catalog: DispatchEntry[] }>(`${works(slug)}/dispatch`),
  preflight: (slug: string, entry: string, key: string | number, fresh = false) => get<PreflightResult>(`${works(slug)}/preflight?entry=${encodeURIComponent(entry)}&key=${encodeURIComponent(String(key))}${fresh ? '&fresh=1' : ''}`),
  dispatch: (slug: string, body: DispatchBody) => postJson(`${works(slug)}/dispatch`, body).then(jsonOrError<{ job: Job }>),
  jobs: (work?: string) => get<{ jobs: Job[] }>(`/api/jobs${work ? `?work=${encodeURIComponent(work)}` : ''}`),
  dismissJob: (id: string) => post<Job>(`/api/jobs/${encodeURIComponent(id)}/dismiss`, {}),
  stackKeeper: (slug: string) => get<KeepPlan>(`${works(slug)}/stack-keeper`),
  stackKeeperAction: (slug: string, action: string) => postEmpty<KeepApplied & KeepPlan>(`${works(slug)}/stack-keeper/${action}`),
  inbox: (body: { url: string; note: string }) => post<{ id: string; kind: string }>('/api/inbox', body),
  drift: (slug: string, fresh = false) => get<DriftResponse>(`${works(slug)}/drift${fresh ? '?fresh=1' : ''}`),
  driftRun: (slug: string, id: string, command: string) => postJson(`${works(slug)}/drift/run`, { id, command }).then((r) => jsonOrError<{ job: Job }>(r)),
  kit: (slug: string, n: string | number) => get<KitResponse>(`${works(slug)}/kit/${encodeURIComponent(n)}`),
  kitScope: (slug: string, n: string | number, pieces: Record<string, boolean>) => post<KitResponse>(`${works(slug)}/kit/${encodeURIComponent(n)}`, { pieces, by: 'owner' } satisfies { pieces: Record<string, boolean>; by: KitScope['by'] }),
  decide: (slug: string, body: Record<string, unknown>) => post<Work['decisions']>(`${works(slug)}/decisions`, body),
  importArtifact: (slug: string, body: ImportArtifactBody) => post<ImportedArtifact>(`${works(slug)}/artifacts`, body),
  suggestPersonas: (slug: string, pr: string | number | null) => get<PersonaSuggestion>(`${works(slug)}/personas-suggest${pr ? `?pr=${pr}` : ''}`),
  plan: (slug: string) => get<WorkPlan>(`${works(slug)}/plan`),
  asks: (scope?: string) => get<AskRun[]>(`/api/ask${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`),
  ask: (body: AskStartBody) => post<{ id: string }>('/api/ask', body),
  models: () => get<ModelCatalog>('/api/models'),
  askSay: (id: string, body: { text: string; nonce: string; attachments?: string[] } & ModelChoice) => postJson(`/api/ask/${id}/messages`, body).then(jsonOrError<{ ok: boolean; status: string }>),
  closeAsk: (id: string) => postJson(`/api/ask/${id}/close`).then(jsonOrError<unknown>),
  workAgents: (slug: string) => get<WorkAgents>(`${works(slug)}/agents`),
  archiveAgents: (slug: string, ids: string[]) => postJson(`${works(slug)}/agents/archive`, { ids }).then(jsonOrError<{ archived: string[]; failed: { id: string; error: string }[] }>),
  agentSay: (agentId: string, text: string, attachments: string[] = [], pick: ModelChoice = {}) => postJson(`/api/agent-chat/${encodeURIComponent(agentId)}/messages`, { text, ...(attachments.length ? { attachments } : {}), ...pick }).then(jsonOrError<{ ok: boolean }>),
  upload: (file: File, name = file.name) => fetch(`/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }).then(jsonOrError<UploadRef>),
  dropUpload: (id: string) => fetch(`/api/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(jsonOrError<{ ok: boolean }>),
  agentInfo: (agentId: string) => get<AgentInfo>(`/api/agent-chat/${encodeURIComponent(agentId)}`),
  agentModes: (agentId: string) => fetch(`/api/agent-chat/${encodeURIComponent(agentId)}/mode`).then(jsonOrError<AgentModes>),
  setAgentMode: (agentId: string, mode: string) => postJson(`/api/agent-chat/${encodeURIComponent(agentId)}/mode`, { mode }).then(jsonOrError<AgentModes & { changed: boolean }>),
  agentCommands: (agentId: string) => fetch(`/api/agent-chat/${encodeURIComponent(agentId)}/commands`).then(jsonOrError<{ commands: AgentCommand[]; error: string | null }>),
  agentPrompts: (agentId: string) => fetch(`/api/agent-chat/${encodeURIComponent(agentId)}/prompts`).then(jsonOrError<{ prompts: AgentPrompt[] }>),
  renameAgent: (agentId: string, name: string) => postJson(`/api/agent-chat/${encodeURIComponent(agentId)}/rename`, { name }).then(jsonOrError<{ ok: boolean; title: string }>),
  handoffs: (agentId: string) => get<AgentHandoffs>(`/api/agent-chat/${encodeURIComponent(agentId)}/handoff`),
  handOff: (agentId: string, body: HandoffBody) => postJson(`/api/agent-chat/${encodeURIComponent(agentId)}/handoff`, body).then(jsonOrError<{ handoff: Handoff }>),
  newAgentPlaces: (work?: string | null) => get<NewAgentPlaces>(`/api/new-agent${work ? `?work=${encodeURIComponent(work)}` : ''}`),
  newAgent: (body: NewAgentBody) => post<NewAgentStarted>('/api/new-agent', body),
  agentStop: (agentId: string) => postJson(`/api/agent-chat/${encodeURIComponent(agentId)}/stop`).then(jsonOrError<{ ok: boolean }>),
  cards: (agentId: string) => fetch(`/api/agent-chat/${encodeURIComponent(agentId)}/cards`).then(jsonOrError<Card[]>),
  card: (id: string) => fetch(`/api/cards/${encodeURIComponent(id)}`).then(jsonOrError<Card>),
  answerCard: (id: string, answer: CardAnswerBody) => postJson(`/api/cards/${encodeURIComponent(id)}/answer`, answer).then(jsonOrError<Card>),
  cancelCard: (id: string) => postJson(`/api/cards/${encodeURIComponent(id)}/cancel`).then(jsonOrError<Card>),
  explainCard: (id: string) => postJson(`/api/cards/${encodeURIComponent(id)}/explain`).then(jsonOrError<Card>),
  waiting: (work?: string) => get<WaitingView>(work ? `/api/works/${work}/waiting` : '/api/waiting'),
  // one button of a waiting item: its own endpoint and body, plus the text of a reply
  waitingAct: (a: WaitingAction, text?: string) => postJson(a.url, a.kind === 'reply' ? { [a.field || 'text']: text } : a.body).then(jsonOrError<unknown>),
  ackWaiting: (ids: string[]) => postJson('/api/waiting/ack', { ids }).then(jsonOrError<unknown>),
  packContents: () => get<PackContents>('/api/pack/contents'),
  exportPack: async (body: PackExportBody) => {
    const res = await fetch('/api/pack/export', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'coco-pack.zip';
    return { blob: await res.blob(), name };
  },
  importPack: (file: File) => fetch('/api/pack/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file }).then(json<PackPreview>),
  applyPack: (id: string) => postEmpty<PackApplied>(`/api/pack/import/${id}/apply`),
  discardPack: (id: string) => fetch(`/api/pack/import/${id}`, { method: 'DELETE' }).then(json<{ ok: boolean }>),
  launch: (body: RitualLaunchBody) => post<RitualLaunchResult>('/api/rituals', body),
  devServers: (slug: string) => get<DevServersResponse>(`/api/dev-servers/works/${slug}`),
  devServerRow: <A extends RowAction>(slug: string, key: string | number, action: A, body?: Record<string, unknown>) =>
    postJson(`/api/dev-servers/works/${slug}/rows/${encodeURIComponent(key)}/${action}`, body).then(jsonOrError<RowActionResult[A]>),
  devServerLogin: (id: string) => postJson(`/api/dev-servers/servers/${id}/login`).then(jsonOrError<LoginResult>),
  devServerLogs: (id: string, lines: number) => fetch(`/api/dev-servers/servers/${id}/logs?lines=${lines}`).then(jsonOrError<DevServerLogs>),
};
