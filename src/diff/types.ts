/**
 * Semantic diff between two `Design`s (base -> head). Objects are matched by
 * their hierarchical path, so a renamed cell shows up as removed + added.
 */

export type ChangeKind = 'added' | 'removed' | 'modified';

export interface PropertyChange {
  /** Cell path (or `""` for design-level metadata). */
  path: string;
  key: string;
  before?: string;
  after?: string;
}

export interface EntityChange {
  path: string;
  kind: ChangeKind;
  /** Human-readable explanation of what changed, for the change list panel. */
  detail?: string;
  /**
   * Pins / ports only: true when the object exists only because the adapter
   * reconstructed it from connectivity (`inferred: true` on the side where it
   * exists). Such changes are artifacts of a net change and never mark the
   * owning cell modified.
   */
  inferred?: boolean;
}

export interface NetChange extends EntityChange {
  scope: string;
  name: string;
  addedEndpoints?: string[];
  removedEndpoints?: string[];
}

/**
 * A net that exists on both sides with an identical endpoint set but a
 * different name (Vivado renames auto-generated nets freely). Not a change.
 */
export interface NetRename {
  scope: string;
  kind: 'signal' | 'interface';
  baseName: string;
  headName: string;
}

/** Counts produced by `countChangesUnder`. */
export interface ChangeCounts {
  added: number;
  removed: number;
  modified: number;
  total: number;
}

export interface DesignDiff {
  baseLabel: string;
  headLabel: string;
  cells: EntityChange[];
  pins: EntityChange[];
  ports: EntityChange[];
  nets: NetChange[];
  properties: PropertyChange[];
  addressAssignments: EntityChange[];
  /** Nets matched by identical endpoints despite a name change (informational, not changes). */
  netRenames?: NetRename[];
  summary: {
    cellsAdded: number;
    cellsRemoved: number;
    cellsModified: number;
    netsAdded: number;
    netsRemoved: number;
    netsModified: number;
    propertiesChanged: number;
    /** Entries in `pins` (including inferred ones). */
    pinsChanged?: number;
    /** Entries in `ports` (ports and interface ports). */
    portsChanged?: number;
    addressAssignmentsChanged?: number;
  };
}

/** Quick lookups the webview builds from a `DesignDiff`. */
export interface DiffIndex {
  cells: Map<string, ChangeKind>;
  pins: Map<string, ChangeKind>;
  ports: Map<string, ChangeKind>;
  /** keyed by `scope + '::' + netName` */
  nets: Map<string, ChangeKind>;
  /** keyed by `masterSpace + ' -> ' + slaveSegment` */
  addressAssignments?: Map<string, ChangeKind>;
  /** Property changes grouped by owner path (`""` = design-level). */
  properties?: Map<string, PropertyChange[]>;
}
