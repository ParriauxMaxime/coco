import React from 'react';
import type { CheckRun } from '../types.ts';

const CHIP: Record<string, string> = { running: 'c-blue', passed: 'c-green', failed: 'c-red', unavailable: 'c-grey' };
const MARK: Record<string, string> = { passed: '✓', failed: '✕', skipped: '–' };

// coco's run of the repo checks on an agent's commit: one line per check, the failing output folded under it
export default function Checks({ run }: { run: CheckRun }) {
  const failed = (run.results ?? []).filter((r) => r.state === 'failed');
  return (
    <div className="checks">
      <div className="row" style={{ gap: 6 }}>
        <span className={`chip ${CHIP[run.state] || 'c-grey'}`}>{run.state === 'running' ? <span className="spinner" aria-hidden /> : null} checks {run.state}</span>
        {run.state === 'unavailable' && run.why && <span className="status">{run.why}</span>}
        {(run.results ?? []).map((r) => <span key={r.label} className={`status${r.state === 'failed' ? ' danger' : ''}`} title={r.why || r.command}>{MARK[r.state] || ''} {r.label}</span>)}
      </div>
      {failed.map((r) => (
        <details key={r.label}>
          <summary className="status danger">{r.label}: <code>{r.command}</code></summary>
          <pre>{r.output || '(no output)'}</pre>
        </details>
      ))}
    </div>
  );
}
