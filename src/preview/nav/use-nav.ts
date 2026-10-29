import { createContext, useContext } from 'react';
import { create } from 'zustand';
import { openAt } from './nav.ts';
import type { NavPath } from './nav.ts';

const EMPTY: NavPath = [];

// each work tab's opened levels, by tab id; the hash carries the focused tab's (workbench/hash.ts)
export const useNavPaths = create<Record<string, NavPath>>(() => ({}));
const same = (a: NavPath, b: NavPath) => a.length === b.length && a.every((k, i) => k === b[i]);
export const setNavPath = (scope: string, path: NavPath) => {
  if (!same(useNavPaths.getState()[scope] ?? EMPTY, path)) useNavPaths.setState({ [scope]: path });
};
export const navPathOf = (scope: string) => useNavPaths.getState()[scope] ?? EMPTY;

// the tab a surface shows in, set by the workbench pane: its key in useNavPaths
export const NavScope = createContext<string | null>(null);
// where in the path the items of the level a component shows in open: a thread inside a finding's level opens its turns one deeper
export const NavDepth = createContext(0);

export type Nav = { path: NavPath; open: (depth: number, key: string, toggle?: boolean) => void; up: (depth: number) => void };

// a surface's opened levels and the moves between them; outside a work tab nothing opens
export function useNav(): Nav {
  const scope = useContext(NavScope);
  const path = useNavPaths((s) => (scope ? s[scope] : undefined) ?? EMPTY);
  return {
    path,
    open: (depth, key, toggle) => { if (scope) setNavPath(scope, openAt(navPathOf(scope), depth, key, toggle)); },
    up: (depth) => { if (scope) setNavPath(scope, navPathOf(scope).slice(0, depth)); },
  };
}
