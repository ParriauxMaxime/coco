import { createElement } from 'react';
import Plan from './Plan.jsx';
import Pr from './Pr.jsx';
import Artifacts from './Artifacts.jsx';
import Artifact from './Artifact.jsx';
import AskTab from './AskTab.jsx';
import Timeline from './Timeline.jsx';
import Notes from './Notes.jsx';
import Decisions, { decisionCounts } from './Decisions.jsx';
import CodeTab from './Code.jsx';
import Review from './Review.jsx';
import AgentRun from './AgentRun.jsx';
import StackRun from '../code/StackFix.jsx';
import Findings from './Findings.jsx';
import Brief, { briefKeyOfTab } from './Brief.jsx';
import Rules from '../../components/Rules.jsx';
import { useWork } from '../use-work.js';
import { parseCodeTab, baseName, findingsKeyOfTab, keyLabel, reviewKeyOfTab } from '../code/ids.js';

const Unknown = () => createElement('div', { className: 'sub' }, 'Unknown tab.');
const RulesTab = () => createElement('div', { className: 'wb-plan' }, createElement(Rules, { slug: useWork().slug }));

const fixed = {
  plan: { title: () => 'Plan', Component: Plan },
  artifacts: { title: (c) => `Artifacts (${c.w.artifacts.length})`, Component: Artifacts },
  ask: { title: () => '🦜 Ask coco', Component: AskTab },
  timeline: { title: (c) => `Timeline (${(c.w.timeline || []).length})`, Component: Timeline },
  notes: { title: () => 'Notes', Component: Notes },
  decisions: { title: (c) => { const { taken, total } = decisionCounts(c.w); return `Decisions (${taken}/${total})`; }, Component: Decisions },
  findings: { title: () => 'Findings · stack', Component: Findings },
  rules: { title: () => 'Rules', Component: RulesTab },
};

export function tabDef(id) {
  if (fixed[id]) return fixed[id];
  if (id.startsWith('pr-')) return { title: () => `#${id.slice(3)} · developer details`, Component: Pr };
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
