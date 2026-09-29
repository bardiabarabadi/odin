/**
 * Design + scope + filters -> ELK graph and render metadata.
 *
 * Pure module: no DOM, no ELK runtime (types only). Text widths come from an
 * injectable `measure` function so the same code runs in tests.
 *
 * Geometry conventions (all node-relative):
 *   - A cell is a box `width x height` with a header of `GEOM.headerH`.
 *   - Pins are listed top to bottom, inputs on the WEST edge and outputs on
 *     the EAST edge. The ELK port is a short stub *outside* the box, so edges
 *     end at the tip of the stub and the label sits inside the box.
 *   - Ports use `FIXED_POS`: ELK never moves them, we own the pin order.
 */
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import type { ChangeKind } from '../../src/diff/types';
import type {
  Cell,
  CellKind,
  Design,
  IntfPin,
  Net,
  NetEndpoint,
  Pin,
  PinDirection,
  SourceLocation,
} from '../../src/model/types';
import { guessIntfMode, guessPinDirection, intfModeSide, type SiblingHints } from '../../src/model/heuristics';
import { isClockPin, isResetPin, leafName, parentPath } from '../../src/model/query';
import type { DiffContext } from './diff-index';
import { netKey, shortVlnv, widthLabel } from './state';

export type FontRole = 'title' | 'subtitle' | 'pin' | 'port';
export type MeasureText = (text: string, role: FontRole) => number;

/** Rough, font-independent fallback used when no canvas is available. */
export const approximateMeasure: MeasureText = (text, role) => {
  const perChar = role === 'title' ? 7.4 : role === 'subtitle' ? 6.2 : 6.4;
  return Math.ceil(text.length * perChar);
};

export const GEOM = {
  headerH: 38,
  pinPitch: 18,
  bodyPadTop: 8,
  bodyPadBottom: 8,
  padX: 8,
  stub: 12,
  columnGap: 24,
  minCellW: 150,
  glyphW: 18,
  badgeW: 26,
  portNodeH: 22,
  portNodePad: 12,
  portTip: 9,
} as const;

/**
 * Role of a pin *as seen from inside the displayed scope*:
 * `src` drives the net, `sink` is driven, `bidir` is inout.
 */
export type Role = 'src' | 'sink' | 'bidir' | 'unknown';
export type Side = 'WEST' | 'EAST';

export interface PinView {
  /** ELK port id. */
  id: string;
  /** Model path of the pin / port. */
  path: string;
  name: string;
  /** Owning node id. */
  nodeId: string;
  side: Side;
  role: Role;
  dir?: PinDirection;
  intf: boolean;
  type?: string;
  mode?: string;
  vlnv?: string;
  width?: string;
  inferred?: boolean;
  status?: ChangeKind;
  /** Anchor of the pin on the node edge (node-relative). */
  x: number;
  y: number;
  loc?: SourceLocation;
}

export interface NodeView {
  id: string;
  /** `cell` = child cell of the scope, `boundary` = scope pin / top-level port. */
  kind: 'cell' | 'boundary';
  path: string;
  name: string;
  cellKind?: CellKind;
  subtitle?: string;
  width: number;
  height: number;
  pins: PinView[];
  status?: ChangeKind;
  /** Number of changes inside a hier cell (diff overlay). */
  changeCount?: number;
  loc?: SourceLocation;
  /** For boundary nodes: shape and the side its single pin sits on. */
  boundaryRole?: Role;
  intf?: boolean;
}

export interface EdgeView {
  id: string;
  netKey: string;
  source: string;
  target: string;
  intf: boolean;
  status?: ChangeKind;
}

export interface NetView {
  key: string;
  name: string;
  scope: string;
  kind: 'signal' | 'interface';
  /** Visible endpoint pin paths. */
  endpoints: string[];
  edgeIds: string[];
  status?: ChangeKind;
  loc?: SourceLocation;
  clockOrReset: boolean;
}

export interface SceneGraph {
  scope: string;
  elk: ElkNode;
  nodes: Map<string, NodeView>;
  /** Node id by model path (cells and boundary ports). */
  nodeByPath: Map<string, string>;
  /** Visible pins by model path. */
  pins: Map<string, PinView>;
  nets: Map<string, NetView>;
  edges: Map<string, EdgeView>;
  /** Pin path -> keys of visible nets touching it. */
  pinNets: Map<string, string[]>;
  hiddenNets: number;
  hiddenPins: number;
}

export interface GraphOptions {
  scope: string;
  hideClockReset: boolean;
  hideUnconnected: boolean;
  diff?: DiffContext;
  measure?: MeasureText;
}

export const ROOT_LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.semiInteractive': 'false',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.unnecessaryBendpoints': 'false',
  'elk.spacing.nodeNode': '36',
  'elk.layered.spacing.nodeNodeBetweenLayers': '90',
  'elk.spacing.edgeNode': '18',
  'elk.spacing.edgeEdge': '9',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '9',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.spacing.componentComponent': '60',
  'elk.padding': '[top=40,left=40,bottom=40,right=40]',
};

/**
 * Overrides for large scopes. NETWORK_SIMPLEX node placement and model-order
 * crossing minimisation are the expensive parts of ELK layered; above the
 * threshold we trade some straightness for an order-of-magnitude speed-up
 * (150 cells / 440 edges: ~4 s -> ~0.3 s).
 */
export const LARGE_LAYOUT_OPTIONS: Record<string, string> = {
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.considerModelOrder.strategy': 'NONE',
  'elk.layered.thoroughness': '1',
  'elk.layered.crossingMinimization.greedySwitch.type': 'OFF',
};
export const LARGE_GRAPH_THRESHOLD = { nodes: 40, edges: 120 };

interface PinRecord {
  pin: Pin | IntfPin;
  intf: boolean;
  /** Owning cell path, or `null` for a top-level port. */
  owner: string | null;
}

/** Role of a pin on a child cell, from the child's point of view. */
function childRole(rec: PinRecord): Role {
  if (rec.intf) {
    const mode = (rec.pin as IntfPin).mode;
    if (mode === 'Master' || mode === 'MirroredSlave') return 'src';
    if (mode === 'Slave' || mode === 'MirroredMaster' || mode === 'Monitor') return 'sink';
    return 'unknown';
  }
  const dir = (rec.pin as Pin).dir;
  if (dir === 'O') return 'src';
  if (dir === 'I') return 'sink';
  if (dir === 'IO') return 'bidir';
  return 'unknown';
}

/** Boundary pins / top ports look inverted from inside the scope. */
function boundaryRole(rec: PinRecord): Role {
  return invertRole(childRole(rec));
}

function isClockOrResetNet(net: Net, lookup: Map<string, PinRecord>): boolean {
  if (net.kind !== 'signal') return false;
  return net.endpoints.some((e) => {
    const rec = lookup.get(e.path);
    if (!rec || rec.intf) return false;
    const pin = rec.pin as Pin;
    return isClockPin(pin) || isResetPin(pin);
  });
}

function dirToRole(dir: PinDirection | undefined): Role {
  return dir === 'O' ? 'src' : dir === 'I' ? 'sink' : dir === 'IO' ? 'bidir' : 'unknown';
}

function invertRole(r: Role): Role {
  return r === 'src' ? 'sink' : r === 'sink' ? 'src' : r;
}

/**
 * Guessed role of an undeclared pin from its owner's point of view, using the
 * shared heuristics in `src/model/heuristics.ts`: signal pins go through
 * `guessPinDirection` (name patterns + net hints), interface pins without a
 * mode through `guessIntfMode` + `intfModeSide`.
 */
function guessOwnRole(rec: PinRecord, hints?: SiblingHints): Role {
  if (!rec.intf) return dirToRole(guessPinDirection(rec.pin as Pin, undefined, hints));
  if (hints?.netHasDeclaredDriver) return 'sink';
  const side = intfModeSide(guessIntfMode(rec.pin as IntfPin));
  if (side === 'east') return 'src';
  if (side === 'west') return 'sink';
  return hints?.netHasDeclaredSink ? 'src' : 'unknown';
}

/** Guess a pin's role from its name alone; used only for pins without a direction. */
export function guessRoleFromName(name: string): Role {
  return dirToRole(guessPinDirection({ name, path: name }));
}

/**
 * Resolve `unknown` roles of the endpoints of one net, in place. Net-based
 * evidence is passed to the shared heuristics as `siblingHints`:
 *  1. a declared driver elsewhere on the net makes every unknown pin a sink;
 *  2. otherwise a pin whose name looks like an output (or a Master-looking
 *     interface) becomes the driver, the other unknowns are sinks;
 *  3. otherwise, if every other endpoint is (or looks like) a sink, the one
 *     remaining unguessed pin drives;
 *  4. pins whose name looks like an input become sinks; anything else stays
 *     `unknown` (drawn WEST).
 * Guesses for scope boundary pins are inverted like their declared roles.
 */
function resolveUnknownRoles(
  net: Net,
  lookup: Map<string, PinRecord>,
  roles: Map<string, Role>,
  isBoundary: (path: string) => boolean,
): void {
  const paths = [...new Set(net.endpoints.map((e) => e.path))].filter((p) => lookup.has(p));
  const unknown = paths.filter((p) => roles.get(p) === 'unknown');
  if (!unknown.length) return;
  const guess = (p: string, hints?: SiblingHints): Role => {
    const rec = lookup.get(p) as PinRecord;
    return isBoundary(p) ? invertRole(guessOwnRole(rec)) : guessOwnRole(rec, hints);
  };
  const hasSrc = paths.some((p) => roles.get(p) === 'src');
  if (hasSrc) {
    for (const p of unknown) roles.set(p, isBoundary(p) ? 'sink' : guess(p, { netHasDeclaredDriver: true }));
    return;
  }
  const guesses = new Map(unknown.map((p) => [p, guess(p)]));
  const driver = unknown.find((p) => guesses.get(p) === 'src');
  if (driver) {
    for (const p of unknown) roles.set(p, p === driver ? 'src' : 'sink');
    return;
  }
  const unguessed = unknown.filter((p) => guesses.get(p) !== 'sink');
  const othersAllSinks = (p: string): boolean =>
    paths.every((o) => o === p || roles.get(o) === 'sink' || guesses.get(o) === 'sink');
  if (unguessed.length === 1 && paths.length > 1 && othersAllSinks(unguessed[0])) {
    const lone = unguessed[0];
    const loneRole = isBoundary(lone) ? 'src' : guess(lone, { netHasDeclaredSink: true });
    for (const p of unknown) roles.set(p, p === lone ? loneRole : 'sink');
    return;
  }
  for (const p of unknown) if (guesses.get(p) === 'sink') roles.set(p, 'sink');
}

/** Order pins Vivado-style: interface pins first, then signals, source order. */
function sortPins<T extends { intf: boolean }>(list: T[]): T[] {
  return [...list.filter((p) => p.intf), ...list.filter((p) => !p.intf)];
}

export function buildGraph(design: Design, opts: GraphOptions): SceneGraph {
  const measure = opts.measure ?? approximateMeasure;
  const scope = opts.scope;
  const diff = opts.diff;

  const cellsByPath = new Map<string, Cell>();
  const childCounts = new Map<string, number>();
  for (const c of design.cells) {
    cellsByPath.set(c.path, c);
    childCounts.set(c.parent, (childCounts.get(c.parent) ?? 0) + 1);
  }
  const scopeCell = scope ? cellsByPath.get(scope) : undefined;
  const children = design.cells.filter((c) => c.parent === scope);
  const childPaths = new Set(children.map((c) => c.path));

  // Pin lookup for everything that can be an endpoint in this scope.
  const lookup = new Map<string, PinRecord>();
  const addCellPins = (c: Cell): void => {
    for (const p of c.pins) lookup.set(p.path, { pin: p, intf: false, owner: c.path });
    for (const p of c.intfPins) lookup.set(p.path, { pin: p, intf: true, owner: c.path });
  };
  children.forEach(addCellPins);
  if (scopeCell) addCellPins(scopeCell);
  if (!scope) {
    for (const p of design.ports) lookup.set(p.path, { pin: p, intf: false, owner: null });
    for (const p of design.intfPorts) lookup.set(p.path, { pin: p, intf: true, owner: null });
  }

  const synthesized = new Map<string, PinRecord[]>();
  const isBoundaryPath = (path: string): boolean =>
    scope ? parentPath(path) === scope : parentPath(path) === '' && !childPaths.has(path);

  /** Resolve an endpoint to a pin record, synthesising missing pins. */
  const resolve = (ep: NetEndpoint): PinRecord | undefined => {
    const hit = lookup.get(ep.path);
    if (hit) return hit;
    const intf = ep.kind === 'intfPin' || ep.kind === 'intfPort';
    const owner = parentPath(ep.path);
    if (isBoundaryPath(ep.path)) {
      if (!scope && ep.kind !== 'port' && ep.kind !== 'intfPort') return undefined;
      const rec: PinRecord = { pin: { name: leafName(ep.path), path: ep.path, inferred: true }, intf, owner: scope || null };
      lookup.set(ep.path, rec);
      return rec;
    }
    if (childPaths.has(owner)) {
      const rec: PinRecord = { pin: { name: leafName(ep.path), path: ep.path, inferred: true }, intf, owner };
      lookup.set(ep.path, rec);
      // Keep the synthesised pin visible on the cell (without mutating input).
      const extra = synthesized.get(owner) ?? [];
      extra.push(rec);
      synthesized.set(owner, extra);
      return rec;
    }
    return undefined;
  };

  // ---- nets & filters -------------------------------------------------------
  const scopeNets = design.nets.filter((n) => n.scope === scope);
  let hiddenNets = 0;
  const visibleNets: { net: Net; recs: PinRecord[]; clockOrReset: boolean }[] = [];
  const connected = new Set<string>();
  for (const net of scopeNets) {
    const recs: PinRecord[] = [];
    for (const ep of net.endpoints) {
      const rec = resolve(ep);
      if (rec) recs.push(rec);
    }
    const cr = isClockOrResetNet(net, lookup);
    if (opts.hideClockReset && cr) {
      hiddenNets++;
      continue;
    }
    visibleNets.push({ net, recs, clockOrReset: cr });
    for (const r of recs) connected.add(r.pin.path);
  }

  // ---- roles ---------------------------------------------------------------
  const roles = new Map<string, Role>();
  const baseRoleOf = (rec: PinRecord): Role => (isBoundaryPath(rec.pin.path) ? boundaryRole(rec) : childRole(rec));
  for (const rec of lookup.values()) roles.set(rec.pin.path, baseRoleOf(rec));
  // Unknown-direction heuristic, evaluated over *all* nets in scope so the
  // result does not depend on filters (keeps pins stable when toggling).
  for (const net of scopeNets) resolveUnknownRoles(net, lookup, roles, isBoundaryPath);
  // Pins on no net in this scope: name / interface-mode guess only.
  for (const rec of lookup.values()) {
    const p = rec.pin.path;
    if (roles.get(p) !== 'unknown') continue;
    const r = guessOwnRole(rec);
    roles.set(p, isBoundaryPath(p) ? invertRole(r) : r);
  }
  const roleOf = (path: string): Role => roles.get(path) ?? 'unknown';
  const sideOfChildPin = (path: string): Side => (roleOf(path) === 'src' ? 'EAST' : 'WEST');

  const status = {
    cell: (p: string) => diff?.index.cells.get(p),
    pin: (p: string) => diff?.index.pins.get(p),
    port: (p: string) => diff?.index.ports.get(p),
    net: (k: string) => diff?.index.nets.get(k),
  };

  // ---- nodes ---------------------------------------------------------------
  const nodes = new Map<string, NodeView>();
  const nodeByPath = new Map<string, string>();
  const pins = new Map<string, PinView>();
  let hiddenPins = 0;
  let nodeSeq = 0;
  let portSeq = 0;
  const elkChildren: ElkNode[] = [];

  const labelOf = (pv: { name: string; width?: string }): string => (pv.width ? `${pv.name} ${pv.width}` : pv.name);

  for (const cell of children) {
    const id = `n${nodeSeq++}`;
    const all: { rec: PinRecord; intf: boolean }[] = [
      ...cell.intfPins.map((p) => ({ rec: lookup.get(p.path) ?? { pin: p, intf: true, owner: cell.path }, intf: true })),
      ...cell.pins.map((p) => ({ rec: lookup.get(p.path) ?? { pin: p, intf: false, owner: cell.path }, intf: false })),
      ...(synthesized.get(cell.path) ?? []).map((rec) => ({ rec, intf: rec.intf })),
    ];
    const visible = sortPins(all).filter(({ rec }) => {
      if (opts.hideUnconnected && !connected.has(rec.pin.path)) {
        hiddenPins++;
        return false;
      }
      return true;
    });
    const west: PinView[] = [];
    const east: PinView[] = [];
    for (const { rec, intf } of visible) {
      const p = rec.pin;
      const pv: PinView = {
        id: `p${portSeq++}`,
        path: p.path,
        name: p.name,
        nodeId: id,
        side: sideOfChildPin(p.path),
        role: roleOf(p.path),
        dir: intf ? undefined : (p as Pin).dir,
        intf,
        type: intf ? undefined : (p as Pin).type,
        mode: intf ? (p as IntfPin).mode : undefined,
        vlnv: intf ? (p as IntfPin).vlnv : undefined,
        width: intf ? undefined : widthLabel((p as Pin).from, (p as Pin).to),
        inferred: p.inferred,
        status: status.pin(p.path),
        x: 0,
        y: 0,
        loc: p.loc,
      };
      (pv.side === 'WEST' ? west : east).push(pv);
    }

    const subtitle =
      cell.kind === 'ip'
        ? shortVlnv(cell.vlnv)
        : cell.kind === 'module'
          ? cell.reference
            ? `module: ${cell.reference}`
            : 'module'
          : cell.kind === 'hier'
            ? `hierarchy · ${childCounts.get(cell.path) ?? 0} cells`
            : undefined;
    const changeCount = cell.kind === 'hier' ? diff?.hierCounts.get(cell.path) : undefined;
    const titleW =
      measure(cell.name, 'title') +
      2 * GEOM.padX +
      (cell.kind === 'hier' ? GEOM.glyphW : 0) +
      (changeCount ? GEOM.badgeW : 0);
    const subW = subtitle ? measure(subtitle, 'subtitle') + 2 * GEOM.padX : 0;
    const westW = Math.max(0, ...west.map((p) => measure(labelOf(p), 'pin')));
    const eastW = Math.max(0, ...east.map((p) => measure(labelOf(p), 'pin')));
    const pinsW = westW + eastW + 2 * GEOM.padX + (west.length && east.length ? GEOM.columnGap : 0);
    const width = Math.ceil(Math.max(GEOM.minCellW, titleW, subW, pinsW));
    const rows = Math.max(west.length, east.length, 1);
    const height = GEOM.headerH + GEOM.bodyPadTop + rows * GEOM.pinPitch + GEOM.bodyPadBottom;

    const ports: ElkPort[] = [];
    const place = (list: PinView[], side: Side): void => {
      list.forEach((pv, i) => {
        pv.y = GEOM.headerH + GEOM.bodyPadTop + i * GEOM.pinPitch + GEOM.pinPitch / 2;
        pv.x = side === 'WEST' ? 0 : width;
        ports.push({
          id: pv.id,
          x: side === 'WEST' ? -GEOM.stub : width,
          y: pv.y - 1,
          width: GEOM.stub,
          height: 2,
          layoutOptions: { 'elk.port.side': side },
        });
        pins.set(pv.path, pv);
      });
    };
    place(west, 'WEST');
    place(east, 'EAST');

    const view: NodeView = {
      id,
      kind: 'cell',
      path: cell.path,
      name: cell.name,
      cellKind: cell.kind,
      subtitle,
      width,
      height,
      pins: [...west, ...east],
      status: status.cell(cell.path),
      changeCount,
      loc: cell.loc,
    };
    nodes.set(id, view);
    nodeByPath.set(cell.path, id);
    elkChildren.push({
      id,
      width,
      height,
      ports,
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
    });
  }

  // Boundary: hier pins of the scope cell, or top-level ports at root.
  const boundary: PinRecord[] = scopeCell
    ? [
        ...scopeCell.intfPins.map((p) => lookup.get(p.path) ?? { pin: p, intf: true, owner: scope }),
        ...scopeCell.pins.map((p) => lookup.get(p.path) ?? { pin: p, intf: false, owner: scope }),
      ]
    : [
        ...design.intfPorts.map((p) => lookup.get(p.path) ?? { pin: p, intf: true, owner: null }),
        ...design.ports.map((p) => lookup.get(p.path) ?? { pin: p, intf: false, owner: null }),
      ];
  // Synthesised boundary pins (referenced by nets but never declared).
  for (const rec of lookup.values()) {
    if (isBoundaryPath(rec.pin.path) && !boundary.includes(rec) && rec.pin.inferred) boundary.push(rec);
  }
  for (const rec of boundary) {
    const p = rec.pin;
    if (opts.hideUnconnected && !connected.has(p.path)) {
      hiddenPins++;
      continue;
    }
    const id = `n${nodeSeq++}`;
    const role = roleOf(p.path);
    // Sources enter from the left; sinks leave on the right; inouts and
    // unknowns stay on the left (Vivado convention).
    const onLeft = role !== 'sink';
    const pinSide: Side = onLeft ? 'EAST' : 'WEST';
    const width_ = !rec.intf ? widthLabel((p as Pin).from, (p as Pin).to) : undefined;
    const label = width_ ? `${p.name} ${width_}` : p.name;
    const width = Math.ceil(measure(label, 'port') + 2 * GEOM.portNodePad + GEOM.portTip);
    const height = GEOM.portNodeH;
    const pv: PinView = {
      id: `p${portSeq++}`,
      path: p.path,
      name: p.name,
      nodeId: id,
      side: pinSide,
      role,
      dir: rec.intf ? undefined : (p as Pin).dir,
      intf: rec.intf,
      type: rec.intf ? undefined : (p as Pin).type,
      mode: rec.intf ? (p as IntfPin).mode : undefined,
      vlnv: rec.intf ? (p as IntfPin).vlnv : undefined,
      width: width_,
      inferred: p.inferred,
      status: scope ? status.pin(p.path) : status.port(p.path),
      x: pinSide === 'EAST' ? width : 0,
      y: height / 2,
      loc: p.loc,
    };
    pins.set(pv.path, pv);
    const view: NodeView = {
      id,
      kind: 'boundary',
      path: p.path,
      name: p.name,
      width,
      height,
      pins: [pv],
      status: pv.status,
      loc: p.loc,
      boundaryRole: role,
      intf: rec.intf,
    };
    nodes.set(id, view);
    nodeByPath.set(p.path, id);
    elkChildren.push({
      id,
      width,
      height,
      ports: [
        {
          id: pv.id,
          x: pinSide === 'WEST' ? -GEOM.stub : width,
          y: height / 2 - 1,
          width: GEOM.stub,
          height: 2,
          layoutOptions: { 'elk.port.side': pinSide },
        },
      ],
      layoutOptions: {
        'elk.portConstraints': 'FIXED_POS',
        'elk.layered.layering.layerConstraint': onLeft ? 'FIRST' : 'LAST',
      },
    });
  }

  // ---- edges ---------------------------------------------------------------
  const nets = new Map<string, NetView>();
  const edges = new Map<string, EdgeView>();
  const pinNets = new Map<string, string[]>();
  const elkEdges: ElkExtendedEdge[] = [];
  let edgeSeq = 0;
  for (const { net, clockOrReset } of visibleNets) {
    const key = netKey(net.scope, net.name);
    const netStatus = status.net(key);
    const change = diff?.netChanges.get(key);
    const added = new Set(change?.addedEndpoints ?? []);
    const removed = new Set(change?.removedEndpoints ?? []);
    const endpoints = net.endpoints.map((e) => e.path).filter((p, i, arr) => pins.has(p) && arr.indexOf(p) === i);
    const view: NetView = {
      key,
      name: net.name,
      scope: net.scope,
      kind: net.kind,
      endpoints,
      edgeIds: [],
      status: netStatus,
      loc: net.loc,
      clockOrReset,
    };
    nets.set(key, view);
    for (const p of endpoints) {
      const list = pinNets.get(p) ?? [];
      list.push(key);
      pinNets.set(p, list);
    }
    if (endpoints.length < 2) continue;
    const source =
      endpoints.find((p) => roleOf(p) === 'src' && !removed.has(p)) ??
      endpoints.find((p) => roleOf(p) === 'bidir' && !removed.has(p)) ??
      endpoints.find((p) => !removed.has(p)) ??
      endpoints[0];
    const srcPin = pins.get(source) as PinView;
    for (const target of endpoints) {
      if (target === source) continue;
      const tgtPin = pins.get(target) as PinView;
      const id = `e${edgeSeq++}`;
      let edgeStatus: ChangeKind | undefined = netStatus === 'modified' ? undefined : netStatus;
      if (removed.has(target) || removed.has(source)) edgeStatus = 'removed';
      else if (added.has(target) || added.has(source)) edgeStatus = 'added';
      const edge: EdgeView = { id, netKey: key, source, target, intf: net.kind === 'interface', status: edgeStatus };
      edges.set(id, edge);
      view.edgeIds.push(id);
      elkEdges.push({ id, sources: [srcPin.id], targets: [tgtPin.id] });
    }
  }

  const large = elkChildren.length > LARGE_GRAPH_THRESHOLD.nodes || elkEdges.length > LARGE_GRAPH_THRESHOLD.edges;
  const elk: ElkNode = {
    id: 'root',
    layoutOptions: large ? { ...ROOT_LAYOUT_OPTIONS, ...LARGE_LAYOUT_OPTIONS } : { ...ROOT_LAYOUT_OPTIONS },
    children: elkChildren,
    edges: elkEdges,
  };
  return { scope, elk, nodes, nodeByPath, pins, nets, edges, pinNets, hiddenNets, hiddenPins };
}

/** Cache key for a layout: everything that changes geometry. */
export function layoutKey(opts: Pick<GraphOptions, 'scope' | 'hideClockReset' | 'hideUnconnected'>, version: number): string {
  return `${version}|${opts.hideClockReset ? 1 : 0}${opts.hideUnconnected ? 1 : 0}|${opts.scope}`;
}

/** Clears ELK-specific options that can make layout fail; used for retries. */
export function relaxLayoutOptions(elk: ElkNode): ElkNode {
  return {
    ...elk,
    children: elk.children?.map((c) => {
      const lo = { ...(c.layoutOptions ?? {}) };
      delete lo['elk.layered.layering.layerConstraint'];
      return { ...c, layoutOptions: lo };
    }),
  };
}

// Exported for tests.
export const __test = { childRole, boundaryRole };
