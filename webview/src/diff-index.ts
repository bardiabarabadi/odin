/**
 * Everything the webview derives from a `DesignDiff`:
 *   - `buildDiffIndex`: O(1) status lookups by path (the `DiffIndex` contract).
 *   - `buildDiffContext`: index + per-net endpoint changes + change counts per
 *     hierarchy (for the badges on hier cells).
 *   - `mergeDesigns`: the head design plus the removed objects taken from the
 *     base design, so removed things can be laid out and drawn as ghosts.
 *   - `listChanges`: flat, navigable list for the Changes panel.
 *
 * Pure module (no DOM).
 */
import type { ChangeKind, DesignDiff, DiffIndex, NetChange } from '../../src/diff/types';
import type { Cell, Design, IntfPin, Net, Pin } from '../../src/model/types';
import { parentPath } from '../../src/model/query';
import { netKey, type NavTarget } from './state';

export interface DiffContext {
  diff: DesignDiff;
  index: DiffIndex;
  /** keyed by net key (`scope::name`) */
  netChanges: Map<string, NetChange>;
  /** Hier cell path -> number of changes located inside it (at any depth). */
  hierCounts: Map<string, number>;
  /** Cell path -> property changes for that cell. */
  propertyChanges: Map<string, { key: string; before?: string; after?: string }[]>;
}

export function buildDiffIndex(diff: DesignDiff): DiffIndex {
  const index: DiffIndex = {
    cells: new Map(),
    pins: new Map(),
    ports: new Map(),
    nets: new Map(),
  };
  for (const c of diff.cells) index.cells.set(c.path, c.kind);
  for (const p of diff.pins) index.pins.set(p.path, p.kind);
  for (const p of diff.ports) index.ports.set(p.path, p.kind);
  for (const n of diff.nets) index.nets.set(netKey(n.scope, n.name), n.kind);
  // A cell whose properties or pins changed is "modified" even if the diff
  // engine did not list it explicitly.
  const markModified = (cellPath: string): void => {
    if (cellPath && !index.cells.has(cellPath)) index.cells.set(cellPath, 'modified');
  };
  for (const pc of diff.properties) markModified(pc.path);
  for (const p of diff.pins) {
    // Inferred-pin churn is a side effect of a net change, not a change to the
    // cell itself (see docs/DESIGN_MODEL.md); the pin is still colored.
    if (p.inferred) continue;
    const cell = parentPath(p.path);
    if (index.cells.get(cell) !== 'removed' && index.cells.get(cell) !== 'added') markModified(cell);
  }
  return index;
}

/** Scope in which an object of the given kind is drawn. */
function scopeOfCell(cellPath: string): string {
  return parentPath(cellPath);
}

function bumpAncestors(counts: Map<string, number>, scope: string): void {
  let s = scope;
  while (s) {
    counts.set(s, (counts.get(s) ?? 0) + 1);
    s = parentPath(s);
  }
}

export function buildDiffContext(diff: DesignDiff): DiffContext {
  const index = buildDiffIndex(diff);
  const netChanges = new Map<string, NetChange>();
  for (const n of diff.nets) netChanges.set(netKey(n.scope, n.name), n);

  const propertyChanges = new Map<string, { key: string; before?: string; after?: string }[]>();
  for (const pc of diff.properties) {
    const list = propertyChanges.get(pc.path) ?? [];
    list.push({ key: pc.key, before: pc.before, after: pc.after });
    propertyChanges.set(pc.path, list);
  }

  const hierCounts = new Map<string, number>();
  const listedCells = new Set(diff.cells.map((c) => c.path));
  for (const c of diff.cells) bumpAncestors(hierCounts, scopeOfCell(c.path));
  // Pins sit on a cell; they are drawn in the scope that contains the cell.
  for (const p of diff.pins) bumpAncestors(hierCounts, scopeOfCell(parentPath(p.path)));
  for (const n of diff.nets) bumpAncestors(hierCounts, n.scope);
  // Count property changes once per cell, and only when the cell itself is not
  // already counted as a changed entity.
  for (const cellPath of propertyChanges.keys()) {
    if (!listedCells.has(cellPath)) bumpAncestors(hierCounts, scopeOfCell(cellPath));
  }
  return { diff, index, netChanges, hierCounts, propertyChanges };
}

function clonePins<T extends Pin | IntfPin>(list: T[]): T[] {
  return list.map((p) => ({ ...p }));
}

/**
 * Head design + removed objects from base. The result is a fresh object; the
 * inputs are not mutated. Removed endpoints of modified nets are appended to
 * the head net so the ghost connection can be drawn.
 */
export function mergeDesigns(head: Design, base: Design, ctx: DiffContext): Design {
  const { index } = ctx;
  const baseCells = new Map(base.cells.map((c) => [c.path, c]));

  const cells: Cell[] = head.cells.map((c) => {
    const baseCell = baseCells.get(c.path);
    const pins = clonePins(c.pins);
    const intfPins = clonePins(c.intfPins);
    if (baseCell) {
      const have = new Set([...pins.map((p) => p.path), ...intfPins.map((p) => p.path)]);
      for (const p of baseCell.pins) if (!have.has(p.path) && index.pins.get(p.path) === 'removed') pins.push({ ...p });
      for (const p of baseCell.intfPins)
        if (!have.has(p.path) && index.pins.get(p.path) === 'removed') intfPins.push({ ...p });
    }
    return { ...c, pins, intfPins };
  });
  const headCellPaths = new Set(head.cells.map((c) => c.path));
  for (const c of base.cells) {
    if (!headCellPaths.has(c.path) && index.cells.get(c.path) === 'removed') {
      cells.push({ ...c, pins: clonePins(c.pins), intfPins: clonePins(c.intfPins) });
    }
  }

  const headPorts = new Set([...head.ports.map((p) => p.path), ...head.intfPorts.map((p) => p.path)]);
  const ports = clonePins(head.ports);
  const intfPorts = clonePins(head.intfPorts);
  for (const p of base.ports) if (!headPorts.has(p.path) && index.ports.get(p.path) === 'removed') ports.push({ ...p });
  for (const p of base.intfPorts)
    if (!headPorts.has(p.path) && index.ports.get(p.path) === 'removed') intfPorts.push({ ...p });

  const baseNets = new Map(base.nets.map((n) => [netKey(n.scope, n.name), n]));
  const nets: Net[] = head.nets.map((n) => {
    const key = netKey(n.scope, n.name);
    const change = ctx.netChanges.get(key);
    const endpoints = n.endpoints.map((e) => ({ ...e }));
    if (change?.removedEndpoints?.length) {
      const have = new Set(endpoints.map((e) => e.path));
      const baseNet = baseNets.get(key);
      for (const path of change.removedEndpoints) {
        if (have.has(path)) continue;
        const kind = baseNet?.endpoints.find((e) => e.path === path)?.kind ?? endpoints[0]?.kind ?? 'pin';
        endpoints.push({ path, kind });
      }
    }
    return { ...n, endpoints };
  });
  const headNetKeys = new Set(head.nets.map((n) => netKey(n.scope, n.name)));
  for (const n of base.nets) {
    const key = netKey(n.scope, n.name);
    if (!headNetKeys.has(key) && index.nets.get(key) === 'removed') {
      nets.push({ ...n, endpoints: n.endpoints.map((e) => ({ ...e })) });
    }
  }

  return { ...head, cells, ports, intfPorts, nets };
}

export type ChangeGroup = 'Cells' | 'Pins' | 'Ports' | 'Nets' | 'Properties' | 'Addresses';

export interface ChangeItem {
  group: ChangeGroup;
  kind: ChangeKind;
  /** Primary text, usually the object path. */
  label: string;
  detail?: string;
  target?: NavTarget;
}

export function listChanges(diff: DesignDiff): ChangeItem[] {
  const items: ChangeItem[] = [];
  for (const c of diff.cells) {
    items.push({
      group: 'Cells',
      kind: c.kind,
      label: c.path,
      detail: c.detail,
      target: { scope: parentPath(c.path), select: { kind: 'cell', path: c.path } },
    });
  }
  for (const p of diff.pins) {
    const cell = parentPath(p.path);
    items.push({
      group: 'Pins',
      kind: p.kind,
      label: p.path,
      detail: p.detail,
      target: { scope: parentPath(cell), select: { kind: 'pin', path: p.path } },
    });
  }
  for (const p of diff.ports) {
    items.push({
      group: 'Ports',
      kind: p.kind,
      label: p.path,
      detail: p.detail,
      target: { scope: '', select: { kind: 'port', path: p.path } },
    });
  }
  for (const n of diff.nets) {
    const parts: string[] = [];
    if (n.detail) parts.push(n.detail);
    if (n.addedEndpoints?.length) parts.push(`+ ${n.addedEndpoints.join(', ')}`);
    if (n.removedEndpoints?.length) parts.push(`− ${n.removedEndpoints.join(', ')}`);
    items.push({
      group: 'Nets',
      kind: n.kind,
      label: n.scope ? `${n.scope}/${n.name}` : n.name,
      detail: parts.join(' · ') || undefined,
      target: { scope: n.scope, select: { kind: 'net', path: netKey(n.scope, n.name) } },
    });
  }
  for (const pc of diff.properties) {
    const kind: ChangeKind = pc.before === undefined ? 'added' : pc.after === undefined ? 'removed' : 'modified';
    items.push({
      group: 'Properties',
      kind,
      label: `${pc.path || '(design)'} · ${pc.key}`,
      detail: `${pc.before ?? '∅'} → ${pc.after ?? '∅'}`,
      target: pc.path ? { scope: parentPath(pc.path), select: { kind: 'cell', path: pc.path } } : undefined,
    });
  }
  for (const a of diff.addressAssignments) {
    items.push({ group: 'Addresses', kind: a.kind, label: a.path, detail: a.detail });
  }
  return items;
}
