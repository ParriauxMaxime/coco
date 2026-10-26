import { createElement } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { WorkData } from '../types.ts';
import Artifact from './Artifact.tsx';
import Decisions, { decisionCounts } from './Decisions.tsx';
import CodeTab from './Code.tsx';
import Review from './Review.tsx';
import AgentRun from './AgentRun.tsx';
import StackRun from '../code/StackFix.tsx';
import Findings from './Findings.tsx';
import Brief, { briefKeyOfTab } from './Brief.tsx';
import { parseCodeTab, baseName, findingsKeyOfTab, keyLabel, reviewKeyOfTab } from '../code/ids.ts';

export type TabProps = { tabId: string; group: number };
export type TabDef = {
  title: (ctx: WorkData) => string;
  tip?: (ctx: WorkData) => string;
  Component: ComponentType<TabProps>;
  flush?: boolean;
  icon?: ReactNode;
};

const Unknown = () => createElement('div', { className: 'sub' }, 'Unknown tab.');

const fixed: Record<string, TabDef> = {
  decisions: { title: (c) => { const { taken, total } = decisionCounts(c.w); return `Decisions (${taken}/${total})`; }, Component: Decisions },
};

export function tabDef(id: string): TabDef {
  if (fixed[id]) return fixed[id];
  if (id.startsWith('artifact-')) return { title: () => id.slice(9), Component: Artifact, flush: true };
  const review = reviewKeyOfTab(id);
  if (review) return { title: () => `Review ${baseName(keyLabel(review))}`, tip: () => keyLabel(review), Component: Review, flush: true };
  const findings = findingsKeyOfTab(id);
  if (findings) return { title: () => `Findings ${baseName(keyLabel(findings))}`, tip: () => keyLabel(findings), Component: Findings };
  if (id.startsWith('brief-')) return { title: () => `Agent ${baseName(keyLabel(briefKeyOfTab(id)))}`, tip: () => keyLabel(briefKeyOfTab(id)), Component: Brief };
  if (id.startsWith('agent-')) return { title: () => `Agent ${id.slice(6, 14)}`, Component: AgentRun };
  if (id.startsWith('stack-')) return { title: () => `Stack fix ${id.slice(6, 14)}`, Component: StackRun };
  const code = parseCodeTab(id);
  if (code) return { title: () => `${code.kind === 'diff' ? '±' : '≡'} ${baseName(code.path)}`, tip: () => code.path, Component: CodeTab, flush: true };
  return { title: () => id, Component: Unknown };
}
