import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkbench } from '../workbench/workbench-store.ts';
import Icon from './Icon.tsx';
import { BUILTIN, applyLayout, matching, useLayouts } from './layouts.ts';

export function useWorkLayouts(slug: string) {
  const saved = useLayouts((s) => s.bySlug[slug]);
  const layout = useWorkbench((s) => (s.slug === slug ? s.layout : null));
  useEffect(() => { useLayouts.getState().load(slug); }, [slug]);
  const list = useMemo(() => [...BUILTIN, ...(saved || [])], [saved]);
  return { list, current: layout ? matching(list, layout) : null };
}

export default function LayoutMenu({ slug }: { slug: string }) {
  const { list, current } = useWorkLayouts(slug);
  const { save, update, rename, remove } = useLayouts();
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [last, setLast] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => { if (!(e.target instanceof Node && box.current?.contains(e.target))) { setOpen(false); setNaming(null); } };
    addEventListener('mousedown', away);
    return () => removeEventListener('mousedown', away);
  }, [open]);
  const lastSaved = list.find((l) => l.id === last && !l.builtin);
  const startNaming = (id: string, value: string) => { setNaming(id); setName(value); };
  const commit = () => {
    const text = name.trim();
    if (!text) return;
    if (naming === '') save(slug, text);
    else if (naming) rename(slug, naming, text);
    setNaming(null);
  };
  return (
    <div className="dp-laymenu" ref={box}>
      <button type="button" className={`dp-btn dp-sm${open ? ' dp-on' : ''}`} title="Layouts of this work  ⌥1…⌥9" onClick={() => setOpen((o) => !o)}>
        <Icon name="columns" size={14} /><span className="dp-ell">{current?.name || 'Unsaved layout'}</span><Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="dp-pop dp-on dp-laypop">
          <div className="dp-pop-h"><b>Layouts</b><span className="dp-xs dp-t3">this work · this browser</span></div>
          <div className="dp-pop-s">
            {list.map((l, i) => (naming === l.id ? (
              <form key={l.id} className="dp-mi dp-layname" onSubmit={(e) => { e.preventDefault(); commit(); }}>
                <input className="dp-inp" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
                <button type="submit" className="dp-btn dp-sm dp-primary">Rename</button>
              </form>
            ) : (
              <div key={l.id} className={`dp-mi${current?.id === l.id ? ' dp-hl' : ''}`} onClick={() => { applyLayout(l); setLast(l.id); setOpen(false); }}>
                {current?.id === l.id ? <Icon name="check" size={14} /> : <Icon name="columns" size={14} />}
                <span className="dp-ell">{l.name}</span>
                {l.builtin && <span className="dp-xs dp-t4">built-in</span>}
                <span className="dp-sp" />
                {!l.builtin && <button type="button" className="dp-ibtn" title="Rename" onClick={(e) => { e.stopPropagation(); startNaming(l.id, l.name); }}><Icon name="more-horizontal" size={14} /></button>}
                {!l.builtin && <button type="button" className="dp-ibtn" title="Delete" onClick={(e) => { e.stopPropagation(); remove(slug, l.id); }}><Icon name="x" size={12} /></button>}
                {i < 9 && <span className="dp-r"><kbd>⌥</kbd><kbd>{i + 1}</kbd></span>}
              </div>
            )))}
          </div>
          <div className="dp-pop-s">
            {naming === '' ? (
              <form className="dp-mi dp-layname" onSubmit={(e) => { e.preventDefault(); commit(); }}>
                <input className="dp-inp" autoFocus placeholder="Layout name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
                <button type="submit" className="dp-btn dp-sm dp-primary">Save</button>
              </form>
            ) : (
              <div className="dp-mi" onClick={() => startNaming('', '')}><Icon name="plus" size={14} />Save the current layout…</div>
            )}
            {lastSaved && current?.id !== lastSaved.id && (
              <div className="dp-mi" onClick={() => { update(slug, lastSaved.id); setOpen(false); }}><Icon name="check" size={14} />Update “{lastSaved.name}” with the current layout</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
