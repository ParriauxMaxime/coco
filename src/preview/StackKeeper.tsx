import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { pendingClass, useAction } from '../components/action.ts';
import type { KeepApplied, KeepPlan } from '../types.ts';
import Icon from './Icon.tsx';
import Modal from './Modal.tsx';
import { ErrorNote } from './pages/Page.tsx';

const short = (sha?: string) => (sha ? sha.slice(0, 10) : '');

function Cmd({ lines }: { lines: string[] }) {
  return (
    <div className="dp-keep-cmd">
      <pre className="dp-cmdline">{lines.join('\n')}</pre>
      <button type="button" className="dp-ibtn" title="Copy" onClick={() => navigator.clipboard?.writeText(lines.join('\n'))}><Icon name="copy" size={14} /></button>
    </div>
  );
}

// after a parent PR merged: dry run of the children's rebase, apply the local part, the push left to the user
export default function StackKeeper({ slug, onClose, onChange }: { slug: string; onClose: () => void; onChange: () => void }) {
  const [plan, setPlan] = useState<KeepPlan | null>(null);
  const [result, setResult] = useState<KeepApplied | null>(null);
  const [error, setError] = useState('');
  const { pending, busy, run } = useAction();
  const load = () => api.stackKeeper(slug).then(setPlan, (e) => setError(errorMessage(e)));
  useEffect(() => { void load(); }, [slug]);

  const act = (action: 'apply' | 'dismiss') => run(action, async () => {
    const r = await api.stackKeeperAction(slug, action);
    if (action === 'apply') setResult(r);
    await load();
    onChange();
    if (action === 'dismiss') onClose();
  });

  const parent = plan?.parent;
  const blocked = Boolean(plan?.steps[0]?.skip);
  const pushes = result?.results.filter((r) => r.tipAfter).flatMap((r) => [...(r.push ? [r.push] : []), ...(r.ghBase ? [r.ghBase] : [])]) || [];
  const title = parent ? `Restack · #${parent.number} merged, ${plan.steps.length} ${plan.steps.length === 1 ? 'child' : 'children'} on the old base` : 'Restack';
  return (
    <Modal title={title} wide busy={busy} onClose={onClose} foot={
      <>
        <button type="button" className="dp-btn" disabled={busy} onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
        {parent && <button type="button" className={`dp-btn${pendingClass(pending === 'dismiss')}`} disabled={busy} title="The children are already on the right base" onClick={() => act('dismiss')}>Restacked by hand</button>}
        {parent && <button type="button" className={`dp-btn dp-primary${pendingClass(pending === 'apply')}`} disabled={busy || blocked} onClick={() => act('apply')}><Icon name="git-branch" size={14} />Apply locally</button>}
      </>
    }>
      {!plan && !error && <p className="dp-t3">Loading…</p>}
      {plan && !parent && !result && <p className="dp-t3">Nothing to restack: no merged parent left children on its old base.</p>}
      {parent && (
        <>
          <p className="dp-keep-lead">Dry run, bottom-up. Apply rebases each worktree, points its Paseo <code>baseRef</code> at the new base and refreshes <code>refs/cocopilot/base</code>. A conflict aborts that rebase and stops. Nothing is pushed.</p>
          {plan.steps.map((s) => (
            <div key={s.key} className="dp-keep-step">
              <div className="dp-keep-sh"><b>{s.number ? `#${s.number}` : s.branch}</b><code className="dp-ell">{s.branch}</code><span className="dp-keep-tip dp-t3 dp-mono dp-xs">{short(s.tipBefore)} onto {s.onto.ref}</span></div>
              {s.skip ? <div className="dp-t3">{s.skip}</div> : <Cmd lines={s.commands} />}
            </div>
          ))}
        </>
      )}
      {result && (
        <div className="dp-keep-step">
          <div className="dp-keep-sh"><b>Applied</b></div>
          {result.results.map((r) => (
            <div key={r.key} className="dp-xs">
              <code>{r.branch}</code> {r.tipAfter ? `${short(r.tipBefore)} → ${short(r.tipAfter)}${r.worktreeJson ? ' · baseRef updated' : ''}` : r.conflict ? <span className="dp-keep-bad">conflict, stopped: {r.conflict.join(', ')}</span> :r.skipped || r.error}
            </div>
          ))}
          {pushes.length > 0 && <><p className="dp-keep-lead">Yours to run, after a look at the diffs:</p><Cmd lines={pushes} /></>}
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}
