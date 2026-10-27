import React from 'react';
import type { CheckRun } from '../types.ts';
import './thread.css';

const CHIP: Record<string, string> = { running: 'dp-info', passed: 'dp-ok', failed: 'dp-bad', unavailable: '' };
const MARK: Record<string, string> = { passed: '✓', failed: '✕', skipped: '–' };

// coco's run of the repo checks on an agent's commit: one line per check, the failing output folded under it
export default function Checks({ run }: { run: CheckRun }) {
  const failed = (run.results ?? []).filter((r) => r.state === 'failed');
  return (
    <div className="dp-ck">
      <div className="dp-ck-h">
        <span className={`dp-chip ${CHIP[run.state] ?? ''}`}>{run.state === 'running' && <span className="dp-ag-dot dp-ag-running dp-ck-spin" aria-hidden />}checks {run.state}</span>
        {run.state === 'unavailable' && run.why && <span>{run.why}</span>}
        {(run.results ?? []).map((r) => <span key={r.label} className={r.state === 'failed' ? 'dp-bad' : undefined} title={r.why || r.command}>{MARK[r.state] || ''} {r.label}</span>)}
      </div>
      {failed.map((r) => (
        <details key={r.label} className="dp-ck-fail">
          <summary>{r.label}: <code>{r.command}</code></summary>
          <pre className="dp-ck-pre">{r.output || '(no output)'}</pre>
        </details>
      ))}
    </div>
  );
}
