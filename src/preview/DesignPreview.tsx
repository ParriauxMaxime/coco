import React, { useEffect, useMemo, useState } from 'react';
import { WorkbenchView } from '../workbench/Workbench.tsx';
import { useWorkbench } from '../workbench/workbench-store.ts';
import { WorkContext } from '../workbench/use-work.ts';
import { api } from '../api.ts';
import Icon from './Icon.tsx';
import Inspector from './Inspector.tsx';
import { PreviewContext, previewTabDef } from './tabs.tsx';
import LayoutMenu, { useWorkLayouts } from './LayoutMenu.tsx';
import { applyLayout } from './layouts.ts';
import { usePrefs } from './prefs.ts';
import type { PrefKey } from './prefs.ts';
import { prKey, prState, prTitle, usePreviewData } from './data.ts';
import type { PreviewData } from './data.ts';
import { prLabel, useAgentList } from './agents.ts';
import Shell, { VIEWS, WorkViews, useNarrow } from './Shell.tsx';
import type { Command } from './Shell.tsx';
import type { WorkSummary } from '../types.ts';

const open = (id: string) => useWorkbench.getState().open(id);

function Bench({ d, slug }: { d: PreviewData & { work: { w: NonNullable<PreviewData['work']['w']> } }; slug: string }) {
  const prefs = usePrefs();
  const groups = useWorkbench((s) => (s.slug === slug ? s.groups : []));
  const [selected, setSelected] = useState<string | null>(() => {
    const first = d.prs.find((p) => !['merged', 'closed'].includes(prState(p))) || d.prs[0];
    return first ? prKey(first) : null;
  });
  const [inspector, setInspector] = useState(true);
  const [repo, setRepo] = useState<string | null>(null);
  const narrow = useNarrow();
  const layouts = useWorkLayouts(slug);

  const ov = d.overview;
  const summary = ov?.works.find((w) => w.slug === slug);
  const repoId = repo || summary?.repo || ov?.repos.find((r) => r.works.includes(slug))?.id || null;
  const repoName = ov?.repos.find((r) => r.id === repoId)?.name;
  const tabDetails = narrow || prefs.shell === 'C' || prefs.details === 'tab';
  const showInspector = !tabDetails && inspector;
  const waiting = d.pending.filter((p) => !p.where || p.where.href.includes(slug));
  const counts = useMemo(() => {
    const by: Record<string, number> = {};
    d.prs.forEach((p) => { const s = prState(p); by[s] = (by[s] || 0) + 1; });
    return by;
  }, [d.prs]);
  const ciRun = d.prs.filter((p) => p.ci === 'pending').length;
  const ciBad = d.prs.filter((p) => p.ci === 'failure').length;
  const openFindings = (d.findings?.rows || []).filter((f) => f.status === 'open').length;
  const tabCount: Record<string, number | undefined> = { stack: d.prs.length, findings: openFindings || undefined, decisions: (d.work.w.decisions || []).length || undefined };
  const agents = useAgentList(slug) || [];

  const openPr = (key: string) => {
    setSelected(key);
    if (tabDetails) open(`pr-${key}`);
    else setInspector(true);
  };
  const split = () => {
    const s = useWorkbench.getState();
    const tab = s.groups.find((g) => g.id === s.focused)?.active;
    if (tab) s.moveToOtherGroup(tab);
  };

  const commands: Command[] = [
    ...VIEWS.map((v) => ({ id: `v-${v.id}`, label: v.label, hint: 'view', icon: v.icon, run: () => open(v.id) })),
    { id: 'new-agent', label: 'New agent', hint: 'agents', icon: 'bot', run: () => open('ask') },
    ...d.prs.map((p) => ({ id: `new-agent-${prKey(p)}`, label: `New agent on ${p.number ? `#${p.number}` : prLabel(prKey(p))} ${prTitle(p)}`, hint: 'agents', icon: 'bot' as const, run: () => open(`ask-new-${prKey(p)}`) })),
    ...agents.map((a) => ({ id: `agent-${a.id}`, label: `Agent: ${a.title}`, hint: a.status, icon: 'bot' as const, run: () => open(a.id) })),
    ...layouts.list.map((l, i) => ({ id: `l-${l.id}`, label: `Layout: ${l.name}`, hint: i < 9 ? `⌥${i + 1}` : 'layout', icon: 'columns' as const, run: () => applyLayout(l) })),
    { id: 'split', label: 'Move the tab to the other pane', hint: '⌘\\', icon: 'columns', run: split },
    ...d.prs.map((p) => ({ id: `pr-${prKey(p)}`, label: `${p.number ? `#${p.number}` : 'planned'} ${prTitle(p)}`, hint: prState(p), icon: 'git-pull-request' as const, run: () => openPr(prKey(p)) })),
    ...d.prs.filter((p) => p.number).map((p) => ({ id: `review-${p.number}`, label: `Review #${p.number} ${prTitle(p)}`, hint: 'code', icon: 'file' as const, run: () => open(`review-${p.number}`) })),
  ];

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'i' && !tabDetails) { e.preventDefault(); setInspector((x) => !x); }
      if (mod && e.key === 'Enter' && selected) { e.preventDefault(); open(`pr-${selected}`); }
      const n = e.altKey && !mod && /^Digit([1-9])$/.exec(e.code);
      if (n && layouts.list[Number(n[1]) - 1]) { e.preventDefault(); applyLayout(layouts.list[Number(n[1]) - 1]); }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  });

  const views = (w: WorkSummary) => w.slug !== slug ? <WorkViews w={w} /> : (
    <WorkViews w={w} open={open} isOpen={(id) => groups.some((g) => g.tabs.includes(id))} count={(id) => tabCount[id]} prs={d.prs} />
  );
  const openPrs = d.prs.filter((p) => p.number && !['merged', 'closed'].includes(prState(p)));

  return (
    <PreviewContext.Provider value={{ d, selected, select: setSelected, openPr }}>
      <Shell
        ov={ov}
        root="work"
        slug={slug}
        crumbs={[...(repoName ? [{ label: repoName, href: repoId ? `#/repo/${repoId}` : undefined }] : []), { label: d.work.w.title }]}
        attention={waiting.length > 0}
        titleRight={(
          <>
            <LayoutMenu slug={slug} />
            <span className="dp-sep-v" style={{ margin: '0 4px' }} />
            {!tabDetails && <button type="button" className={`dp-ibtn dp-lg${showInspector ? ' dp-on' : ''}`} title="Inspector  ⌘I" onClick={() => setInspector((x) => !x)}><Icon name="panel-right" /></button>}
          </>
        )}
        views={views}
        repo={repoId}
        onRepo={setRepo}
        sidebarExtra={prefs.shell === 'C' && repoId === summary?.repo && (
          <>
            <div className="dp-sb-group"><Icon name="git-pull-request" size={14} />Open PRs<span className="dp-count" style={{ marginLeft: 4 }}>{openPrs.length}</span></div>
            {openPrs.map((p) => (
              <div key={prKey(p)} className={`dp-view${selected === prKey(p) ? ' dp-open' : ''}`} style={{ paddingLeft: 8 }} onClick={() => openPr(prKey(p))}>
                <span className={`dp-prb dp-st-${prState(p)}${p.ci === 'failure' ? ' dp-ci-bad' : p.ci === 'pending' ? ' dp-ci-run' : ''}`}><Icon name="git-pull-request" size={12} />#{p.number}</span>
                <span className="dp-ell">{prTitle(p)}</span>
              </div>
            ))}
          </>
        )}
        status={(
          <>
            <span className="dp-sbi"><span className="dp-dot dp-live" />GitHub synced {new Date(d.work.w.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span className="dp-sbi" onClick={() => open('stack')}><Icon name="git-pull-request" />{d.prs.length - (counts.merged || 0) - (counts.closed || 0) - (counts.planned || 0)} open · {counts.merged || 0} merged · {counts.planned || 0} planned</span>
            {summary?.progress.restack && <span className="dp-sbi" style={{ color: 'var(--dp-warn)' }}><Icon name="git-branch" />Restack needed</span>}
            {(ciRun > 0 || ciBad > 0) && <span className="dp-sbi"><Icon name="circle-dot" />CI{ciRun > 0 && ` ${ciRun} running`}{ciRun > 0 && ciBad > 0 && <span className="dp-t4">·</span>}{ciBad > 0 && <span className="dp-ci-bad">{ciBad} failing</span>}</span>}
          </>
        )}
        statusRight={(
          <>
            <span className="dp-sbi">Layout: {layouts.current?.name || 'unsaved'}</span>
            <span className="dp-sbi" onClick={split}><kbd>⌘</kbd><kbd>\</kbd>Other pane</span>
          </>
        )}
        commands={commands}
        onWaitingTab={() => open('waiting')}
      >
        <div className="dp-wb"><WorkbenchView slug={slug} data={d.work} defs={previewTabDef} /></div>
        {showInspector && <Inspector d={d} prKey={selected} onClose={() => setInspector(false)} />}
      </Shell>
    </PreviewContext.Provider>
  );
}

export default function DesignPreview({ slug }: { slug?: string }) {
  useEffect(() => {
    if (slug) return;
    api.overview().then((ov) => {
      const first = ov.repos.flatMap((r) => r.works).map((s) => ov.works.find((w) => w.slug === s)).find((w) => w && !w.archived && w.stack > 0);
      if (first) history.replaceState(null, '', `#/work/${first.slug}`), dispatchEvent(new HashChangeEvent('hashchange'));
    }, () => {});
  }, [slug]);
  if (!slug) return <div className="dp"><div className="dp-empty">Loading your works…</div></div>;
  return <Loaded key={slug} slug={slug} />;
}

function Loaded({ slug }: { slug: string }) {
  const d = usePreviewData(slug);
  const { w } = d.work;
  if (!w) return <div className="dp"><div className="dp-empty">{d.work.err || 'Loading the work…'}</div></div>;
  const work = { ...d.work, w };
  return (
    <WorkContext.Provider value={work}>
      <Bench d={{ ...d, work }} slug={slug} />
    </WorkContext.Provider>
  );
}

export type { PrefKey };
