import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildTree, collapse } from '../../components/FileTree.jsx';
import './code.css';

const sorted = (node) => Object.entries(node.children).sort(([a, na], [b, nb]) => (na.leaf === nb.leaf ? a.localeCompare(b) : na.leaf ? 1 : -1));

// files in the order the tree shows them
export function treeOrder(files) {
  const out = [];
  const walk = (node) => sorted(node).forEach(([, child]) => (child.leaf ? out.push(child.file) : walk(child)));
  walk(buildTree(files));
  return out;
}

function FileRow({ file, label, ctx }) {
  const { filename, status, additions, deletions } = file;
  const count = ctx.commentsByPath?.[filename] || 0;
  const cat = ctx.cats?.[filename];
  return (
    <li className={`fl-file${filename === ctx.activePath ? ' on' : ''}${ctx.ticks?.has(filename) ? ' done' : ''}`} onClick={() => ctx.onOpen(filename, { preview: true })} onDoubleClick={() => ctx.onOpen(filename, { preview: false })}>
      <span className={`fl-name st-${status}`} title={cat ? `${filename}\n${cat.category}: ${cat.reason}` : filename}>{label}</span>
      {count > 0 && <span className="fl-count">{count}</span>}
      <span className="fl-stat"><span className="add">+{additions}</span> <span className="del">−{deletions}</span></span>
    </li>
  );
}

function Groups({ groups, ctx }) {
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
            <ul>{g.files.map((f) => <FileRow key={f.filename} file={f} label={f.filename.split('/').pop()} ctx={ctx} />)}</ul>
          </li>
        );
      })}
    </ul>
  );
}

function Entries({ node, prefix, ctx }) {
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
              <span className="fl-caret">{shut ? '▸' : '▾'}</span> {name}/
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
export default function FileList({ files, activePath, commentsByPath, onOpen, follow = false, groups = null, ticks = null, cats = null }) {
  const [filter, setFilter] = useState('');
  const rootRef = useRef(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(() => (needle ? files.filter((f) => f.filename.toLowerCase().includes(needle)) : files), [files, needle]);
  const root = useMemo(() => buildTree(shown), [shown]);
  const shownGroups = useMemo(() => groups && groups.map((g) => ({ ...g, files: needle ? g.files.filter((f) => f.filename.toLowerCase().includes(needle)) : g.files })).filter((g) => g.files.length), [groups, needle]);
  const toggle = (path) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const ctx = { activePath, commentsByPath, onOpen, collapsed, toggle, ticks, cats };
  useEffect(() => {
    if (!follow) return;
    const ul = rootRef.current?.querySelector(':scope > ul');
    const li = ul?.querySelector('.fl-file.on');
    if (!li) return;
    const top = li.offsetTop;
    if (top < ul.scrollTop) ul.scrollTop = top - 24;
    else if (top + li.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = top + li.offsetHeight - ul.clientHeight + 24;
  }, [follow, activePath]);
  return (
    <div className="fl" ref={rootRef}>
      <input className="fl-filter" type="search" value={filter} placeholder={`Filter ${files.length} files`} onChange={(e) => setFilter(e.target.value)} />
      {!shown.length || shownGroups?.length === 0 ? <span className="sub">No matching files.</span> : shownGroups ? <Groups groups={shownGroups} ctx={ctx} /> : <Entries node={root} prefix="" ctx={ctx} />}
    </div>
  );
}
