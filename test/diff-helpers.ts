/** Tiny in-code builder for diff tests (no dependency on any adapter). */
import type {
  AddressAssignment,
  Cell,
  CellKind,
  Design,
  EndpointKind,
  IntfPin,
  Net,
  Pin,
} from '../src/model/types';

export function design(partial: Partial<Design> = {}): Design {
  return {
    name: 'top',
    sourceFormat: 'vivado-bd-tcl',
    sourceFile: 'top.tcl',
    ports: [],
    intfPorts: [],
    cells: [],
    nets: [],
    addressAssignments: [],
    diagnostics: [],
    ...partial,
  };
}

export interface CellOpts {
  kind?: CellKind;
  vlnv?: string;
  reference?: string;
  properties?: Record<string, string>;
  pins?: Array<Omit<Pin, 'path'>>;
  intfPins?: Array<Omit<IntfPin, 'path'>>;
  line?: number;
}

export function cell(path: string, opts: CellOpts = {}): Cell {
  const i = path.lastIndexOf('/');
  const c: Cell = {
    name: i < 0 ? path : path.slice(i + 1),
    path,
    parent: i < 0 ? '' : path.slice(0, i),
    kind: opts.kind ?? 'ip',
    properties: opts.properties ?? {},
    pins: (opts.pins ?? []).map((p) => ({ ...p, path: `${path}/${p.name}` })),
    intfPins: (opts.intfPins ?? []).map((p) => ({ ...p, path: `${path}/${p.name}` })),
    loc: { file: 'top.tcl', line: opts.line ?? 1 },
  };
  if (opts.vlnv !== undefined) c.vlnv = opts.vlnv;
  if (opts.reference !== undefined) c.reference = opts.reference;
  return c;
}

/** `endpoints` are paths; a path with no `/` is treated as a top-level port. */
export function net(scope: string, name: string, endpoints: string[], kind: Net['kind'] = 'signal', line = 1): Net {
  return {
    name,
    scope,
    kind,
    endpoints: endpoints.map((path) => {
      const top = !path.includes('/');
      const epKind: EndpointKind =
        kind === 'signal' ? (top ? 'port' : 'pin') : top ? 'intfPort' : 'intfPin';
      return { path, kind: epKind };
    }),
    loc: { file: 'top.tcl', line },
  };
}

export function port(name: string, extra: Partial<Pin> = {}): Pin {
  return { name, path: name, ...extra };
}

export function addr(masterSpace: string, slaveSegment: string, offset?: string, range?: string): AddressAssignment {
  return { masterSpace, slaveSegment, offset, range };
}

/** Deep clone so tests can mutate a copy of a base design. */
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
