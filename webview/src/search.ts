/**
 * Fuzzy search over the whole design (all scopes). Pure module; the UI lives
 * in toolbar.ts.
 */
import type { Design } from '../../src/model/types';
import { netKey, type Selection, shortVlnv } from './state';

export interface SearchItem {
  kind: 'cell' | 'pin' | 'port' | 'net';
  /** Short name (leaf). */
  name: string;
  /** Full display path. */
  path: string;
  /** Scope to open to show the object. */
  scope: string;
  select: Selection;
  detail?: string;
  /** Lower-cased copies for matching. */
  lname: string;
  lpath: string;
}

export function buildSearchIndex(design: Design): SearchItem[] {
  const items: SearchItem[] = [];
  const push = (it: Omit<SearchItem, 'lname' | 'lpath'>): void => {
    items.push({ ...it, lname: it.name.toLowerCase(), lpath: it.path.toLowerCase() });
  };
  for (const c of design.cells) {
    push({
      kind: 'cell',
      name: c.name,
      path: c.path,
      scope: c.parent,
      select: { kind: 'cell', path: c.path },
      detail: c.kind === 'ip' ? shortVlnv(c.vlnv) : c.kind === 'module' ? c.reference : c.kind,
    });
    for (const p of [...c.intfPins, ...c.pins]) {
      push({ kind: 'pin', name: p.name, path: p.path, scope: c.parent, select: { kind: 'pin', path: p.path } });
    }
  }
  for (const p of [...design.intfPorts, ...design.ports]) {
    push({ kind: 'port', name: p.name, path: p.path, scope: '', select: { kind: 'port', path: p.path } });
  }
  for (const n of design.nets) {
    push({
      kind: 'net',
      name: n.name,
      path: n.scope ? `${n.scope}/${n.name}` : n.name,
      scope: n.scope,
      select: { kind: 'net', path: netKey(n.scope, n.name) },
      detail: n.kind === 'interface' ? 'interface net' : undefined,
    });
  }
  return items;
}

/** Score `needle` against `hay`; -1 when it does not match at all. */
export function fuzzyScore(needle: string, hay: string): number {
  if (!needle) return 0;
  const idx = hay.indexOf(needle);
  if (idx >= 0) {
    let s = 200 - Math.min(idx, 100);
    if (idx === 0) s += 60;
    if (hay.length === needle.length) s += 120;
    const prev = hay[idx - 1];
    if (prev === '_' || prev === '/' || prev === '.') s += 30;
    return s;
  }
  // Subsequence match with bonuses for consecutive characters and word starts.
  let s = 0;
  let hi = 0;
  let run = 0;
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni];
    let found = -1;
    for (let k = hi; k < hay.length; k++) {
      if (hay[k] === ch) {
        found = k;
        break;
      }
    }
    if (found < 0) return -1;
    const gap = found - hi;
    run = gap === 0 && ni > 0 ? run + 1 : 0;
    s += 4 + run * 3 - Math.min(gap, 8) * 0.5;
    const prev = hay[found - 1];
    if (found === 0 || prev === '_' || prev === '/') s += 3;
    hi = found + 1;
  }
  return Math.max(1, s);
}

const KIND_BONUS: Record<SearchItem['kind'], number> = { cell: 12, port: 8, net: 4, pin: 0 };

export function searchItems(items: SearchItem[], query: string, limit = 50): SearchItem[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const scored: { it: SearchItem; s: number }[] = [];
  for (const it of items) {
    let total = 0;
    let ok = true;
    for (const t of tokens) {
      const byName = fuzzyScore(t, it.lname);
      const byPath = fuzzyScore(t, it.lpath);
      const s = Math.max(byName >= 0 ? byName * 2 : -1, byPath);
      if (s < 0) {
        ok = false;
        break;
      }
      total += s;
    }
    if (ok) scored.push({ it, s: total + KIND_BONUS[it.kind] - it.path.length * 0.05 });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.it);
}

/** Display scope for a result (`""` shown as the design name). */
export function scopeLabel(scope: string, designName: string): string {
  return scope ? scope : designName;
}

