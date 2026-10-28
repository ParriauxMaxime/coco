import { createElement } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { WorkData } from '../types.ts';
import CodeTab from './Code.tsx';
import Review from './Review.tsx';
import Commit, { WorkspaceCommitTab } from './Commit.tsx';
import { parseCodeTab, parseCommitTab, parseWorkspaceCommitTab, baseName, keyLabel, reviewKeyOfTab } from '../code/ids.ts';

export type TabProps = { tabId: string; group: number };
export type TabDef = {
  title: (ctx: WorkData) => string;
  tip?: (ctx: WorkData) => string;
  Component: ComponentType<TabProps>;
  flush?: boolean;
  icon?: ReactNode;
};

const Unknown = () => createElement('div', { className: 'dp-empty' }, 'Unknown tab.');

export function tabDef(id: string): TabDef {
  const review = reviewKeyOfTab(id);
  if (review) return { title: () => `Review ${baseName(keyLabel(review))}`, tip: () => keyLabel(review), Component: Review, flush: true };
  const commit = parseCommitTab(id);
  if (commit) return { title: () => 'Suggested commit', tip: () => `thread ${commit.threadKey}`, Component: Commit, flush: true };
  const wsCommit = parseWorkspaceCommitTab(id);
  if (wsCommit) return { title: () => `Commit ${wsCommit.sha.slice(0, 7)}`, tip: () => 'An unpushed commit of an agent workspace', Component: WorkspaceCommitTab, flush: true };
  const code = parseCodeTab(id);
  if (code) return { title: () => `${code.kind === 'diff' ? '±' : '≡'} ${baseName(code.path)}`, tip: () => code.path, Component: CodeTab, flush: true };
  return { title: () => id, Component: Unknown };
}
