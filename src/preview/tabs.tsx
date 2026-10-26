import React, { createContext, useContext } from 'react';
import { PendingPermissions } from '../components/PermissionCard.tsx';
import { tabDef } from '../workbench/tabs/index.ts';
import type { TabDef } from '../workbench/tabs/index.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import StackView from './StackView.tsx';
import Inspector from './Inspector.tsx';
import OverviewView from './OverviewView.tsx';
import FindingsView from './FindingsView.tsx';
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
function PrTab({ tabId }: { tabId: string }) {
  const { d } = usePreview();
  return <div className="dp-tabview"><Inspector d={d} prKey={tabId.slice(3)} asTab /></div>;
}
const WaitingTab = () => <PendingPermissions withWhere />;

const VIEWS: Record<string, TabDef> = {
  plan: { title: () => 'Overview', Component: OverviewTab, flush: true },
  stack: { title: (c) => `Stack (${c.prs.length})`, Component: StackTab, flush: true },
  findings: { title: () => 'Findings', Component: FindingsTab, flush: true },
  waiting: { title: () => 'Waiting on you', Component: WaitingTab },
};

export function previewTabDef(id: string): TabDef {
  if (VIEWS[id]) return VIEWS[id];
  if (id.startsWith('pr-')) return { title: () => `#${id.slice(3)}`, tip: () => 'PR details', Component: PrTab, flush: true };
  return tabDef(id);
}
