import React, { useMemo, useState } from 'react';
import type { PrFile } from '../types.ts';

export type TreeLeaf = { leaf: true; add: number; del: number; status: string; file: PrFile };
export type TreeDir = { leaf?: false; children: Record<string, TreeNode>; add: number; del: number };
export type TreeNode = TreeLeaf | TreeDir;

const newDir = (): TreeDir => ({ children: {}, add: 0, del: 0 });

export function buildTree(files: PrFile[]): TreeDir {
  const root = newDir();
  for (const f of files) {
    const parts = f.filename.split('/');
    let node = root;
    node.add += f.additions;
    node.del += f.deletions;
    for (const part of parts.slice(0, -1)) {
      const existing = node.children[part];
      const dir = existing && !existing.leaf ? existing : (node.children[part] = newDir());
      node = dir;
      node.add += f.additions;
      node.del += f.deletions;
    }
    node.children[parts[parts.length - 1]] = { leaf: true, add: f.additions, del: f.deletions, status: f.status, file: f };
  }
  return root;
}

export function collapse(name: string, node: TreeDir): [string, TreeDir];
export function collapse(name: string, node: TreeNode): [string, TreeNode];
export function collapse(name: string, node: TreeNode): [string, TreeNode] {
  while (!node.leaf) {
    const keys = Object.keys(node.children);
    const child: TreeNode = node.children[keys[0]];
    if (keys.length !== 1 || child.leaf) break;
    name = `${name}/${keys[0]}`;
    node = child;
  }
  return [name, node];
}

const Badge = ({ add, del }: { add: number; del: number }) => <span className="diffstat"><span className="add">+{add}</span> <span className="del">−{del}</span></span>;

function Entries({ node, depth }: { node: TreeDir; depth: number }) {
  const entries = Object.entries(node.children).sort(([a, na], [b, nb]) => (na.leaf === nb.leaf ? a.localeCompare(b) : na.leaf ? 1 : -1));
  return (
    <ul>
      {entries.map(([k, n]) => {
        if (n.leaf) return <li key={k} className="file"><span className={`name st-${n.status}`}>{k}</span> <Badge add={n.add} del={n.del} /></li>;
        const [name, dir] = collapse(k, n);
        return <Dir key={k} name={name} node={dir} depth={depth} />;
      })}
    </ul>
  );
}

function Dir({ name, node, depth }: { name: string; node: TreeDir; depth: number }) {
  const [open, setOpen] = useState(depth < 3);
  return (
    <li className="dir">
      <div className="tree-row" onClick={() => setOpen(!open)}><span className="caret">{open ? '▾' : '▸'}</span> <span className="name">{name}/</span> <Badge add={node.add} del={node.del} /></div>
      {open && <Entries node={node} depth={depth + 1} />}
    </li>
  );
}

export default function FileTree({ files }: { files: PrFile[] }) {
  const root = useMemo(() => buildTree(files), [files]);
  if (!files.length) return <span className="sub">No files.</span>;
  return <div className="tree"><Entries node={root} depth={1} /></div>;
}
