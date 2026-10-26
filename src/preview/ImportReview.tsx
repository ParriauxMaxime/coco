import { useEffect, useState } from 'react';
import { errorMessage } from '../api.ts';
import { loadReview, reviewApi } from '../workbench/code/use-comments.ts';
import { keyLabel } from '../workbench/code/ids.ts';
import type { ImportReviewFile, ImportReviewResult } from '../workbench/types.ts';
import Icon from './Icon.tsx';
import Modal from './Modal.tsx';
import { ErrorNote } from './pages/Page.tsx';
import { stamp } from './format.ts';

export default function ImportReview({ slug, onClose, onDone }: { slug: string; onClose: () => void; onDone: () => void }) {
  const [files, setFiles] = useState<ImportReviewFile[] | null>(null);
  const [busy, setBusy] = useState('');
  const [out, setOut] = useState<ImportReviewResult | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { reviewApi.reviewFiles(slug).then((r) => setFiles(r.files), (e) => setError(errorMessage(e))); }, [slug]);
  const run = async (path: string) => {
    setBusy(path);
    setError('');
    try {
      const r: ImportReviewResult = await reviewApi.importReview(slug, path);
      setOut(r);
      new Set(r.added.map((a) => a.key)).forEach((key) => loadReview(slug, key));
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy('');
  };
  return (
    <Modal title="Import a review as comments" wide busy={Boolean(busy)} onClose={onClose} foot={<button type="button" className="dp-btn" disabled={Boolean(busy)} onClick={onClose}>{out ? 'Close' : 'Cancel'}</button>}>
      {!out && (
        <>
          <p className="dp-keep-lead">Each finding of the review file becomes an open local comment on the last PR whose diff holds its file. Nothing is posted to GitHub.</p>
          <ul className="dp-imp-list">
            {(files || []).map((f) => (
              <li key={f.path}>
                <button type="button" className="dp-imp-file" disabled={Boolean(busy)} title={f.path} onClick={() => run(f.path)}>
                  <Icon name={busy === f.path ? 'refresh' : 'file'} size={14} className={busy === f.path ? 'dp-spin' : undefined} /><span className="dp-ell">{f.name}</span>
                </button>
                <span className="dp-t3 dp-xs">{stamp(new Date(f.mtime).toISOString())}</span>
              </li>
            ))}
            {files && !files.length && <li className="dp-t3">No review file found.</li>}
            {!files && !error && <li className="dp-t3">Loading…</li>}
          </ul>
        </>
      )}
      {out && (
        <ul className="dp-imp-list">
          {out.added.map((a) => <li key={a.id}><span className="dp-chip dp-ok">added</span><code className="dp-ell">{a.where}</code><span className="dp-t3">on {keyLabel(a.key)}</span></li>)}
          {out.skipped.map((s, i) => <li key={i}><span className="dp-chip">skipped</span><code className="dp-ell">{s.where}</code><span className="dp-t3">{s.reason}</span></li>)}
          {!out.added.length && !out.skipped.length && <li className="dp-t3">No finding in that file.</li>}
        </ul>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}
