import React, { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import { useAction, pendingClass } from '../../components/action.ts';

const Cmd = ({ lines }) => (
  <div className="row keep-cmd">
    <pre>{lines.join('\n')}</pre>
    <button type="button" className="sm" onClick={() => navigator.clipboard?.writeText(lines.join('\n'))}>copy</button>
  </div>
);

// after a parent PR merged: dry run of the children's rebase, apply the local part, the push left to the user
export default function StackKeeper({ slug, onChange }) {
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const { pending, busy, run } = useAction();
  const [error, setError] = useState('');
  const load = () => api.stackKeeper(slug).then(setPlan, (e) => setError(e.message));
  useEffect(() => { load(); }, [slug]);

  const act = (action, ask) => confirm(ask) && run(action, async () => {
    const r = await api.stackKeeperAction(slug, action);
    if (action === 'apply') setResult(r);
    await load();
    onChange?.();
  });

  if (!plan?.parent && !result) return error ? <div className="card danger">{error}</div> : null;
  const blocked = plan?.steps[0]?.skip;
  return (
    <div className="card keep">
      {plan?.parent && (
        <>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>Stack keeper · #{plan.parent.number} merged, {plan.steps.length} child{plan.steps.length > 1 ? 'ren' : ''} on the old base</b>
            <span className="row">
              <button className={`sm primary${pendingClass(pending === 'apply')}`} disabled={busy || Boolean(blocked)} onClick={() => act('apply', `Rebase ${plan.steps.map((s) => s.branch).join(', ')} locally (fetch origin master, rebase, Paseo baseRef, refs)? Nothing is pushed.`)}>Apply locally</button>
              <button className={`sm${pendingClass(pending === 'dismiss')}`} disabled={busy} title="Hide the badge: the children are already on the right base" onClick={() => act('dismiss', 'Mark these children as restacked by hand?')}>restacked by hand</button>
            </span>
          </div>
          <p className="sub">Dry run, bottom-up. Apply runs these git lines in each worktree, points its Paseo <code>baseRef</code> at the new base and refreshes <code>refs/cocopilot/base</code>. A conflict aborts that rebase and stops.</p>
          {plan.steps.map((s) => (
            <div key={s.key} className="list-item">
              <div className="row"><b>{s.number ? `#${s.number}` : s.branch}</b><code>{s.branch}</code><span className="status">{s.tipBefore?.slice(0, 10)} → onto {s.onto.ref}</span></div>
              {s.skip ? <div className="status">{s.skip}</div> : <Cmd lines={s.commands} />}
            </div>
          ))}
        </>
      )}
      {result && (
        <div className="list-item">
          <b>Applied</b>
          {result.results.map((r) => (
            <div key={r.key} className="status">
              <code>{r.branch}</code> {r.tipAfter ? `${r.tipBefore.slice(0, 10)} → ${r.tipAfter.slice(0, 10)}${r.worktreeJson ? ' · baseRef updated' : ''}` : r.conflict ? `conflict, stopped: ${r.conflict.join(', ')}` : r.skipped || r.error}
            </div>
          ))}
          {result.results.some((r) => r.tipAfter) && <><p className="sub" style={{ margin: '8px 0 4px' }}>Yours to run, after a look at the diffs:</p><Cmd lines={result.results.filter((r) => r.tipAfter).flatMap((r) => [r.push, ...(r.ghBase ? [r.ghBase] : [])])} /></>}
        </div>
      )}
      {error && <div className="status danger">{error}</div>}
    </div>
  );
}
