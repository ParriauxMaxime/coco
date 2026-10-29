// The level model the beta navigation modes share: a surface is a list of levels, the first its summary rows, each next one
// the item opened in the level before it. A path holds the opened item keys, level 1 first; a work tab keeps its path in the hash.
export type NavMode = 'classic' | 'drill' | 'expand' | 'columns';
export type NavPath = string[];

// the narrowest a column of Columns reads well at, and the narrowest Expand still nests in (the sidebar's 256 px does); below them a mode opens as Drill
export const COLUMN_MIN = 300;
export const EXPAND_MIN = 240;

const PREFIX = 'n-';
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

// ["12", "f:abc"] → "n-12~f%3Aabc"; an empty path has no segment
export const navSegment = (path: NavPath) => (path.length ? PREFIX + path.map((k) => encodeURIComponent(k).replaceAll('~', '%7E')).join('~') : '');

export const parseNavSegment = (seg?: string): NavPath => (seg?.startsWith(PREFIX) ? seg.slice(PREFIX.length).split('~').filter(Boolean).map(dec) : []);

export const isNavSegment = (seg: string) => seg.startsWith(PREFIX);

// the mode a surface of that width lays out in: Columns needs two columns, Expand room to nest, Drill always fits
export function fitMode(mode: NavMode, width: number): NavMode {
  if (mode === 'columns' && width < COLUMN_MIN * 2) return 'drill';
  if (mode === 'expand' && width < EXPAND_MIN) return 'drill';
  return mode;
}

// how many of a surface's levels Columns shows, the deepest ones: as many as fit, at least one
export const columnsShown = (levels: number, width: number) => Math.max(1, Math.min(levels, Math.floor(width / COLUMN_MIN)));

// the path after opening key at a level (0 is the root list): what was open below that level closes; opening the open item again closes it
export function openAt(path: NavPath, depth: number, key: string, toggle = false): NavPath {
  if (toggle && path[depth] === key) return path.slice(0, depth);
  return [...path.slice(0, depth), key];
}

// a path no deeper than the levels a surface has: a stale or hand-typed link opens what it can
export const clampPath = (path: NavPath, valid: (key: string, depth: number) => boolean): NavPath => {
  const n = path.findIndex((k, i) => !valid(k, i));
  return n < 0 ? path : path.slice(0, n);
};
