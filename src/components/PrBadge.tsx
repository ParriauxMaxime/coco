import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../preview/Icon.tsx';
import type { PrCheck, PrInfo } from '../types.ts';
import './parts.css';

type PrState = Pick<PrInfo, 'number' | 'state' | 'isDraft' | 'reviewDecision'>;

const STATE_LABELS: Record<string, string> = { merged: 'merged', closed: 'closed', draft: 'draft', approved: 'approved', changes: 'changes requested', ready: 'in review', planned: 'planned' };
export const stateKey = (pr: PrState) => (pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : !pr.number ? 'planned' : pr.isDraft ? 'draft' : pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'ready');
const TONE: Record<string, string> = { ready: 'review', closed: 'planned' };
export const stateLabel = (pr: PrState) => STATE_LABELS[stateKey(pr)];

type Bucket = 'pass' | 'fail' | 'running' | 'skip';
const bucket = (c: PrCheck): Bucket => {
  if (c.status && c.status !== 'COMPLETED') return 'running';
  if (['SUCCESS', 'NEUTRAL'].includes(c.conclusion)) return 'pass';
  if (c.conclusion === 'SKIPPED') return 'skip';
  return 'fail';
};

function Peek({ pr, rect, onEnter, onLeave }: { pr: PrInfo; rect: DOMRect; onEnter: () => void; onLeave: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight || 0;
    const w = box.current?.offsetWidth || 0;
    const below = rect.bottom + 6 + h < innerHeight;
    setPos({ left: Math.max(8, Math.min(rect.left, innerWidth - w - 8)), top: below ? rect.bottom + 6 : Math.max(8, rect.top - 6 - h) });
  }, [rect]);
  const checks = pr.checks || [];
  const by = (b: Bucket) => checks.filter((c) => bucket(c) === b);
  const failed = by('fail');
  const running = by('running');
  const checksPage = `${pr.url}/checks`;
  const counts = ([['pass', 'passed'], ['fail', 'failed'], ['running', 'running'], ['skip', 'skipped']] as const).map(([b, label]) => [by(b).length, label] as const).filter(([n]) => n > 0);
  return createPortal(
    <div className="dp dp-float">
      <div ref={box} className="dp-peek" style={pos || { visibility: 'hidden' }} onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={(e) => e.stopPropagation()}>
        <div className="dp-peek-h">
          <a className="dp-peek-n" href={pr.url} target="_blank" rel="noreferrer">#{pr.number}<Icon name="external-link" size={12} /></a>
          <span className={`dp-chip dp-tone dp-st-${TONE[stateKey(pr)] ?? stateKey(pr)}`}>{stateLabel(pr)}</span>
        </div>
        {checks.length === 0 ? <div className="dp-peek-mute">No CI checks</div> : !failed.length && !running.length ? (
          <a className="dp-peek-ci dp-ci-ok" href={checksPage} target="_blank" rel="noreferrer">CI passed · {checks.length} checks</a>
        ) : (
          <>
            <a className={`dp-peek-ci ${failed.length ? 'dp-ci-bad' : 'dp-ci-run'}`} href={checksPage} target="_blank" rel="noreferrer">CI {counts.map(([n, label]) => `${n} ${label}`).join(' · ')}</a>
            <ul className="dp-peek-checks">
              {[...failed, ...running].map((c, i) => (
                <li key={i} className={bucket(c) === 'running' ? 'dp-peek-run' : undefined}><a className="dp-ell" href={c.url || checksPage} target="_blank" rel="noreferrer">{c.name}</a><span>{bucket(c) === 'running' ? 'running' : (c.conclusion || 'failed').toLowerCase().replace('_', ' ')}</span></li>
              ))}
            </ul>
          </>
        )}
        {pr.unresolvedThreads !== undefined && (
          <a className={`dp-peek-threads${pr.unresolvedThreads ? ' dp-on' : ''}`} href={pr.url} target="_blank" rel="noreferrer">
            {pr.unresolvedThreads ? `${pr.unresolvedThreads} unresolved review thread${pr.unresolvedThreads > 1 ? 's' : ''}` : 'No unresolved review thread'}
          </a>
        )}
      </div>
    </div>,
    document.body,
  );
}

// CI and unresolved threads of a PR, shown while its badge is hovered or focused
export function usePrPeek(pr: PrInfo) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = (e: React.SyntheticEvent<HTMLElement>) => {
    const target = e.currentTarget;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setRect(target.getBoundingClientRect()), 150);
  };
  const hide = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setRect(null), 200);
  };
  const bind = { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide };
  const peek = rect && pr.number ? <Peek pr={pr} rect={rect} onEnter={() => clearTimeout(timer.current)} onLeave={hide} /> : null;
  return { bind, peek };
}

