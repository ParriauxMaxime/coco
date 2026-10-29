import React, { useEffect } from 'react';
import { api, errorMessage } from '../../api.ts';
import { topic } from '../../live.ts';
import { useResource } from '../../resource.ts';
import { isLive, jobOf, useJobs } from '../../jobs.ts';
import type { DriftAction, DriftHead, DriftItem, DriftResponse, Job } from '../../types.ts';
import Icon from '../../preview/Icon.tsx';
import type { IconName } from '../../preview/Icon.tsx';
import { JobButton } from '../../components/JobButton.tsx';
import { toast } from '../../components/Toast.tsx';
import { useWorkbench } from '../workbench-store.ts';
import '../../components/parts.css';

const POLL_MS = 60000;
const label = (key: DriftItem['key']) => (key == null ? '' : /^b:/.test(String(key)) ? String(key).slice(2) : `#${key}`);

// the job an item's action starts, as the server keys it
const actionOf = (it: DriftItem, a: DriftAction) => (a.type === 'run' ? `drift:${it.id}` : a.type === 'dispatch' ? (a.persona ? `${a.entry}:${a.persona}` : a.entry) : null);

// the jobs of each work seen live, and those seen ending: one fresh read per job that ends while a view of the work is open
const seenJobs = new Map<string, { live: Set<string>; ended: Set<string> }>();
const endedNow = (slug: string, jobs: Job[]) => {
  const seen = seenJobs.get(slug) ?? { live: new Set<string>(), ended: new Set<string>() };
  seenJobs.set(slug, seen);
  let ended = false;
  for (const j of jobs) {
    if (isLive(j)) seen.live.add(j.id);
    else if (seen.live.has(j.id) && !seen.ended.has(j.id)) { seen.ended.add(j.id); ended = true; }
  }
  return ended;
};

function useDrift(slug: string) {
  const drift = useResource<DriftResponse>(`/api/works/${slug}/drift`, () => api.drift(slug), { poll: POLL_MS, topics: [topic('work', slug)] });
  const data = drift.data ?? null;
  const jobs = useJobs(slug);
  // a job of this work that ended may have fixed an item
  useEffect(() => { if (endedNow(slug, jobs)) void drift.reload(() => api.drift(slug, true)).catch(() => {}); }, [slug, jobs]);

  const go = (it: DriftItem, a: DriftAction) => {
    if (a.type === 'copy') return void navigator.clipboard?.writeText(a.command).then(() => toast.success(`Copied: ${a.command}`));
    if (a.type === 'tab') return useWorkbench.getState().open(a.tab);
    const started = a.type === 'run' ? api.driftRun(slug, it.id, a.command) : api.dispatch(slug, { entry: a.entry, key: it.key, ...(a.persona ? { persona: a.persona } : {}) });
    return void started.catch((e) => toast.error(errorMessage(e)));
  };
  // a copy or tab action is a plain button; a run or dispatch stands for its job
  const button = (it: DriftItem, a: DriftAction | null | undefined, primary: boolean) => {
    if (!a) return null;
    const action = actionOf(it, a);
    const title = a.type === 'run' || a.type === 'copy' ? a.command : it.text;
    if (!action) return <button key={a.label} type="button" className={`dp-btn dp-sm${primary ? ' dp-primary' : ''}`} title={title} onClick={() => go(it, a)}>{a.label}</button>;
    return <JobButton key={a.label} job={jobOf(jobs, it.key, action)} label={a.label} primary={primary} title={title} onRun={() => go(it, a)} />;
  };
  return { data, button };
}

const plural = (n = 0) => `${n} commit${n === 1 ? '' : 's'}`;
const HEAD_BADGE: Record<DriftHead['state'], { tone: string; icon: IconName; text: (h: DriftHead) => string }> = {
  pushed: { tone: 'dp-ok', icon: 'check', text: () => 'Pushed: GitHub has the local head' },
  ahead: { tone: 'dp-warn', icon: 'upload', text: (h) => `${plural(h.count)} not pushed` },
  behind: { tone: 'dp-info', icon: 'download', text: (h) => `GitHub is ${plural(h.count)} ahead of the local branch` },
  diverged: { tone: 'dp-bad', icon: 'alert-triangle', text: () => 'Local branch and GitHub diverged: rebase or reset it before pushing' },
  remote: { tone: '', icon: 'git-branch', text: () => 'On GitHub only: no local branch' },
};

const TIDY_RED = 15;
const commitsTone = (n: number) => (n >= TIDY_RED ? 'dp-bad' : n > 5 ? 'dp-warn' : 'dp-ok');

// the PR's local head against GitHub with the push one click away, and its own commits with a tidy once there are too many
export function HeadBadges({ slug, prKey }: { slug: string; prKey: string }) {
  const { data, button } = useDrift(slug);
  const head = data?.heads?.find((h) => String(h.key) === prKey);
  if (!head) return null;
  const badge = HEAD_BADGE[head.state];
  const push = data?.drift.find((i) => i.id === `${prKey}:unpushed`);
  const tidy = data?.drift.find((i) => i.id === `${prKey}:history`);
  return (
    <div className="dp-push-strip">
      <div className={`dp-push ${badge.tone}`}>
        <div className="dp-push-row">
          <Icon name={badge.icon} size={16} />
          <span className="dp-grow">{badge.text(head)}</span>
          {push && button(push, push.also, false)}
          {push && button(push, push.action, true)}
        </div>
      </div>
      {head.commits !== undefined && (
        <div className={`dp-push dp-push-commits ${commitsTone(head.commits)}`} title="Commits of this PR on top of its base">
          <div className="dp-push-row">
            <Icon name="git-fork" size={16} />
            <span className="dp-grow">{plural(head.commits)}</span>
            {tidy && button(tidy, tidy.action, true)}
          </div>
        </div>
      )}
    </div>
  );
}

// the kit step's actions: redo a stale piece, make a missing one in scope
export function KitRedo({ slug, prKey }: { slug: string; prKey: string }) {
  const { data, button } = useDrift(slug);
  const items = [...(data?.drift || []), ...(data?.next || [])].filter((i) => String(i.key) === prKey && i.kind.startsWith('kit-') && i.action);
  return <>{items.map((it) => button(it, it.action, true))}</>;
}

// what drifted on the work's PRs and the next steps that follow; every button is a click of yours, nothing runs by itself
export default function DriftPanel({ slug }: { slug: string }) {
  const { data, button } = useDrift(slug);
  const rows = [...(data?.drift || []), ...(data?.next || [])];
  if (!rows.length) return null;
  const line = (it: DriftItem) => (
    <div key={it.id} className="dp-kl">
      {it.key != null && <span className="dp-chip">{label(it.key)}</span>}
      <span className="dp-grow">{it.text}</span>
      {button(it, it.also, false)}
      {button(it, it.action, it.action?.type === 'run')}
    </div>
  );
  return (
    <div className="dp-block">
      <div className="dp-h2">Drift<span className="dp-meta">{data?.drift.length ? `${data.drift.length} to fix` : 'next steps'}</span></div>
      {data?.drift.map(line)}
      {data && data.next.length > 0 && <div className="dp-xs dp-t3" style={{ margin: '6px 0 2px' }}>Suggested next steps</div>}
      {data?.next.map(line)}
    </div>
  );
}
