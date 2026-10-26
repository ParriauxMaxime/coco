import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildTree, collapse } from './file-tree.ts';
import type { TreeDir } from './file-tree.ts';
import Icon from '../../preview/Icon.tsx';
import type { PrFile } from '../../types.ts';
import { dirHints, watchCount } from './review-order.ts';
import type { FileCategory, FileGroup, Proposal, RefFile } from '../types.ts';
import './code.css';

type OpenFile = (path: string, options: { preview: boolean }) => void;
type ListContext = {
  activePath: string | null;
  commentsByPath?: Record<string, number>;
  onOpen: OpenFile;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  folded: string[];
  fold: (key: string) => void;
  watch: Record<string, Proposal[]>;
  fresh: Set<string>;
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

function FileRow({ file, label, hint, ctx }: { file: PrFile; label: string; hint?: string; ctx: ListContext }) {
  const { filename, status, additions, deletions } = file;
  const count = ctx.commentsByPath?.[filename] || 0;
  const watch = ctx.watch[filename]?.length || 0;
  const cat = ctx.cats?.[filename];
  return (
    <li className={`fl-file${filename === ctx.activePath ? ' on' : ''}${ctx.ticks?.has(filename) ? ' done' : ''}`} onClick={() => ctx.onOpen(filename, { preview: true })} onDoubleClick={() => ctx.onOpen(filename, { preview: false })}>
      <span className={`fl-name st-${status}`} title={cat ? `${filename}\n${cat.category}: ${cat.reason}` : filename}>{label}{hint && <span className="fl-hint"> {hint}/</span>}</span>
      {ctx.fresh.has(filename) && <span className="dp-chip dp-warn" title="pushed after coco planned, placed by folder">new</span>}
      {watch > 0 && <span className="dp-count fl-wp" title="coco watch points">{watch}</span>}
      {count > 0 && <span className="dp-count dp-acc" title={`${count} comment${count > 1 ? 's' : ''}`}>{count}</span>}
      <span className="fl-stat"><span className="dp-add">+{additions}</span> <span className="dp-del">−{deletions}</span></span>
    </li>
  );
}

function Why({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  return <div className={`rv-excerpt fl-why${full ? ' full' : ''}`} onClick={() => setFull(!full)}>{text}</div>;
}

function Groups({ groups, ctx }: { groups: FileGroup[]; ctx: ListContext }) {
  const hints = useMemo(() => dirHints(groups.flatMap((g) => g.files.map((f) => f.filename))), [groups]);
  return (
    <ul>
      {groups.map((g) => {
        const done = g.files.filter((f) => ctx.ticks?.has(f.filename)).length;
        const shut = ctx.folded.includes(g.key);
        const watch = watchCount(g, ctx.watch);
        return (
          <li key={g.key} className="fl-group">
            <div className="fl-row" title={g.title} onClick={() => ctx.fold(g.key)}>
              <span className={`dp-caret${shut ? '' : ' dp-open'}`}><Icon name="chevron-right" size={12} /></span>
              <span className="fl-group-t">{g.title}</span>
              {watch > 0 && <span className="dp-chip dp-tone dp-st-merged" title="coco watch points">{watch} watch</span>}
              <span className={`fl-progress${done === g.files.length ? ' all' : ''}`}>{done}/{g.files.length}</span>
            </div>
            {!shut && g.why && <Why text={g.why} />}
            {!shut && <ul>{g.files.map((f) => <FileRow key={f.filename} file={f} label={f.filename.split('/').pop() ?? f.filename} hint={hints[f.filename]} ctx={ctx} />)}</ul>}
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
// groups: [{ key, title, why, files }] shows a flat reading order instead of the tree · folded: keys of folded groups · watch: { [path]: coco watch points }
// fresh: Set of paths pushed after the plan · ticks: Set of reviewed paths · cats: { [path]: { category, reason } }
type Props = {
  files: RefFile[];
  activePath: string | null;
  commentsByPath?: Record<string, number>;
  onOpen: OpenFile;
  follow?: boolean;
  groups?: FileGroup[] | null;
  folded?: string[];
  onFold?: (key: string) => void;
  watch?: Record<string, Proposal[]>;
  fresh?: Set<string>;
  ticks?: Set<string> | null;
  cats?: ListContext['cats'];
};

export default function FileList({ files, activePath, commentsByPath, onOpen, follow = false, groups = null, folded = [], onFold = () => {}, watch = {}, fresh = new Set(), ticks = null, cats = null }: Props) {
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
  const ctx = { activePath, commentsByPath, onOpen, collapsed, toggle, folded: needle ? [] : folded, fold: onFold, watch, fresh, ticks, cats };
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
