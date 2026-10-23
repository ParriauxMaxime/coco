const json = async (res) => {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
};

// coco routes answer errors as { error: message }: throw the message, not the raw body
const jsonOrError = async (res) => {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
};
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

// a server started before threads existed answers thread routes with the work itself
const asThread = (t) => {
  if (!Array.isArray(t.messages)) throw new Error('the cocopilot server predates threads: restart it');
  return t;
};

export const api = {
  config: () => fetch('/api/config').then(json),
  overview: () => fetch('/api/overview').then(json),
  setup: () => fetch('/api/setup').then(json),
  setupAgent: () => fetch('/api/setup/agent', { method: 'POST' }).then(json),
  personas: () => fetch('/api/personas').then(json),
  persona: (login) => fetch(`/api/personas/${login}`).then(json),
  personaFile: (login, name) => fetch(`/api/personas/${login}/files/${encodeURIComponent(name)}`).then((r) => r.text()),
  savePersonaFile: (login, name, text) => fetch(`/api/personas/${login}/files/${encodeURIComponent(name)}`, { method: 'PUT', body: text }).then(json),
  skills: () => fetch('/api/skills').then(json),
  skill: (name) => fetch(`/api/skills/${name}`).then(json),
  skillFile: (name, file) => fetch(`/api/skills/${name}/files/${encodeURIComponent(file)}`).then((r) => r.text()),
  saveSkillFile: (name, file, text) => fetch(`/api/skills/${name}/files/${encodeURIComponent(file)}`, { method: 'PUT', body: text }).then(json),
  agents: () => fetch('/api/agents').then(json),
  agentActivity: (id) => fetch(`/api/agents-activity/${id}`).then(json),
  reviews: () => fetch('/api/reviews').then(json),
  feedback: () => fetch('/api/feedback').then(json),
  sendFeedback: (item) => fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) }).then(json),
  rituals: () => fetch('/api/rituals').then(json),
  paseo: () => fetch('/api/paseo').then(json),
  works: () => fetch('/api/works').then(json),
  work: (slug, fresh) => fetch(`/api/works/${slug}${fresh ? '?fresh=1' : ''}`).then(json),
  createWork: (body) => fetch('/api/works', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  notionStatus: (slug) => fetch(`/api/works/${slug}/notion`).then(json),
  notionAction: (slug, body) => fetch(`/api/works/${slug}/notion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  archiveWork: (slug, archived) => fetch(`/api/works/${slug}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived }) }).then(json),
  updateWork: (slug, body) => fetch(`/api/works/${slug}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  addTimeline: (slug, body) => fetch(`/api/works/${slug}/timeline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  threads: (slug) => fetch(`/api/works/${slug}/threads`).then(json),
  thread: (slug, key, agents) => fetch(`/api/works/${slug}/threads/${key}${agents ? '?agents=1' : ''}`).then(json).then(asThread),
  postThread: (slug, key, body) => fetch(`/api/works/${slug}/threads/${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  regroup: (slug, key, groupId) => fetch(`/api/works/${slug}/threads/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId }) }).then(json).then(asThread),
  suggestion: (slug, key, msgId, action) => fetch(`/api/works/${slug}/threads/${key}/suggestions/${msgId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }).then(json).then(asThread),
  groups: (slug) => fetch(`/api/works/${slug}/groups`).then(json),
  closeGroup: (slug, id) => fetch(`/api/works/${slug}/groups/${id}/close`, { method: 'POST' }).then(json),
  findings: (slug, pr, fresh, stale) => fetch(`/api/works/${slug}/findings?${new URLSearchParams({ ...(pr ? { pr } : {}), ...(fresh ? { fresh: '1' } : {}), ...(stale ? { stale: '1' } : {}) })}`).then(json),
  findingAction: (slug, body) => fetch(`/api/works/${slug}/findings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  brief: (slug, n, handoff) => fetch(`/api/works/${slug}/briefs/${encodeURIComponent(n)}${handoff ? '?handoff=1' : ''}`).then(json),
  briefAction: (slug, n, action) => fetch(`/api/works/${slug}/briefs/${encodeURIComponent(n)}/${action}`, { method: 'POST' }).then(json),
  rules: (slug) => fetch(slug ? `/api/works/${slug}/rules` : '/api/rules').then(json),
  addRule: (slug, body) => fetch(slug ? `/api/works/${slug}/rules` : '/api/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  updateRule: (slug, id, body) => fetch(`${slug ? `/api/works/${slug}/rules` : '/api/rules'}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  proposeRules: (slug, body) => fetch(`${slug ? `/api/works/${slug}/rules` : '/api/rules'}/propose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  gates: (slug, n) => fetch(`/api/works/${slug}/gates/${encodeURIComponent(n)}`).then(json),
  gateAction: (slug, n, id, body) => fetch(`/api/works/${slug}/gates/${encodeURIComponent(n)}/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  stackKeeper: (slug) => fetch(`/api/works/${slug}/stack-keeper`).then(json),
  stackKeeperAction: (slug, action) => fetch(`/api/works/${slug}/stack-keeper/${action}`, { method: 'POST' }).then(json),
  inbox: (body) => fetch('/api/inbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  kit: (slug, n) => fetch(`/api/works/${slug}/kit/${encodeURIComponent(n)}`).then(json),
  decide: (slug, body) => fetch(`/api/works/${slug}/decisions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  importArtifact: (slug, body) => fetch(`/api/works/${slug}/artifacts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  suggestPersonas: (slug, pr) => fetch(`/api/works/${slug}/personas-suggest${pr ? `?pr=${pr}` : ''}`).then(json),
  plan: (slug) => fetch(`/api/works/${slug}/plan`).then(json),
  asks: () => fetch('/api/ask').then(json),
  ask: (body) => fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  startAskAgent: (id) => fetch(`/api/ask/${id}/start-agent`, { method: 'POST' }).then(json),
  applyAsk: (id, body) => fetch(`/api/ask/${id}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(json),
  packContents: () => fetch('/api/pack/contents').then(json),
  exportPack: async (body) => {
    const res = await fetch('/api/pack/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'coco-pack.zip';
    return { blob: await res.blob(), name };
  },
  importPack: (file) => fetch('/api/pack/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file }).then(json),
  applyPack: (id) => fetch(`/api/pack/import/${id}/apply`, { method: 'POST' }).then(json),
  discardPack: (id) => fetch(`/api/pack/import/${id}`, { method: 'DELETE' }).then(json),
  launch: (body) => fetch('/api/rituals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json),
  devServers: (slug) => fetch(`/api/dev-servers/works/${slug}`).then(jsonOrError),
  devServerRow: (slug, key, action, body) => postJson(`/api/dev-servers/works/${slug}/rows/${encodeURIComponent(key)}/${action}`, body).then(jsonOrError),
  devServerLogin: (id) => postJson(`/api/dev-servers/servers/${id}/login`).then(jsonOrError),
  devServerLogs: (id, lines) => fetch(`/api/dev-servers/servers/${id}/logs?lines=${lines}`).then(jsonOrError),
};
