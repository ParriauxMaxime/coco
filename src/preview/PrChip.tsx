import Icon from './Icon.tsx';
import { prKey, prState } from './data.ts';
import type { WorkPr } from '../workbench/types.ts';

const ciClass = (ci?: string) => (ci === 'failure' ? ' dp-ci-bad' : ci === 'pending' ? ' dp-ci-run' : '');

export const prLabel = (pr: WorkPr) => (pr.number ? `#${pr.number}` : 'planned');

export default function PrChip({ pr, onOpen }: { pr: WorkPr; onOpen?: (key: string) => void }) {
  const state = prState(pr);
  const body = (
    <>
      <Icon name={state === 'merged' ? 'git-merge' : 'git-pull-request'} size={12} />
      {prLabel(pr)}
    </>
  );
  const cls = `dp-prb dp-st-${state}${ciClass(pr.ci)}`;
  return onOpen ? <button type="button" className={cls} onClick={() => onOpen(prKey(pr))}>{body}</button> : <span className={cls}>{body}</span>;
}
