import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildTree, collapse } from '../../components/FileTree.tsx';
import type { TreeDir } from '../../components/FileTree.tsx';
import Icon from '../../preview/Icon.tsx';
import type { PrFile } from '../../types.ts';
import type { FileCategory, FileGroup, RefFile } from '../types.ts';
import './code.css';

type OpenFile = (path: string, options: { preview: boolean }) => void;
type ListContext = {
  activePath: string | null;
  commentsByPath?: Record<string, number>;
  onOpen: OpenFile;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  ticks: Set<string> | null;
  cats: Record<string, FileCategory | undefined> | null | undefined;
};

const sorted = (node: TreeDir) => Object.entries(node.children).sort(([a, na], [b, nb]) => (na.leaf === nb.leaf ? a.localeCompare(b) : na.leaf ? 1 : -1));

// files in the order the tree shows them
export function treeOrder<F extends PrFile>(files: F[]): F[] {
  const byName = new Map(files.map((f) => [f.filename, f]));
  const out: F[] = [];
  const walk = (node: TreeDir) => sorted(node).forEach(([, child]) => {
    if (!child.leaf) return walk(child);
    const f = byName.get(child.file.filename);
    if (f) out.push(f);
  });
  walk(buildTree(files));
  return out;
}

function FileRow({ file, label, ctx }: { file: PrFile; label: string; ctx: ListContext }) {
  const { filename, status, additions, deletions } = file;
  const count = ctx.commentsByPath?.[filename] || 0;
  const cat = ctx.cats?.[filename];
  return (
    <li className={`fl-file${filename === ctx.activePath ? ' on' : ''}${ctx.ticks?.has(filename) ? ' done' : ''}`} onClick={() => ctx.onOpen(filename, { preview: true })} onDoubleClick={() => ctx.onOpen(filename, { preview: false })}>
      <span className={`fl-name st-${status}`} title={cat ? `${filename}\n${cat.category}: ${cat.reason}` : filename}>{label}</span>
      {count > 0 && <span className="dp-count dp-acc" title={`${count} comment${count > 1 ? 's' : ''}`}>{count}</span>}
      <span className="fl-stat"><span className="dp-add">+{additions}</span> <span className="dp-del">−{deletions}</span></span>
    </li>
  );
}

function Groups({ groups, ctx }: { groups: FileGroup[]; ctx: ListContext }) {
  return (
    <ul>
      {groups.map((g) => {
        const done = g.files.filter((f) => ctx.ticks?.has(f.filename)).length;
        return (
          <li key={g.key} className="fl-group">
            <div className="fl-row" title={g.why || ''} onClick={() => ctx.onOpen(g.files[0].filename, { preview: true })}>
              <span className="fl-group-t">{g.title}</span>
              <span className={`fl-progress${done === g.files.length ? ' all' : ''}`}>{done}/{g.files.length}</span>
            </div>
            <ul>{g.files.map((f) => <FileRow key={f.filename} file={f} label={f.filename.split('/').pop() ?? f.filename} ctx={ctx} />)}</ul>
          </li>
        );
      })}
    </ul>
  );
}

function Entries({ node, prefix, ctx }: { node: TreeDir; prefix: string; ctx: ListContext }) {
  const entries = sorted(node);
  return (
    <ul>
      {entries.map(([key, child]) => {
        if (child.leaf) return <FileRow key={key} file={child.file} label={key} ctx={ctx} />;
        const [name, dir] = collapse(key, child);
        const path = `${prefix}${name}`;
        const shut = ctx.collapsed.has(path);
        return (
          <li key={key} className="fl-dir">
            <div className="fl-row" onClick={() => ctx.toggle(path)}>
              <span className={`dp-caret${shut ? '' : ' dp-open'}`}><Icon name="chevron-right" size={12} /></span>{name}/
            </div>
            {!shut && <Entries node={dir} prefix={`${path}/`} ctx={ctx} />}
          </li>
        );
      })}
    </ul>
  );
}

// files: [{ filename, status, additions, deletions }] · commentsByPath: { [path]: count } · follow: scroll the list to keep activePath visible
// groups: [{ key, title, why, files }] shows a flat reading order instead of the tree · ticks: Set of reviewed paths · cats: { [path]: { category, reason } }
type Props = {
  files: RefFile[];
  activePath: string | null;
  commentsByPath?: Record<string, number>;
  onOpen: OpenFile;
  follow?: boolean;
  groups?: FileGroup[] | null;
  ticks?: Set<string> | null;
  cats?: ListContext['cats'];
};

export default function FileList({ files, activePath, commentsByPath, onOpen, follow = false, groups = null, ticks = null, cats = null }: Props) {
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(() => (needle ? files.filter((f) => f.filename.toLowerCase().includes(needle)) : files), [files, needle]);
  const root = useMemo(() => buildTree(shown), [shown]);
  const shownGroups = useMemo(() => groups && groups.map((g) => ({ ...g, files: needle ? g.files.filter((f) => f.filename.toLowerCase().includes(needle)) : g.files })).filter((g) => g.files.length), [groups, needle]);
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const ctx = { activePath, commentsByPath, onOpen, collapsed, toggle, ticks, cats };
  useEffect(() => {
    if (!follow) return;
    const ul = rootRef.current?.querySelector<HTMLElement>(':scope > ul');
    const li = ul?.querySelector<HTMLElement>('.fl-file.on');
    if (!ul || !li) return;
    const top = li.offsetTop;
    if (top < ul.scrollTop) ul.scrollTop = top - 24;
    else if (top + li.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = top + li.offsetHeight - ul.clientHeight + 24;
  }, [follow, activePath]);
  return (
    <div className="fl" ref={rootRef}>
      <input className="dp-inp fl-filter" type="search" value={filter} placeholder={`Filter ${files.length} files`} onChange={(e) => setFilter(e.target.value)} />
      {!shown.length || shownGroups?.length === 0 ? <span className="fl-none">No matching files.</span> : shownGroups ? <Groups groups={shownGroups} ctx={ctx} /> : <Entries node={root} prefix="" ctx={ctx} />}
    </div>
  );
}
