/**
 * Semantic diff engine: compares two `Design`s (base -> head).
 *
 * Pure TypeScript with no Node or VS Code APIs, so both the extension host and
 * the webview bundle can import it. See `README.md` in this folder for the
 * matching rules and what counts as a change.
 */
import type {
  AddressAssignment,
  Cell,
  Design,
  IntfPin,
  Net,
  Pin,
} from '../model/types';
import type {
  ChangeCounts,
  ChangeKind,
  DesignDiff,
  DiffIndex,
  EntityChange,
  NetChange,
  NetRename,
  PropertyChange,
} from './types';
export * from './types';

export interface DiffOptions {
  baseLabel: string;
  headLabel: string;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a raw property value for comparison: trim whitespace and strip
 * one pair of outer braces (`{100}` == `100` == ` 100 `). Whitespace inside
 * the braces is trimmed too.
 */
export function normalizeValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let v = value.trim();
  if (v.length >= 2 && v.startsWith('{') && v.endsWith('}')) v = v.slice(1, -1).trim();
  return v;
}

function sameValue(a: string | undefined, b: string | undefined): boolean {
  return normalizeValue(a) === normalizeValue(b);
}

/** Key used for nets in `DiffIndex.nets`. */
export function netKey(scope: string, name: string): string {
  return `${scope}::${name}`;
}

/** Key / path used for address assignments. */
export function addressKey(a: Pick<AddressAssignment, 'masterSpace' | 'slaveSegment'>): string {
  return `${a.masterSpace} -> ${a.slaveSegment}`;
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const KIND_ORDER: Record<ChangeKind, number> = { removed: 0, added: 1, modified: 2 };

function byPathThenKind(a: EntityChange, b: EntityChange): number {
  return cmp(a.path, b.path) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
}

function fmt(v: string | number | undefined): string {
  return v === undefined ? '(none)' : String(v);
}

// ---------------------------------------------------------------------------
// Property comparison
// ---------------------------------------------------------------------------

function diffProperties(
  path: string,
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined,
  out: PropertyChange[],
): number {
  const b = before ?? {};
  const a = after ?? {};
  let n = 0;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const key of keys) {
    const hasB = Object.prototype.hasOwnProperty.call(b, key);
    const hasA = Object.prototype.hasOwnProperty.call(a, key);
    if (hasB && hasA && sameValue(b[key], a[key])) continue;
    const change: PropertyChange = { path, key };
    if (hasB) change.before = b[key];
    if (hasA) change.after = a[key];
    out.push(change);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Pins (cell pins, interface pins, top-level ports)
// ---------------------------------------------------------------------------

type AnyPin = { tag: 'pin'; pin: Pin } | { tag: 'intf'; pin: IntfPin };

/**
 * Optional `properties` bag on pins/ports. The model does not carry one today;
 * this lets the diff pick it up automatically if an adapter adds it later.
 */
function pinProps(p: Pin | IntfPin): Record<string, string> | undefined {
  return (p as { properties?: Record<string, string> }).properties;
}

function indexPins(pins: readonly Pin[], intfPins: readonly IntfPin[]): Map<string, AnyPin> {
  const m = new Map<string, AnyPin>();
  for (const p of pins) m.set(p.path, { tag: 'pin', pin: p });
  for (const p of intfPins) m.set(p.path, { tag: 'intf', pin: p });
  return m;
}

/** Describe declared-attribute differences between two pins; empty = same. */
function pinAttrDiffs(b: AnyPin, h: AnyPin): string[] {
  if (b.tag !== h.tag) {
    return [b.tag === 'pin' ? 'changed from pin to interface pin' : 'changed from interface pin to pin'];
  }
  const out: string[] = [];
  if (b.tag === 'pin' && h.tag === 'pin') {
    const bp = b.pin;
    const hp = h.pin;
    if (bp.dir !== hp.dir) out.push(`dir ${fmt(bp.dir)} -> ${fmt(hp.dir)}`);
    if (bp.type !== hp.type) out.push(`type ${fmt(bp.type)} -> ${fmt(hp.type)}`);
    if (bp.from !== hp.from || bp.to !== hp.to) {
      const w = (p: Pin): string => (p.from === undefined && p.to === undefined ? 'scalar' : `[${fmt(p.from)}:${fmt(p.to)}]`);
      out.push(`width ${w(bp)} -> ${w(hp)}`);
    }
  } else if (b.tag === 'intf' && h.tag === 'intf') {
    if (b.pin.mode !== h.pin.mode) out.push(`mode ${fmt(b.pin.mode)} -> ${fmt(h.pin.mode)}`);
    if (b.pin.vlnv !== h.pin.vlnv) out.push(`vlnv ${fmt(b.pin.vlnv)} -> ${fmt(h.pin.vlnv)}`);
  }
  return out;
}

interface PinSetResult {
  changes: EntityChange[];
  /** Number of changes that are semantic (not inferred-pin churn). */
  declaredChanges: number;
}

/**
 * Compare two pin sets. Inferred pins that appear/disappear are reported with
 * `inferred: true` and do not count as declared changes. Attributes are only
 * compared when both sides are declared (inferred pins carry no reliable
 * attributes). Property changes on pins/ports are appended to `props`.
 */
function diffPinSets(base: Map<string, AnyPin>, head: Map<string, AnyPin>, props: PropertyChange[]): PinSetResult {
  const changes: EntityChange[] = [];
  let declaredChanges = 0;
  for (const [path, b] of base) {
    const h = head.get(path);
    if (!h) {
      const inferred = b.pin.inferred === true;
      changes.push(inferred ? { path, kind: 'removed', detail: 'inferred from connectivity', inferred } : { path, kind: 'removed' });
      if (!inferred) declaredChanges++;
      continue;
    }
    if (b.pin.inferred || h.pin.inferred) continue;
    const diffs = pinAttrDiffs(b, h);
    const nProps = diffProperties(path, pinProps(b.pin), pinProps(h.pin), props);
    if (nProps > 0) diffs.push(`${nProps} propert${nProps === 1 ? 'y' : 'ies'} changed`);
    if (diffs.length > 0) {
      changes.push({ path, kind: 'modified', detail: diffs.join('; ') });
      declaredChanges++;
    }
  }
  for (const [path, h] of head) {
    if (base.has(path)) continue;
    const inferred = h.pin.inferred === true;
    changes.push(inferred ? { path, kind: 'added', detail: 'inferred from connectivity', inferred } : { path, kind: 'added' });
    if (!inferred) declaredChanges++;
  }
  return { changes, declaredChanges };
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

function diffCells(base: Design, head: Design, cells: EntityChange[], pins: EntityChange[], props: PropertyChange[]): void {
  const baseCells = new Map<string, Cell>(base.cells.map((c) => [c.path, c]));
  const headCells = new Map<string, Cell>(head.cells.map((c) => [c.path, c]));

  for (const [path, b] of baseCells) {
    const h = headCells.get(path);
    if (!h) {
      cells.push({ path, kind: 'removed' });
      continue;
    }
    const reasons: string[] = [];
    if (b.kind !== h.kind) reasons.push(`kind ${b.kind} -> ${h.kind}`);
    if (b.vlnv !== h.vlnv) reasons.push(`vlnv ${fmt(b.vlnv)} -> ${fmt(h.vlnv)}`);
    if (b.reference !== h.reference) reasons.push(`reference ${fmt(b.reference)} -> ${fmt(h.reference)}`);
    const nProps = diffProperties(path, b.properties, h.properties, props);
    if (nProps > 0) reasons.push(`${nProps} propert${nProps === 1 ? 'y' : 'ies'} changed`);
    const pinResult = diffPinSets(indexPins(b.pins, b.intfPins), indexPins(h.pins, h.intfPins), props);
    pins.push(...pinResult.changes);
    if (pinResult.declaredChanges > 0) {
      const n = pinResult.declaredChanges;
      reasons.push(`${n} pin${n === 1 ? '' : 's'} changed`);
    }
    if (reasons.length > 0) cells.push({ path, kind: 'modified', detail: reasons.join('; ') });
  }
  for (const path of headCells.keys()) {
    if (!baseCells.has(path)) cells.push({ path, kind: 'added' });
  }
}

// ---------------------------------------------------------------------------
// Nets
// ---------------------------------------------------------------------------

function endpointSet(n: Net): Set<string> {
  return new Set(n.endpoints.map((e) => e.path));
}

function endpointSignature(n: Net): string {
  // `\n` cannot appear in a path, so it is a safe separator.
  return `${n.scope}\n${n.kind}\n${[...endpointSet(n)].sort().join('\n')}`;
}

function diffNets(base: Design, head: Design, nets: NetChange[], renames: NetRename[]): void {
  const headByName = new Map<string, Net>();
  for (const n of head.nets) headByName.set(netKey(n.scope, n.name), n);

  const unmatchedBase: Net[] = [];
  const matchedHead = new Set<Net>();

  // Pass 1: match by scope + name (same kind).
  for (const b of base.nets) {
    const h = headByName.get(netKey(b.scope, b.name));
    if (!h || h.kind !== b.kind || matchedHead.has(h)) {
      unmatchedBase.push(b);
      continue;
    }
    matchedHead.add(h);
    const be = endpointSet(b);
    const he = endpointSet(h);
    const removedEndpoints = [...be].filter((p) => !he.has(p)).sort();
    const addedEndpoints = [...he].filter((p) => !be.has(p)).sort();
    if (addedEndpoints.length || removedEndpoints.length) {
      const parts: string[] = [];
      if (addedEndpoints.length) parts.push(`+${addedEndpoints.length} endpoint${addedEndpoints.length === 1 ? '' : 's'}`);
      if (removedEndpoints.length) parts.push(`-${removedEndpoints.length} endpoint${removedEndpoints.length === 1 ? '' : 's'}`);
      nets.push({
        path: joinPath(b.scope, b.name),
        kind: 'modified',
        scope: b.scope,
        name: b.name,
        addedEndpoints,
        removedEndpoints,
        detail: parts.join(', '),
      });
    }
  }
  const unmatchedHead = head.nets.filter((n) => !matchedHead.has(n));

  // Pass 2: among nets unmatched by name, pair those with identical endpoint
  // sets in the same scope and of the same kind. Such pairs are renames only.
  const headBySig = new Map<string, Net[]>();
  for (const h of [...unmatchedHead].sort((x, y) => cmp(x.name, y.name))) {
    const sig = endpointSignature(h);
    const list = headBySig.get(sig);
    if (list) list.push(h);
    else headBySig.set(sig, [h]);
  }
  const renamedHead = new Set<Net>();
  const stillUnmatchedBase: Net[] = [];
  for (const b of [...unmatchedBase].sort((x, y) => cmp(x.name, y.name))) {
    const list = b.endpoints.length > 0 ? headBySig.get(endpointSignature(b)) : undefined;
    const h = list?.shift();
    if (!h) {
      stillUnmatchedBase.push(b);
      continue;
    }
    renamedHead.add(h);
    if (h.name !== b.name) renames.push({ scope: b.scope, kind: b.kind, baseName: b.name, headName: h.name });
  }

  for (const b of stillUnmatchedBase) {
    nets.push({
      path: joinPath(b.scope, b.name),
      kind: 'removed',
      scope: b.scope,
      name: b.name,
      removedEndpoints: [...endpointSet(b)].sort(),
      detail: `${b.kind} net removed`,
    });
  }
  for (const h of unmatchedHead) {
    if (renamedHead.has(h)) continue;
    nets.push({
      path: joinPath(h.scope, h.name),
      kind: 'added',
      scope: h.scope,
      name: h.name,
      addedEndpoints: [...endpointSet(h)].sort(),
      detail: `${h.kind} net added`,
    });
  }
}

// ---------------------------------------------------------------------------
// Address assignments and tool metadata
// ---------------------------------------------------------------------------

function diffAddressAssignments(base: Design, head: Design, out: EntityChange[]): void {
  const b = new Map(base.addressAssignments.map((a) => [addressKey(a), a]));
  const h = new Map(head.addressAssignments.map((a) => [addressKey(a), a]));
  for (const [key, ba] of b) {
    const ha = h.get(key);
    if (!ha) {
      out.push({ path: key, kind: 'removed' });
      continue;
    }
    const parts: string[] = [];
    if (!sameValue(ba.offset, ha.offset)) parts.push(`offset ${fmt(ba.offset)} -> ${fmt(ha.offset)}`);
    if (!sameValue(ba.range, ha.range)) parts.push(`range ${fmt(ba.range)} -> ${fmt(ha.range)}`);
    if (parts.length) out.push({ path: key, kind: 'modified', detail: parts.join('; ') });
  }
  for (const key of h.keys()) if (!b.has(key)) out.push({ path: key, kind: 'added' });
}

function toolProps(d: Design): Record<string, string> {
  const out: Record<string, string> = {};
  const t = d.tool;
  if (!t) return out;
  if (t.name !== undefined) out['tool.name'] = t.name;
  if (t.version !== undefined) out['tool.version'] = t.version;
  if (t.part !== undefined) out['tool.part'] = t.part;
  if (t.board !== undefined) out['tool.board'] = t.board;
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Semantic diff base -> head. Pure; safe in the extension host and webview. */
export function diffDesigns(base: Design, head: Design, opts: DiffOptions): DesignDiff {
  const cells: EntityChange[] = [];
  const pins: EntityChange[] = [];
  const ports: EntityChange[] = [];
  const nets: NetChange[] = [];
  const properties: PropertyChange[] = [];
  const addressAssignments: EntityChange[] = [];
  const netRenames: NetRename[] = [];

  diffProperties('', toolProps(base), toolProps(head), properties);
  diffCells(base, head, cells, pins, properties);
  ports.push(...diffPinSets(indexPins(base.ports, base.intfPorts), indexPins(head.ports, head.intfPorts), properties).changes);
  diffNets(base, head, nets, netRenames);
  diffAddressAssignments(base, head, addressAssignments);

  cells.sort(byPathThenKind);
  pins.sort(byPathThenKind);
  ports.sort(byPathThenKind);
  nets.sort(byPathThenKind);
  addressAssignments.sort(byPathThenKind);
  properties.sort((a, b) => cmp(a.path, b.path) || cmp(a.key, b.key));
  netRenames.sort((a, b) => cmp(a.scope, b.scope) || cmp(a.baseName, b.baseName) || cmp(a.headName, b.headName));

  const count = (list: readonly EntityChange[], kind: ChangeKind): number => list.filter((c) => c.kind === kind).length;

  return {
    baseLabel: opts.baseLabel,
    headLabel: opts.headLabel,
    cells,
    pins,
    ports,
    nets,
    properties,
    addressAssignments,
    netRenames,
    summary: {
      cellsAdded: count(cells, 'added'),
      cellsRemoved: count(cells, 'removed'),
      cellsModified: count(cells, 'modified'),
      netsAdded: count(nets, 'added'),
      netsRemoved: count(nets, 'removed'),
      netsModified: count(nets, 'modified'),
      propertiesChanged: properties.length,
      pinsChanged: pins.length,
      portsChanged: ports.length,
      addressAssignmentsChanged: addressAssignments.length,
    },
  };
}

/** True when the diff contains no changes at all (renames are not changes). */
export function isEmptyDiff(diff: DesignDiff): boolean {
  return (
    diff.cells.length === 0 &&
    diff.pins.length === 0 &&
    diff.ports.length === 0 &&
    diff.nets.length === 0 &&
    diff.properties.length === 0 &&
    diff.addressAssignments.length === 0
  );
}

function setKind(map: Map<string, ChangeKind>, key: string, kind: ChangeKind): void {
  const prev = map.get(key);
  // Two entries under one key (e.g. a net whose kind changed is reported as
  // removed + added under the same name) collapse to 'modified'.
  map.set(key, prev === undefined || prev === kind ? kind : 'modified');
}

/** Build O(1) lookup maps for the renderer. */
export function buildDiffIndex(diff: DesignDiff): DiffIndex {
  const cells = new Map<string, ChangeKind>();
  const pins = new Map<string, ChangeKind>();
  const ports = new Map<string, ChangeKind>();
  const nets = new Map<string, ChangeKind>();
  const addressAssignments = new Map<string, ChangeKind>();
  const properties = new Map<string, PropertyChange[]>();
  for (const c of diff.cells) setKind(cells, c.path, c.kind);
  for (const c of diff.pins) setKind(pins, c.path, c.kind);
  for (const c of diff.ports) setKind(ports, c.path, c.kind);
  for (const c of diff.nets) setKind(nets, netKey(c.scope, c.name), c.kind);
  for (const c of diff.addressAssignments) setKind(addressAssignments, c.path, c.kind);
  for (const p of diff.properties) {
    const list = properties.get(p.path);
    if (list) list.push(p);
    else properties.set(p.path, [p]);
  }
  return { cells, pins, ports, nets, addressAssignments, properties };
}

/**
 * Count changes strictly inside a hierarchical cell, for "N changes inside"
 * badges. Counted: descendant cells, declared pins of descendant cells (not
 * the hier cell's own boundary pins, which show on the block itself; inferred
 * pin churn is skipped because the net change already covers it), and nets
 * whose scope is `hierPath` or any descendant scope.
 *
 * For the root (`hierPath === ""`) everything is counted, including top-level
 * ports, address assignments and design-level (`""`) property changes.
 * Cell property changes are not counted separately: they are already
 * represented by the owning cell's `modified` entry.
 */
export function countChangesUnder(diff: DesignDiff, hierPath: string): ChangeCounts {
  const counts: ChangeCounts = { added: 0, removed: 0, modified: 0, total: 0 };
  const bump = (kind: ChangeKind): void => {
    counts[kind]++;
    counts.total++;
  };
  const isRoot = hierPath === '';
  const prefix = isRoot ? '' : `${hierPath}/`;
  const inside = (path: string): boolean => path.startsWith(prefix);

  for (const c of diff.cells) if (inside(c.path) && c.path !== hierPath) bump(c.kind);
  for (const p of diff.pins) {
    if (p.inferred) continue;
    if (inside(p.path) && parentPath(p.path) !== hierPath) bump(p.kind);
  }
  for (const n of diff.nets) if (n.scope === hierPath || (n.scope !== '' && inside(n.scope))) bump(n.kind);
  if (isRoot) {
    for (const p of diff.ports) if (!p.inferred) bump(p.kind);
    for (const a of diff.addressAssignments) bump(a.kind);
    for (const p of diff.properties) if (p.path === '') bump('modified');
  }
  return counts;
}
