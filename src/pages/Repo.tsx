import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import Ask, { addRepoAndOpen } from './Ask.tsx';
import { useConfig } from '../config.ts';
import Rules from '../components/Rules.tsx';
import { WorkBar } from '../components/Sidebar.tsx';
import { stateKey, stateLabel } from '../components/PrBadge.tsx';
import type { RepoPage, WorkProgress } from '../types.ts';

type RepoWork = RepoPage['works'][number];

function WorkCard({ w }: { w: RepoWork }) {
  const p: Partial<WorkProgress> = w.progress || {};
  return (
    <a className="card work-card" href={`#/work/${w.slug}`}>
      <b>{w.title}</b>
      <WorkBar w={w} />
      <span className={`work-next ${w.next ? '' : 'none'}`}>{w.next || 'No what’s next yet'}</span>
      {(p.attention || p.restack) && (
        <span className="row" style={{ gap: 6 }}>
          {p.attention && <span className="chip c-red">changes requested or CI failing</span>}
          {p.restack && <span className="chip c-orange" title="a parent PR merged: its children still sit on the old base">restack</span>}
        </span>
      )}
    </a>
  );
}

const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// a bare work in this repo; its Paseo project and plan worktree come with its first agent
function NewWork({ repo, onCancel }: { repo: string; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');
  const create = async () => {
    const s = slug || slugOf(title);
    try {
      await api.createWork({ slug: s, title: title.trim(), repo, stack: [], links: [] });
      location.hash = `#/work/${s}`;
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="card">
      <form className="ritual" onSubmit={(e) => { e.preventDefault(); if (title.trim()) create(); }}>
        <label>Title<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="CSV export of invoices" /></label>
        <label>Slug<input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={slugOf(title) || 'csv-export'} /></label>
        <div className="row">
          <button className="primary" type="submit" disabled={!title.trim()}>Create</button>
          <button type="button" onClick={onCancel}>Cancel</button>
          <span className="status danger">{error}</span>
        </div>
      </form>
      <p className="sub" style={{ margin: '8px 0 0' }}>Or describe it to this repo’s Ask coco below: it proposes a full scaffold (stack, personas, open questions) you apply.</p>
    </div>
  );
}

// a GitHub slug or a local clone becomes a repo of coco
export function NewRepo() {
  const cloneDir = useConfig((s) => s.cloneDir);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async () => {
    setBusy(true);
    setError('');
    await addRepoAndOpen(() => api.addRepo(source.trim())).catch((e) => setError(errorMessage(e)));
    setBusy(false);
  };
  return (
    <>
      <h1>New repo</h1>
      <p className="sub">A GitHub slug is looked for among the clones in <code>{cloneDir || 'the clone folder'}</code> by their origin remote, and cloned there with <code>gh</code> when none matches. coco then lists the repo in your config, adds its Paseo project and starts a setup run that proposes its config. The global Ask coco can add one too.</p>
      <div className="card">
        <form className="ritual" onSubmit={(e) => { e.preventDefault(); if (source.trim() && !busy) add(); }}>
          <label>GitHub slug or folder<input autoFocus value={source} onChange={(e) => setSource(e.target.value)} placeholder="acme/widgets or ~/code/widgets" /></label>
          <div className="row">
            <button className="primary" type="submit" disabled={!source.trim() || busy}>{busy ? 'Adding…' : 'Add repo'}</button>
            <span className="status danger">{error}</span>
          </div>
        </form>
      </div>
    </>
  );
}

// a repo: its works board, a new work, its Ask coco, the PRs no work holds, then its lessons and rules
export default function Repo({ id }: { id: string }) {
  const [data, setData] = useState<RepoPage | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const load = (fresh = false) => api.repo(id, fresh).then(setData, (e) => setErr(errorMessage(e)));
  useEffect(() => {
    load();
  }, [id]);
  if (err) return <div className="card danger">{err}</div>;
  if (!data) return <div className="sub">Loading…</div>;
  const refresh = () => {
    setRefreshing(true);
    load(true).finally(() => setRefreshing(false));
  };
  return (
    <>
      <h1>{data.name}</h1>
      <p className="sub">{data.github || 'no GitHub slug'} · {data.defaultBranch} · <code>{data.path}</code></p>

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Works</h2>
        <span className="row">
          {data.archivedCount > 0 && <a className="status" href="#/archive">{data.archivedCount} archived</a>}
          {!creating && <button className="primary sm" onClick={() => setCreating(true)}>New work</button>}
        </span>
      </div>
      {creating && <NewWork repo={data.id} onCancel={() => setCreating(false)} />}
      <div className="grid">{data.works.map((w) => <WorkCard key={w.slug} w={w} />)}</div>
      {data.works.length === 0 && <div className="card"><span className="sub">No work in {data.name} yet.</span></div>}

      <h2>Ask coco</h2>
      <Ask repoId={data.id} repoName={data.name} />

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Loose PRs</h2>
        <button className="sm" onClick={refresh} disabled={refreshing} title="Ask GitHub again">↻</button>
      </div>
      <p className="sub">Your open PRs on {data.github || data.name} that no work holds.</p>
      <div className="card">
        {data.loose.error && <div className="status danger">{data.loose.error}</div>}
        {data.loose.prs.map((pr) => (
          <div key={pr.number} className="list-item row">
            <a className={`pr-badge st-${stateKey(pr)}`} href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a>
            <span style={{ flex: 1 }}>{pr.title}</span>
            <span className={`chip st-chip st-${stateKey(pr)}`}>{stateLabel(pr)}</span>
            <span className="status">{pr.updatedAt.slice(0, 10)}</span>
          </div>
        ))}
        {!data.loose.error && data.loose.prs.length === 0 && <span className="sub">None: every open PR of yours belongs to a work.</span>}
      </div>

      <h2>Lessons</h2>
      <p className="sub">What agent briefs in this repo learned from your mid-run corrections.</p>
      <div className="card">
        {data.lessons.map((l, i) => <div key={i} className="list-item">{l.text}{l.at && <span className="status"> · {l.at.slice(0, 10)}</span>}</div>)}
        {data.lessons.length === 0 && <span className="sub">No lesson yet.</span>}
      </div>

      <h2>Rules</h2>
      {data.ruleFiles.length > 0 && <p className="sub">Agents read the repo’s own rules first: {data.ruleFiles.map((f, i) => <React.Fragment key={f}>{i > 0 && ', '}<code>{f}</code></React.Fragment>)}. The ledger below applies in every repo.</p>}
      <Rules />
    </>
  );
}
