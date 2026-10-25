import React, { useRef, useState } from 'react';
import CommentZone from './CommentZone.tsx';
import DiffView from './DiffView.tsx';

const BASE = `export function total(items) {
  let sum = 0;
  for (const item of items) sum += item.price;
  return sum;
}
`;

const HEAD = `export function total(items, taxRate = 0) {
  let sum = 0;
  for (const item of items) sum += item.price * item.qty;
  return sum * (1 + taxRate);
}
`;

const FAKE = { id: 'c1', side: 'head', startLine: 3, endLine: 3, status: 'open', body: 'Should **qty** default to 1 when missing?' };

// Not routed: mount <CodeSmoke /> anywhere to check Monaco diff, gutter drag, `c` shortcut and the zone portal
export function CodeSmoke() {
  const [comments, setComments] = useState([FAKE]);
  const [sideBySide, setSideBySide] = useState(true);
  const view = useRef(null);
  const create = ({ side, startLine, endLine }) => setComments((all) => [...all.filter((c) => c.status !== 'draft'), { id: `draft-${Date.now()}`, side, startLine, endLine, status: 'draft', body: '' }]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '80vh' }}>
      <div style={{ display: 'flex', gap: 8, padding: 8 }}>
        <button type="button" onClick={() => setSideBySide((v) => !v)}>{sideBySide ? 'Inline' : 'Side by side'}</button>
        <button type="button" onClick={() => view.current?.jumpTo(3, 'head')}>Jump to line 3</button>
      </div>
      <DiffView
        ref={view}
        original={BASE}
        modified={HEAD}
        path="src/demo/total.ts"
        sideBySide={sideBySide}
        comments={comments}
        onCreateComment={create}
        renderZone={(comment) => (
          <CommentZone
            comment={comment}
            draft={comment.status === 'draft'}
            onSave={(c, body) => setComments((all) => all.map((x) => (x.id === c.id ? { ...x, body, status: 'open' } : x)))}
            onDelete={(c) => setComments((all) => all.filter((x) => x.id !== c.id))}
            onStatus={(c, status) => setComments((all) => all.map((x) => (x.id === c.id ? { ...x, status } : x)))}
          />
        )}
      />
    </div>
  );
}
