import type { PrFile } from '../../types.ts';

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
