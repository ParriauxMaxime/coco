import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage, gitApi, pathWsId } from '../api.ts';
import type { GitCommit, GitFile, GitPr, GitStatus, WorkWorktree } from '../api.ts';
import { subscribe, topic } from '../live.ts';
import { confirmDialog } from '../components/Dialogs.tsx';
import { pendingClass, useAction } from '../components/action.ts';
import { toast } from '../components/Toast.tsx';
import { DiffCard, WorkspaceCommit } from '../workbench/tabs/Commit.tsx';
import type { TextsOf } from '../workbench/tabs/Commit.tsx';
import { PathLabel, useLocal } from '../workbench/tabs/Code.tsx';
import { isDesktop } from '../workbench/code/code-api.ts';
import { parseChangesTab, workspaceCommitTabId } from '../workbench/code/ids.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import Icon from './Icon.tsx';
import Modal from './Modal.tsx';
import { ago } from './format.ts';
import '../workbench/code/code.css';
import './git.css';

const LETTER: Record<string, [string, string]> = { added: ['A', 'dp-ok'], modified: ['M', 'dp-warn'], removed: ['D', 'dp-bad'], renamed: ['R', 'dp-info'] };
const RELOAD_MS = 300;

export type GitState = { status: GitStatus | null; files: GitFile[] | null; commits: GitCommit[] | null; pr: GitPr | null | undefined; error: string; version: number; reload: (pr?: boolean) => void };

// a workspace's git, live: reloaded on each change the server sees (topic workspace-git), version counting the reloads
export function useGit(wsId: string | null): GitState {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [files, setFiles] = useState<GitFile[] | null>(null);
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [pr, setPr] = useState<GitPr | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const load = useCallback((withPr = false) => {
    if (!wsId) return;
    Promise.all([gitApi.status(wsId), gitApi.diff(wsId), gitApi.commits(wsId)]).then(([s, d, c]) => {
      setStatus(s);
      setFiles(d.files);
      setCommits(c.commits);
      setError('');
      setVersion((v) => v + 1);
    }, (e) => setError(errorMessage(e)));
    gitApi.pr(wsId, withPr).then((r) => setPr(r.pr), () => setPr(null));
  }, [wsId]);
  useEffect(() => {
    if (!wsId) return undefined;
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(topic('workspace-git', wsId), { message: (ev: { type?: string }) => {
      if (ev.type !== 'changed') return;
      clearTimeout(timer);
      timer = setTimeout(() => load(), RELOAD_MS);
    } });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [wsId, load]);
  return { status, files, commits, pr, error, version, reload: load };
}

// the Paseo workspace an agent runs in, from its own record
export function useAgentWorkspace(agentId: string) {
  const [wsId, setWsId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.agentInfo(agentId).then((i) => live && setWsId(i.workspaceId ?? null), () => {});
    return () => { live = false; };
  }, [agentId]);
  return wsId;
}

// a stack row's local worktree, as its workspace (or by path when no Paseo workspace holds it); a work's list is read at most every 30 s
const rowTrees = new Map<string, { at: number; list: Promise<WorkWorktree[]> }>();
export function useRowWorkspace(slug: string, key: string | null) {
  const [wsId, setWsId] = useState<string | null>(null);
  useEffect(() => {
    setWsId(null);
    if (key === null) return undefined;
    let hit = rowTrees.get(slug);
    if (!hit || Date.now() - hit.at > 30000) {
      hit = { at: Date.now(), list: api.worktrees(slug) };
      rowTrees.set(slug, hit);
      hit.list.catch(() => rowTrees.delete(slug));
    }
    let live = true;
    hit.list.then((list) => {
      const tree = list.find((w) => w.key === key);
      if (live && tree) setWsId(tree.workspaceIds[0] ?? pathWsId(tree.path));
    }, () => {});
    return () => { live = false; };
  }, [slug, key]);
  return wsId;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

// branch, ahead/behind its upstream and its base, the PR on it
export function BranchLine({ status, pr }: { status: GitStatus; pr?: GitPr | null }) {
  const vsUp = status.upstream ? `↑${status.ahead ?? 0} ↓${status.behind ?? 0}` : 'not pushed';
  return (
    <span className="gp-branch">
      <Icon name="git-branch" size={12} />
      <code className="dp-ell" title={status.cwd}>{status.branch || 'detached HEAD'}</code>
      <span className={`dp-chip${!status.upstream || status.ahead ? ' dp-tone dp-warn' : ''}`} title={status.upstream ? `against ${status.upstream}: commits to push ↑, to pull ↓` : 'no upstream branch yet'}>{vsUp}</span>
      {status.base && status.aheadBase != null && <span className="dp-chip" title={`against ${status.base}: commits on this branch ↑, new on ${status.base} ↓`}>{status.base} ↑{status.aheadBase} ↓{status.behindBase ?? 0}</span>}
      {pr && <a className={`dp-chip dp-tone ${pr.state === 'merged' ? 'dp-acc' : pr.state === 'open' ? 'dp-ok' : ''}`} href={pr.url} target="_blank" rel="noreferrer" title={pr.title}><Icon name="git-pull-request" size={12} />#{pr.number}{pr.isDraft ? ' draft' : ` ${pr.state}`}</a>}
    </span>
  );
}

function PrDialog({ wsId, initial, onClose, onDone }: { wsId: string; initial: string; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState(initial);
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(true);
  const { busy, run } = useAction();
  const create = () => run('pr', async () => {
    const r = await gitApi.createPr(wsId, { title, body, draft });
    toast.success(r.url ? `PR created: ${r.url}` : 'PR created');
    onDone();
    onClose();
  });
  return (
    <div className="dp dp-float">
      <Modal title="Create a pull request" busy={busy} onClose={onClose} foot={<>
        <button type="button" className="dp-btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className={`dp-btn dp-primary${pendingClass(busy)}`} disabled={busy || !title.trim()} onClick={() => void create()}>{draft ? 'Create draft PR' : 'Create PR'}</button>
      </>}>
        <div className="gp-form">
          <input className="dp-inp" autoFocus value={title} placeholder="Title" aria-label="Title" onChange={(e) => setTitle(e.target.value)} />
          <textarea className="dp-inp dp-cd-ta" rows={8} value={body} placeholder="Description (markdown)" aria-label="Description" onChange={(e) => setBody(e.target.value)} />
          <label className={`gp-tick${draft ? ' dp-on' : ''}`}>
            <input className="dp-vh" type="checkbox" checked={draft} onChange={() => setDraft(!draft)} />
            <span className="dp-check" />Draft
          </label>
          <span className="dp-xs dp-t3">A branch with no upstream is pushed first.</span>
        </div>
      </Modal>
    </div>
  );
}

type PanelProps = { wsId: string; onOpenCommit?: (sha: string) => void };
// a workspace's Changes: branch and actions on top, the changed files with the commit box and the unpushed commits on the side, the picked file's diff
// (or, with no onOpenCommit, an unpushed commit) in the main column. Every write is a click: nothing here runs on its own.
export function GitPanel({ wsId, onOpenCommit }: PanelProps) {
  const git = useGit(wsId);
  const { status, files, commits, pr } = git;
  const desktop = useMemo(isDesktop, []);
  const [sbs, setSbs] = useLocal('cc.sbs', innerWidth >= 1300);
  const [viewed, setViewed] = useState<string | null>(null);
  const [commitShown, setCommitShown] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState('');
  const [prOpen, setPrOpen] = useState(false);
  const { pending, busy, run } = useAction();
  const textsOf = useMemo<TextsOf>(() => (f, wide) => gitApi.texts(wsId, f.filename, f.previous, !wide), [wsId]);

  const list = files ?? [];
  const shown = list.find((f) => f.filename === viewed) ?? list[0] ?? null;
  const names = new Set(list.map((f) => f.filename));
  const chosen = [...picked].filter((p) => names.has(p));
  const withOld = (names: string[]) => names.flatMap((n) => { const f = list.find((x) => x.filename === n); return f?.previous ? [n, f.previous] : [n]; });
  const flip = (p: string) => setPicked((s) => {
    const next = new Set(s);
    next[next.has(p) ? 'delete' : 'add'](p);
    return next;
  });

  const act = (key: string, fn: () => Promise<unknown>, done?: string) => run(key, async () => {
    await fn();
    if (done) toast.success(done);
    git.reload(key === 'push' || key === 'pull');
  });
  const commit = () => act('commit', async () => {
    const r = await gitApi.commit(wsId, message, chosen.length ? withOld(chosen) : undefined);
    setMessage('');
    setPicked(new Set());
    toast.success(`Committed ${r.sha.slice(0, 7)}`);
  });
  const discard = async (names: string[]) => {
    const ok = await confirmDialog({ title: `Discard the changes to ${count(names.length, 'file')}?`, body: <>Restores {names.length === 1 ? <code>{names[0]}</code> : 'them'} to the last commit and deletes new files. This cannot be undone.</>, ok: 'Discard', danger: true });
    if (ok) await act('discard', async () => {
      await gitApi.discard(wsId, withOld(names));
      setPicked(new Set());
    }, `Discarded ${count(names.length, 'file')}`);
  };

  if (git.error && !status) return <div className="dp-empty">{git.error}</div>;
  if (!status || !files || !commits) return <div className="dp-empty">Reading the workspace…</div>;
  const canPush = status.hasRemote && (status.upstream ? (status.ahead ?? 0) > 0 : (status.aheadBase ?? 1) > 0);
  const mineStash = status.stashes.length;
  const openCommit = (sha: string) => (onOpenCommit ? onOpenCommit(sha) : setCommitShown(sha));

  return (
    <div className="gp">
      <div className="gp-bar">
        <BranchLine status={status} pr={pr} />
        <span className="dp-sp" />
        <button type="button" className={`dp-btn dp-sm${pendingClass(pending === 'pull')}`} disabled={busy || !status.upstream} title={status.upstream ? `Pull from ${status.upstream} (fast-forward)` : 'No upstream to pull from'} onClick={() => void act('pull', () => gitApi.pull(wsId), 'Pulled')}><Icon name="download" size={12} />Pull</button>
        <button type="button" className={`dp-btn dp-sm${pendingClass(pending === 'push')}`} disabled={busy || !canPush} title={!status.hasRemote ? 'No remote' : status.upstream ? `Push ${count(status.ahead ?? 0, 'commit')} to ${status.upstream}` : 'Push the branch and set its upstream'} onClick={() => void act('push', () => gitApi.push(wsId), 'Pushed')}><Icon name="upload" size={12} />Push{status.ahead ? ` ${status.ahead}` : ''}</button>
        {pr === null && status.hasRemote && status.branch && <button type="button" className="dp-btn dp-sm" disabled={busy} title="Open a pull request for this branch" onClick={() => setPrOpen(true)}><Icon name="git-pull-request" size={12} />Create PR</button>}
        <button type="button" className={`dp-btn dp-sm dp-ghost${pendingClass(pending === 'stash')}`} disabled={busy || !status.dirty} title="Set the uncommitted changes aside (git stash, new files included)" onClick={() => void act('stash', () => gitApi.stash(wsId, 'save'), 'Stashed')}><Icon name="archive" size={12} />Stash</button>
        {mineStash > 0 && <button type="button" className={`dp-btn dp-sm dp-ghost${pendingClass(pending === 'pop')}`} disabled={busy} title={`Bring back the newest stash of this branch: ${status.stashes[0].message}`} onClick={() => void act('pop', () => gitApi.stash(wsId, 'pop'), 'Stash popped')}>Pop stash{mineStash > 1 ? ` (${mineStash})` : ''}</button>}
        <button type="button" className="dp-ibtn" title={`Read again (${status.via === 'paseo' ? 'through Paseo' : 'through git'})`} onClick={() => git.reload(true)}><Icon name="refresh" size={14} /></button>
      </div>
      <div className="gp-body">
        <aside className="gp-side">
          <div className="gp-sec-t">
            <span>Changes</span>
            <span className="dp-count">{list.length}</span>
            <span className="dp-sp" />
            {chosen.length > 0 && <button type="button" className="dp-linkbtn dp-danger" disabled={busy} onClick={() => void discard(chosen)}>Discard {chosen.length}</button>}
            {list.length > 0 && <button type="button" className="dp-linkbtn" onClick={() => setPicked(chosen.length === list.length ? new Set() : new Set(list.map((f) => f.filename)))}>{chosen.length === list.length ? 'Pick none' : 'Pick all'}</button>}
          </div>
          {list.length === 0 && <div className="gp-none">The working tree is clean.</div>}
          <div className="gp-files">
            {list.map((f) => {
              const [letter, tone] = LETTER[f.status] ?? ['M', 'dp-warn'];
              const on = picked.has(f.filename);
              return (
                <div key={f.filename} className={`gp-file${shown?.filename === f.filename && !commitShown ? ' dp-on' : ''}`}>
                  <label className={`gp-pick${on ? ' dp-on' : ''}`} title="Pick for the commit or the discard">
                    <input className="dp-vh" type="checkbox" checked={on} onChange={() => flip(f.filename)} />
                    <span className="dp-check" />
                  </label>
                  <button type="button" className="gp-file-b" title={f.previous ? `${f.previous} → ${f.filename}` : f.filename} onClick={() => { setViewed(f.filename); setCommitShown(null); }}>
                    <span className={`gp-st ${tone}`}>{letter}</span>
                    <span className="gp-path"><PathLabel path={f.filename} /></span>
                    <span className="gp-num"><span className="dp-add">+{f.additions}</span> <span className="dp-del">−{f.deletions}</span></span>
                  </button>
                  <button type="button" className="dp-ibtn gp-x" title="Discard this file's changes" disabled={busy} onClick={() => void discard([f.filename])}><Icon name="trash" size={12} /></button>
                </div>
              );
            })}
          </div>
          {list.length > 0 && (
            <div className="gp-commit">
              <textarea className="dp-inp dp-cd-ta" rows={3} value={message} placeholder="Commit message (⌘↵ commits)" aria-label="Commit message" onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && message.trim() && !busy && void commit()} />
              <button type="button" className={`dp-btn dp-sm dp-primary${pendingClass(pending === 'commit')}`} disabled={busy || !message.trim()} title={chosen.length ? 'Stage and commit the picked files only' : 'Stage every change and commit'} onClick={() => void commit()}><Icon name="check" size={12} />{chosen.length ? `Commit ${count(chosen.length, 'file')}` : 'Commit all'}</button>
            </div>
          )}
          <div className="gp-sec-t">
            <span>Unpushed commits</span>
            <span className="dp-count">{commits.length}</span>
          </div>
          {commits.length === 0 && <div className="gp-none">{status.upstream ? `Everything is on ${status.upstream}.` : 'None.'}</div>}
          {commits.length >= 50 && <div className="gp-none">The 50 newest only.</div>}
          <div className="gp-commits">
            {commits.map((c) => (
              <button key={c.sha} type="button" className={`gp-cm${commitShown === c.sha ? ' dp-on' : ''}`} title={`${c.subject}\n${c.author} · ${c.date}`} onClick={() => openCommit(c.sha)}>
                <code>{c.shortSha}</code>
                <span className="dp-ell">{c.subject}</span>
                <span className="dp-xs dp-t3">{ago(c.date)}</span>
              </button>
            ))}
          </div>
        </aside>
        <main className="gp-main">
          {commitShown ? <WorkspaceCommit key={commitShown} wsId={wsId} sha={commitShown} onBack={() => setCommitShown(null)} />
            : shown ? (
              <div className="gp-diff">
                <DiffCard key={shown.filename} scope={`ws:${wsId}`} file={shown} textsOf={textsOf} version={git.version} desktop={desktop} sbs={sbs}
                  aside={desktop && <button type="button" className={`dp-btn dp-sm dp-ghost${sbs ? ' dp-on' : ''}`} onClick={() => setSbs(!sbs)}><Icon name="columns" size={12} />Side by side</button>} />
              </div>
            ) : <div className="dp-empty">No uncommitted change.</div>}
        </main>
      </div>
      {prOpen && <PrDialog wsId={wsId} initial={commits[0]?.subject || status.branch || ''} onClose={() => setPrOpen(false)} onDone={() => git.reload(true)} />}
    </div>
  );
}

// in a work's tabs, an unpushed commit opens as its own tab next to the panel
export const openWorkspaceCommit = (wsId: string) => (sha: string) => {
  const s = useWorkbench.getState();
  s.open(workspaceCommitTabId(wsId, sha), { group: s.otherGroup() });
};

// git-<workspace id>: a workspace's Changes panel as a tab (opened from a PR row's inspector)
export function ChangesTab({ tabId }: { tabId: string }) {
  const wsId = parseChangesTab(tabId);
  return wsId ? <div className="dp-tabview gp-tab"><GitPanel wsId={wsId} onOpenCommit={openWorkspaceCommit(wsId)} /></div> : <div className="dp-empty">Unknown workspace.</div>;
}

// the inspector's line for a PR row with a worktree: branch, counts, and the panel in a tab
export function GitSummary({ wsId, onOpen }: { wsId: string; onOpen: () => void }) {
  const { status, files, commits, pr, error } = useGit(wsId);
  if (error && !status) return <div className="dp-t3 dp-xs">{error}</div>;
  if (!status || !files || !commits) return <div className="dp-t3 dp-xs">Reading the worktree…</div>;
  return (
    <div className="gp-sum">
      <BranchLine status={status} pr={pr} />
      <div className="dp-row dp-g4 dp-xs">
        <span className={files.length ? '' : 'dp-t3'}>{files.length ? count(files.length, 'uncommitted file') : 'clean'}</span>
        <span className="dp-t3">·</span>
        <span className={commits.length ? '' : 'dp-t3'}>{count(commits.length, 'unpushed commit')}</span>
        <span className="dp-sp" />
        <button type="button" className="dp-btn dp-sm" onClick={onOpen}><Icon name="git-merge" size={12} />Open changes</button>
      </div>
    </div>
  );
}
