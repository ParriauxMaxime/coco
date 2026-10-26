import React, { createContext, useContext, useState } from 'react';
import { PendingPermissions, usePendingPermissions } from './chat/Permission.tsx';
import RulesLedger from './widgets/Rules.tsx';
import { Empty } from './pages/Page.tsx';
import './widgets/widgets.css';
import { tabDef } from '../workbench/tabs/index.ts';
import type { TabDef } from '../workbench/tabs/index.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import { useWork } from '../workbench/use-work.ts';
import { AskAgentTab, NewAgentTab, PaseoAgentTab, newAgentPr } from './AgentTab.tsx';
import { AgentDot } from './AgentsSection.tsx';
import { agentOf, prLabel, stateOf, useWorkAgent } from './agents.ts';
import Icon from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import StackView from './StackView.tsx';
import Inspector from './Inspector.tsx';
import OverviewView from './OverviewView.tsx';
import FindingsView from './FindingsView.tsx';
import NotesView from './NotesView.tsx';
import ArtifactsView from './ArtifactsView.tsx';
import type { PreviewData } from './data.ts';

export type PreviewCtx = { d: PreviewData; selected: string | null; select: (key: string) => void; openPr: (key: string) => void };

export const PreviewContext = createContext<PreviewCtx | null>(null);
const usePreview = (): PreviewCtx => {
  const ctx = useContext(PreviewContext);
  if (!ctx) throw new Error('usePreview outside the new workbench');
  return ctx;
};

const open = (id: string) => useWorkbench.getState().open(id);

function OverviewTab() {
  const { d, openPr } = usePreview();
  return <div className="dp-tabview"><OverviewView d={d} onOpenPr={openPr} onOpenTab={open} /></div>;
}
function StackTab() {
  const { d, selected, select } = usePreview();
  return <div className="dp-tabview"><StackView d={d} selected={selected} onSelect={select} onOpen={(key) => open(`pr-${key}`)} /></div>;
}
function FindingsTab() {
  const { d, openPr } = usePreview();
  return <div className="dp-tabview"><FindingsView d={d} onOpenPr={openPr} onReload={() => { d.work.load(); }} /></div>;
}
function NotesTab() {
  const { d } = usePreview();
  return <div className="dp-tabview"><NotesView d={d} /></div>;
}
function ArtifactsTab({ group }: { group: number }) {
  const { d } = usePreview();
  return <div className="dp-tabview"><ArtifactsView d={d} onView={(name) => useWorkbench.getState().open(`artifact-${name}`, { preview: true, group })} /></div>;
}
function PrTab({ tabId }: { tabId: string }) {
  const { d } = usePreview();
  return <div className="dp-tabview"><Inspector d={d} prKey={tabId.slice(3)} asTab /></div>;
}
const WaitingTab = () => <PendingPermissions withWhere />;

const Doc = ({ children }: { children: React.ReactNode }) => <div className="dp-tabview"><div className="dp-doc"><div className="dp-doc-in">{children}</div></div></div>;
function RulesTab() {
  return <Doc><RulesLedger slug={useWork().slug} /></Doc>;
}
const TL_TONE: Record<string, string> = { github: 'dp-info', coco: 'dp-acc', review: 'dp-acc', decision: 'dp-ok' };
function TimelineTab() {
  const { w, addNote } = useWork();
  const [note, setNote] = useState('');
  const add = async () => { await addNote(note); setNote(''); };
  const list = w.timeline || [];
  return (
    <Doc>
      <form className="dp-row dp-g6 dp-tl-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input className="dp-inp dp-grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened…" aria-label="Timeline note" />
        <button type="submit" className="dp-btn dp-primary"><Icon name="plus" size={14} />Add</button>
      </form>
      {list.length ? (
        <div className="dp-rows">
          {list.map((t, i) => (
            <div key={i} className="dp-rowi dp-tl-row">
              <span className={`dp-chip ${TL_TONE[t.kind] || ''}`}>{t.kind}</span>
              <span className="dp-grow">{t.text}</span>
              <span className="dp-rowi-m dp-num">{t.ts.slice(0, 16).replace('T', ' ')}</span>
            </div>
          ))}
        </div>
      ) : <Empty icon="history">Nothing on the timeline yet.</Empty>}
    </Doc>
  );
}

function AgentTabIcon({ id }: { id: string }) {
  const agent = useWorkAgent(useWork().slug, id);
  const { pending } = usePendingPermissions();
  return agent ? <AgentDot state={stateOf(agent, pending)} /> : <Icon name="bot" size={14} />;
}
const agentTitle = (slug: string, id: string) => agentOf(slug, id)?.title || 'Agent';

const VIEWS: Record<string, TabDef> = {
  plan: { title: () => 'Overview', Component: OverviewTab, flush: true },
  stack: { title: (c) => `Stack (${c.prs.length})`, Component: StackTab, flush: true },
  findings: { title: () => 'Findings', Component: FindingsTab, flush: true },
  notes: { title: () => 'Notes', Component: NotesTab, flush: true },
  artifacts: { title: (c) => `Artifacts (${c.w.artifacts.length})`, Component: ArtifactsTab, flush: true },
  waiting: { title: () => 'Waiting on you', Component: WaitingTab },
  ask: { title: () => 'New agent', Component: NewAgentTab, flush: true },
  rules: { title: () => 'Rules', Component: RulesTab, flush: true },
  timeline: { title: (c) => `Timeline (${(c.w.timeline || []).length})`, Component: TimelineTab, flush: true },
};

const agentDef = (id: string): TabDef | null => {
  const pr = newAgentPr(id);
  if (pr) return { title: () => `New agent ${prLabel(pr)}`, Component: NewAgentTab, flush: true };
  if (!id.startsWith('ask-') && !id.startsWith('ag-')) return null;
  return { title: (c) => agentTitle(c.slug, id), Component: id.startsWith('ag-') ? PaseoAgentTab : AskAgentTab, flush: true, icon: <AgentTabIcon id={id} /> };
};

const ICONS: [RegExp, IconName][] = [
  [/^plan$/, 'home'], [/^stack$/, 'list'], [/^findings/, 'flag'], [/^waiting$/, 'inbox'], [/^pr-/, 'git-pull-request'],
  [/^ask(-new-.*)?$/, 'bot'], [/^decisions$/, 'scale'], [/^timeline$/, 'history'], [/^notes$/, 'notebook'], [/^artifacts$/, 'folder'],
  [/^rules$/, 'scale'], [/^review-/, 'eye'], [/^(diff|file|artifact)-/, 'file'], [/^(brief|agent)-/, 'bot'], [/^stack-/, 'git-branch'],
];

export function previewTabDef(id: string): TabDef {
  const def = VIEWS[id] || agentDef(id) || (id.startsWith('pr-') ? { title: () => `#${id.slice(3)}`, tip: () => 'PR details', Component: PrTab, flush: true } : tabDef(id));
  const icon = ICONS.find(([re]) => re.test(id))?.[1];
  return icon && !def.icon ? { ...def, icon: <Icon name={icon} size={14} /> } : def;
}
