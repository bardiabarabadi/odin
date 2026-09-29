/**
 * Odin common design model.
 *
 * Every source-format adapter (Vivado block-design TCL today; .bd JSON, XDC,
 * HDL netlists in the future) produces an instance of `Design`. The renderer,
 * the diff engine and the extension host only ever consume this model, never
 * the raw source format.
 *
 * Path conventions
 * ----------------
 * - Every object is identified by a hierarchical path with `/` separators and
 *   NO leading slash. The design root is the empty string `""`.
 * - A cell path is `parentPath + "/" + cellName` (or just `cellName` at root).
 * - A pin or interface pin path is `cellPath + "/" + pinName`. This is the same
 *   whether the pin is referenced from inside or outside its hierarchical cell.
 * - A top-level port path is just the port name.
 * - Nets live in exactly one hierarchy scope (`Net.scope`, a cell path or `""`)
 *   and may only connect pins of that scope's direct children plus the scope's
 *   own boundary pins (or top-level ports when the scope is the root).
 */

export interface SourceLocation {
  /** URI or path of the source file, as given to the adapter. */
  file: string;
  /** 1-based line number of the statement that created the object. */
  line: number;
  /** 1-based last line when the statement spans several lines. */
  endLine?: number;
}

export type PinDirection = 'I' | 'O' | 'IO';

/**
 * Vivado's `-type` on pins/ports. Anything else is preserved verbatim as a
 * string so adapters never lose information.
 */
export type PinType = 'clk' | 'rst' | 'data' | 'intr' | 'ce' | 'clkEn' | 'undef' | (string & Record<never, never>);

export interface Pin {
  name: string;
  /** Absolute path, `cellPath/pinName` (or `pinName` for a top-level port). */
  path: string;
  dir?: PinDirection;
  type?: PinType;
  /** Vector bounds from `-from N -to M`. Scalar pins have neither. */
  from?: number;
  to?: number;
  /**
   * True when the pin was never declared in the source (typical for IP cells
   * in a TCL export, where only nets mention the pin) and was reconstructed
   * from its connections.
   */
  inferred?: boolean;
  /** Properties set on the pin/port (e.g. `CONFIG.FREQ_HZ`), key -> raw string value. */
  properties?: Record<string, string>;
  loc?: SourceLocation;
}

export type IntfMode = 'Master' | 'Slave' | 'Monitor' | 'MirroredMaster' | 'MirroredSlave' | 'System' | (string & Record<never, never>);

export interface IntfPin {
  name: string;
  path: string;
  mode?: IntfMode;
  /** Interface VLNV, e.g. `xilinx.com:interface:aximm_rtl:1.0`. */
  vlnv?: string;
  inferred?: boolean;
  /** Properties set on the interface pin/port, key -> raw string value. */
  properties?: Record<string, string>;
  loc?: SourceLocation;
}

/** Top-level ports share the pin shape; they sit at the design boundary. */
export type Port = Pin;
export type IntfPort = IntfPin;

export type CellKind =
  /** Packaged IP identified by VLNV. */
  | 'ip'
  /** RTL module reference (`create_bd_cell -type module -reference`). */
  | 'module'
  /** Hierarchical container that holds other cells. */
  | 'hier'
  /** Anything the adapter could not classify. */
  | 'unknown';

export interface Cell {
  name: string;
  /** Absolute hierarchical path, e.g. `io_subsystem/axi_gpio_0`. */
  path: string;
  /** Path of the containing hierarchical cell, `""` for root-level cells. */
  parent: string;
  kind: CellKind;
  /** IP VLNV, for `kind === 'ip'`. */
  vlnv?: string;
  /** Referenced RTL module name, for `kind === 'module'`. */
  reference?: string;
  /** `CONFIG.*` and other properties set on the cell, key -> raw string value. */
  properties: Record<string, string>;
  pins: Pin[];
  intfPins: IntfPin[];
  loc?: SourceLocation;
}

export type EndpointKind = 'pin' | 'port' | 'intfPin' | 'intfPort';

export interface NetEndpoint {
  /** Absolute path of the pin / port this net touches. */
  path: string;
  kind: EndpointKind;
}

export interface Net {
  name: string;
  /** Hierarchy scope the net was declared in: a hier-cell path or `""`. */
  scope: string;
  /** `'signal'` for `connect_bd_net`, `'interface'` for `connect_bd_intf_net`. */
  kind: 'signal' | 'interface';
  endpoints: NetEndpoint[];
  loc?: SourceLocation;
}

export interface AddressAssignment {
  /** Master address space, e.g. `microblaze_0/Data`. */
  masterSpace: string;
  /** Slave segment, e.g. `io_subsystem/axi_gpio_0/S_AXI/Reg`. */
  slaveSegment: string;
  offset?: string;
  range?: string;
  loc?: SourceLocation;
}

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  loc?: SourceLocation;
}

export type SourceFormat = 'vivado-bd-tcl' | (string & Record<never, never>);

export interface Design {
  /** Design name, e.g. `top`. */
  name: string;
  sourceFormat: SourceFormat;
  /** Primary source file the design was read from. */
  sourceFile: string;
  /** Tool metadata when the source carries it. */
  tool?: { name?: string; version?: string; part?: string; board?: string };
  ports: Port[];
  intfPorts: IntfPort[];
  /** Every cell at every hierarchy level, flat. Order follows the source. */
  cells: Cell[];
  nets: Net[];
  addressAssignments: AddressAssignment[];
  diagnostics: Diagnostic[];
}
