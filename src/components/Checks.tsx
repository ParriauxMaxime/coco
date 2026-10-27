import React from 'react';
import type { CheckRun, VerifyRun } from '../types.ts';
import './thread.css';

const CHIP: Record<string, string> = { running: 'dp-info', passed: 'dp-ok', failed: 'dp-bad', unavailable: '' };
const MARK: Record<string, string> = { passed: '✓', failed: '✕', skipped: '–' };

const VERIFY_CHIP: Record<string, string> = { running: 'dp-info', pass: 'dp-ok', fail: 'dp-bad', 'deps-pending': 'dp-warn' };

// the owner's Verify: a chip per check as it finishes, a failure's last lines folded under it, deps-pending with what is happening
export function VerifyChips({ run }: { run: VerifyRun }) {
  return (
    <div className="dp-ck">
      <div className="dp-ck-h">
        <span className={`dp-chip ${VERIFY_CHIP[run.status]}`}>{run.status === 'running' && <span className="dp-ag-dot dp-ag-running dp-ck-spin" aria-hidden />}verify {run.status}</span>
        {run.checks.map((c) => <span key={c.name} className={`dp-chip ${c.skipped ? '' : c.ok ? 'dp-ok' : 'dp-bad'}`} title={c.skipped || `${(c.ms / 1000).toFixed(1)}s`}>{c.skipped ? '–' : c.ok ? '✓' : '✕'} {c.name}{!c.skipped && c.ms ? ` ${(c.ms / 1000).toFixed(1)}s` : ''}</span>)}
        {run.note && <span>{run.note}</span>}
      </div>
      {run.checks.filter((c) => c.tail).map((c) => (
        <details key={c.name} className="dp-ck-fail">
          <summary>{c.name} failed</summary>
          <pre className="dp-ck-pre">{c.tail}</pre>
        </details>
      ))}
    </div>
  );
}

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
