/**
 * Virtual block design that Vivado BD commands operate on. It owns the
 * objects being built (cells, pins, ports, nets, address assignments), the
 * current hierarchy scope, and the diagnostics; `toDesign()` produces the
 * common model.
 */
import { joinPath, parentPath } from '../../model/query';
import type {
  AddressAssignment,
  Cell,
  CellKind,
  Design,
  Diagnostic,
  DiagnosticSeverity,
  IntfPin,
  Net,
  NetEndpoint,
  Pin,
  PinDirection,
  SourceLocation,
} from '../../model/types';

export interface PinSpec {
  name: string;
  dir?: PinDirection;
  type?: string;
  from?: number;
  to?: number;
  properties?: Record<string, string>;
}

export interface IntfPinSpec {
  name: string;
  mode?: string;
  vlnv?: string;
}

export type PropertyTarget =
  | { kind: 'cell'; path: string }
  | { kind: 'pin'; path: string }
  | { kind: 'intfPin'; path: string }
  | { kind: 'port'; path: string }
  | { kind: 'intfPort'; path: string };

/** The mode a peer must have to face an interface of the given mode. */
const OPPOSITE_MODE: Record<string, string> = {
  Master: 'Slave',
  Slave: 'Master',
  MirroredMaster: 'Master',
  MirroredSlave: 'Slave',
};

/** Normalise a path: collapse `//`, resolve `.` and `..`, strip leading `/`. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export class BdModel {
  designName = '';
  readonly tool: { name?: string; version?: string; part?: string; board?: string } = {};
  /** Current hierarchy scope (`current_bd_instance`), `''` = root. */
  scope = '';
  readonly diagnostics: Diagnostic[] = [];

  private readonly cells: Cell[] = [];
  private readonly cellIndex = new Map<string, Cell>();
  private readonly ports: Pin[] = [];
  private readonly portIndex = new Map<string, Pin>();
  private readonly intfPorts: IntfPin[] = [];
  private readonly intfPortIndex = new Map<string, IntfPin>();
  private readonly nets: Net[] = [];
  private readonly netIndex = new Map<string, Net>();
  private readonly addresses: AddressAssignment[] = [];

  constructor(readonly file: string) {}

  // ------------------------------------------------------------ helpers

  loc(line: number, endLine?: number): SourceLocation {
    return endLine !== undefined && endLine > line ? { file: this.file, line, endLine } : { file: this.file, line };
  }

  diag(severity: DiagnosticSeverity, message: string, loc?: SourceLocation): void {
    this.diagnostics.push(loc ? { severity, message, loc } : { severity, message });
  }

  /** Resolve a (possibly relative) BD object path against the current scope. */
  resolve(path: string): string {
    return path.startsWith('/') ? normalizePath(path) : normalizePath(joinPath(this.scope, path));
  }

  getCell(path: string): Cell | undefined {
    return this.cellIndex.get(path);
  }

  cellPaths(): string[] {
    return this.cells.map((c) => c.path);
  }

  /** True for the root and for hierarchical cells. */
  isHier(path: string): boolean {
    return path === '' || this.cellIndex.get(path)?.kind === 'hier';
  }

  hasPort(name: string): boolean {
    return this.portIndex.has(name);
  }

  hasIntfPort(name: string): boolean {
    return this.intfPortIndex.has(name);
  }

  // ------------------------------------------------------------ creation

  createCell(name: string, kind: CellKind, extra: { vlnv?: string; reference?: string }, loc: SourceLocation): string {
    const path = this.resolve(name);
    const existing = this.cellIndex.get(path);
    if (existing) {
      this.diag('warning', `Cell "${path}" is created more than once; keeping the first definition.`, loc);
      return path;
    }
    const parent = parentPath(path);
    if (!this.isHier(parent)) this.diag('warning', `Cell "${path}" is created inside "${parent}", which is not a hierarchical cell.`, loc);
    const cell: Cell = {
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      parent,
      kind,
      ...(extra.vlnv !== undefined ? { vlnv: extra.vlnv } : {}),
      ...(extra.reference !== undefined ? { reference: extra.reference } : {}),
      properties: {},
      pins: [],
      intfPins: [],
      loc,
    };
    this.cells.push(cell);
    this.cellIndex.set(path, cell);
    return path;
  }

  /** Declare a pin on the hierarchical cell `owner` (the current scope). */
  createPin(owner: string, spec: PinSpec, loc: SourceLocation): string | undefined {
    const cell = this.cellIndex.get(owner);
    if (!cell) {
      this.diag('warning', `create_bd_pin "${spec.name}" outside of a hierarchical cell is ignored; use create_bd_port at the top level.`, loc);
      return undefined;
    }
    const path = joinPath(owner, spec.name);
    const pin = declarePin(cell.pins, path, spec, loc);
    if (!pin) this.diag('warning', `Pin "${path}" is declared more than once.`, loc);
    return path;
  }

  createIntfPin(owner: string, spec: IntfPinSpec, loc: SourceLocation): string | undefined {
    const cell = this.cellIndex.get(owner);
    if (!cell) {
      this.diag('warning', `create_bd_intf_pin "${spec.name}" outside of a hierarchical cell is ignored; use create_bd_intf_port at the top level.`, loc);
      return undefined;
    }
    const path = joinPath(owner, spec.name);
    if (!declareIntfPin(cell.intfPins, path, spec, loc)) this.diag('warning', `Interface pin "${path}" is declared more than once.`, loc);
    return path;
  }

  createPort(spec: PinSpec, loc: SourceLocation): string {
    if (this.portIndex.has(spec.name)) {
      this.diag('warning', `Port "${spec.name}" is declared more than once.`, loc);
      return spec.name;
    }
    const port = declarePin(this.ports, spec.name, spec, loc);
    if (port) this.portIndex.set(spec.name, port);
    return spec.name;
  }

  createIntfPort(spec: IntfPinSpec, loc: SourceLocation): string {
    if (this.intfPortIndex.has(spec.name)) {
      this.diag('warning', `Interface port "${spec.name}" is declared more than once.`, loc);
      return spec.name;
    }
    const port = declareIntfPin(this.intfPorts, spec.name, spec, loc);
    if (port) this.intfPortIndex.set(spec.name, port);
    return spec.name;
  }

  /** Find or infer a signal pin on a cell. Undefined when the cell is unknown. */
  ensurePin(path: string, loc: SourceLocation): Pin | undefined {
    const cell = this.cellIndex.get(parentPath(path));
    if (!cell) return undefined;
    const name = path.slice(path.lastIndexOf('/') + 1);
    let pin = cell.pins.find((p) => p.name === name);
    if (!pin) {
      pin = { name, path, inferred: true, loc };
      cell.pins.push(pin);
    }
    return pin;
  }

  ensureIntfPin(path: string, loc: SourceLocation): IntfPin | undefined {
    const cell = this.cellIndex.get(parentPath(path));
    if (!cell) return undefined;
    const name = path.slice(path.lastIndexOf('/') + 1);
    let pin = cell.intfPins.find((p) => p.name === name);
    if (!pin) {
      pin = { name, path, inferred: true, loc };
      cell.intfPins.push(pin);
    }
    return pin;
  }

  // ------------------------------------------------------------ nets

  /**
   * `connect_bd_net` / `connect_bd_intf_net`. `paths` are absolute object
   * paths (no leading slash). Nets with the same name in the same scope merge.
   */
  connect(kind: Net['kind'], name: string | undefined, paths: string[], loc: SourceLocation): void {
    const scope = this.scope;
    const endpoints: NetEndpoint[] = [];
    for (const path of paths) {
      if (!path) continue;
      const ep = this.endpointFor(kind, path, loc);
      if (!endpoints.some((e) => e.path === ep.path && e.kind === ep.kind)) endpoints.push(ep);
    }
    const netName = name || this.synthesizeNetName(scope, kind, endpoints);
    if (endpoints.length === 0) {
      this.diag('warning', `Net "${netName}" has no endpoints; it was dropped.`, loc);
      return;
    }
    const key = `${scope}\u0000${kind}\u0000${netName}`;
    const existing = this.netIndex.get(key);
    if (existing) {
      for (const ep of endpoints) {
        if (!existing.endpoints.some((e) => e.path === ep.path && e.kind === ep.kind)) existing.endpoints.push(ep);
      }
      return;
    }
    const net: Net = { name: netName, scope, kind, endpoints, loc };
    this.nets.push(net);
    this.netIndex.set(key, net);
  }

  private endpointFor(kind: Net['kind'], path: string, loc: SourceLocation): NetEndpoint {
    const intf = kind === 'interface';
    if (!path.includes('/')) {
      const known = intf ? this.intfPortIndex.has(path) : this.portIndex.has(path);
      if (!known) this.diag('warning', `Net endpoint "${path}" is not a declared ${intf ? 'interface port' : 'port'}.`, loc);
      return { path, kind: intf ? 'intfPort' : 'port' };
    }
    const pin = intf ? this.ensureIntfPin(path, loc) : this.ensurePin(path, loc);
    if (!pin) this.diag('warning', `Net endpoint "${path}" refers to unknown cell "${parentPath(path)}".`, loc);
    return { path, kind: intf ? 'intfPin' : 'pin' };
  }

  private synthesizeNetName(scope: string, kind: Net['kind'], endpoints: NetEndpoint[]): string {
    const first = endpoints[0]?.path ?? 'net';
    const rel = scope && first.startsWith(`${scope}/`) ? first.slice(scope.length + 1) : first;
    const base = rel.replace(/\//g, '_');
    let candidate = base;
    for (let i = 1; this.netIndex.has(`${scope}\u0000${kind}\u0000${candidate}`); i++) candidate = `${base}_${i}`;
    return candidate;
  }

  // ------------------------------------------------------------ properties / addresses

  /** Apply properties; returns false when the target object does not exist. */
  setProperties(target: PropertyTarget, props: [string, string][], loc: SourceLocation): boolean {
    let bag: Record<string, string> | undefined;
    switch (target.kind) {
      case 'cell':
        bag = this.cellIndex.get(target.path)?.properties;
        break;
      case 'port':
      case 'intfPort': {
        const port = target.kind === 'port' ? this.portIndex.get(target.path) : this.intfPortIndex.get(target.path);
        if (port) bag = port.properties ??= {};
        break;
      }
      case 'pin':
      case 'intfPin': {
        const pin = target.kind === 'pin' ? this.ensurePin(target.path, loc) : this.ensureIntfPin(target.path, loc);
        if (pin) bag = pin.properties ??= {};
        break;
      }
    }
    if (!bag) return false;
    for (const [k, v] of props) bag[k] = v;
    return true;
  }

  getProperty(path: string, key: string): string {
    const cell = this.cellIndex.get(path);
    if (path === '' || cell) {
      const upper = key.toUpperCase();
      if (upper === 'TYPE') return path === '' ? 'hier' : cell?.kind === 'module' ? 'module_ref' : (cell?.kind ?? '');
      if (upper === 'NAME') return path === '' ? '/' : (cell?.name ?? '');
      if (upper === 'VLNV') return cell?.vlnv ?? '';
      return cell?.properties[key] ?? '';
    }
    return (this.portIndex.get(path) ?? this.intfPortIndex.get(path))?.properties?.[key] ?? '';
  }

  addAddress(a: AddressAssignment): void {
    this.addresses.push(a);
  }

  // ------------------------------------------------------------ finish

  /** Fill in interface modes of inferred interface pins from their peers. */
  private inferIntfModes(): void {
    const intfPinIndex = new Map<string, IntfPin>();
    for (const c of this.cells) for (const p of c.intfPins) intfPinIndex.set(p.path, p);
    const lookup = (ep: NetEndpoint): IntfPin | undefined =>
      ep.kind === 'intfPort' ? this.intfPortIndex.get(ep.path) : intfPinIndex.get(ep.path);
    const isBoundary = (ep: NetEndpoint, scope: string): boolean => ep.kind === 'intfPort' || parentPath(ep.path) === scope;

    for (let pass = 0, changed = true; changed && pass < 16; pass++) {
      changed = false;
      for (const net of this.nets) {
        if (net.kind !== 'interface') continue;
        for (const ep of net.endpoints) {
          const pin = lookup(ep);
          if (!pin || !pin.inferred || pin.mode) continue;
          for (const other of net.endpoints) {
            const peer = other === ep ? undefined : lookup(other);
            if (!peer?.mode) continue;
            // A boundary pin passes its mode through to the inside; peers facing each other are opposite.
            const passThrough = isBoundary(ep, net.scope) !== isBoundary(other, net.scope);
            const mode = passThrough ? peer.mode : OPPOSITE_MODE[peer.mode];
            if (!mode) continue;
            pin.mode = mode;
            if (!pin.vlnv && peer.vlnv) pin.vlnv = peer.vlnv;
            changed = true;
            break;
          }
        }
      }
    }
  }

  /** Warn about nets whose endpoints are not in the net's own scope. */
  private checkNetScopes(): void {
    for (const net of this.nets) {
      const bad = net.endpoints.find((ep) => {
        if (ep.kind === 'port' || ep.kind === 'intfPort') return net.scope !== '';
        const owner = parentPath(ep.path);
        return owner !== net.scope && parentPath(owner) !== net.scope;
      });
      if (bad) {
        this.diag(
          'warning',
          `Net "${net.name}" in scope "${net.scope || '/'}" touches "${bad.path}", which is outside that scope.`,
          net.loc,
        );
      }
    }
  }

  toDesign(fallbackName: string): Design {
    this.inferIntfModes();
    this.checkNetScopes();
    const hasTool = Object.values(this.tool).some((v) => v !== undefined);
    return {
      name: this.designName || fallbackName,
      sourceFormat: 'vivado-bd-tcl',
      sourceFile: this.file,
      ...(hasTool ? { tool: { ...this.tool } } : {}),
      ports: this.ports,
      intfPorts: this.intfPorts,
      cells: this.cells,
      nets: this.nets,
      addressAssignments: this.addresses,
      diagnostics: this.diagnostics,
    };
  }
}

/** Add a declared pin, or upgrade an inferred one. Returns undefined on a duplicate declaration. */
function declarePin(list: Pin[], path: string, spec: PinSpec, loc: SourceLocation): Pin | undefined {
  const found = list.find((p) => p.name === spec.name);
  if (found && !found.inferred) return undefined;
  const pin: Pin = found ?? { name: spec.name, path };
  delete pin.inferred;
  if (spec.dir) pin.dir = spec.dir;
  if (spec.type) pin.type = spec.type;
  if (spec.from !== undefined) pin.from = spec.from;
  if (spec.to !== undefined) pin.to = spec.to;
  if (spec.properties) pin.properties = { ...pin.properties, ...spec.properties };
  pin.loc = loc;
  if (!found) list.push(pin);
  return pin;
}

function declareIntfPin(list: IntfPin[], path: string, spec: IntfPinSpec, loc: SourceLocation): IntfPin | undefined {
  const found = list.find((p) => p.name === spec.name);
  if (found && !found.inferred) return undefined;
  const pin: IntfPin = found ?? { name: spec.name, path };
  delete pin.inferred;
  if (spec.mode) pin.mode = spec.mode;
  if (spec.vlnv) pin.vlnv = spec.vlnv;
  pin.loc = loc;
  if (!found) list.push(pin);
  return pin;
}
