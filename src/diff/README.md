# Semantic diff engine (`src/diff`)

Compares two `Design` models (base -> head) and produces a `DesignDiff`: a
stable, sorted list of changes plus summary counts. The renderer turns it into
O(1) lookups with `buildDiffIndex`.

The module is pure TypeScript with no Node or VS Code APIs, so the extension
host and the webview can both import it. Keep it that way.

## Public API (`index.ts`)

| Export | Purpose |
| --- | --- |
| `diffDesigns(base, head, { baseLabel, headLabel })` | Compute the diff. |
| `buildDiffIndex(diff)` | Maps for the renderer (see `DiffIndex` in `types.ts`). |
| `countChangesUnder(diff, hierPath)` | Added/removed/modified counts inside a hier cell, for badges. |
| `isEmptyDiff(diff)` | True when nothing changed (net renames do not count). |
| `normalizeValue(v)` | The value normalisation used for properties, offsets and ranges. |
| `netKey(scope, name)` | `scope + '::' + name`, the `DiffIndex.nets` key. |
| `addressKey(a)` | `masterSpace + ' -> ' + slaveSegment`, the address assignment path. |
| all types from `types.ts` | `DesignDiff`, `DiffIndex`, `EntityChange`, ... |

## Matching rules

| Object | Matched by |
| --- | --- |
| Cell | absolute `path` |
| Pin / interface pin | absolute `path` (pins and interface pins share one namespace per cell) |
| Port / interface port | `path` (the port name) |
| Address assignment | `masterSpace -> slaveSegment` |
| Net | 1. `scope + name` with the same `kind`; 2. otherwise, identical endpoint set + same `scope` + same `kind` |

A renamed cell, pin or port therefore shows up as removed + added.

The second net pass exists because Vivado renames auto-generated nets
(`Net6`, `xlconstant_0_dout`, ...) freely. A net whose endpoints are identical
but whose name differs is **not** a change; the pair is recorded in
`diff.netRenames` for information only. Endpoint order and duplicates are
ignored (endpoints are compared as a set of paths). If several unmatched nets
share the same signature, they are paired in name order.

## What counts as a change

**Cells** are `modified` when any of these differ:

- `kind`, `vlnv`, `reference`
- any property (each one is listed in `diff.properties` with `before`/`after`)
- the declared pin set, or a declared pin's attributes:
  `dir`, `type`, `from`/`to` (pins); `mode`, `vlnv` (interface pins);
  pin vs interface pin

Pins with `inferred: true` are reconstructed by the adapter from net
connections. When they appear or disappear they are still listed in
`diff.pins` (with `inferred: true` and detail `"inferred from connectivity"`)
so the renderer can colour them, but they never mark the cell modified: the
net change that caused them is already reported. Attributes are only compared
when the pin is declared on both sides.

Pins of added/removed cells are not listed individually; the whole cell is.

A hierarchical cell is **not** marked modified because something inside it
changed. Use `countChangesUnder` for "N changes inside" badges.

**Nets**: `modified` when the endpoint set differs (`addedEndpoints` /
`removedEndpoints`, sorted); otherwise `added` / `removed`. A net whose kind
changes (signal <-> interface) is reported as removed + added; in
`DiffIndex.nets` the two collapse to `modified` under the shared key.
Removed nets are keyed by their base scope/name.

**Ports**: added / removed / modified (`dir`, `type`, width, mode, vlnv,
properties if the model ever carries them).

**Address assignments**: added / removed / modified (`offset`, `range`).

**Design metadata**: `design.tool` fields are compared as properties on path
`""` with keys `tool.name`, `tool.version`, `tool.part`, `tool.board`.

**Ignored everywhere**: `loc`, `diagnostics`, `sourceFile`, source order.

### Value normalisation

Property values, offsets and ranges are compared after `normalizeValue`: trim
whitespace, then strip one pair of outer braces and trim again. So `{100}`,
` 100 ` and `100` are equal; `{{a}}` becomes `{a}`. The raw values are kept in
`before`/`after`.

## countChangesUnder(diff, hierPath)

Counts, strictly inside `hierPath`:

- descendant cells (not `hierPath` itself),
- declared pins of descendant cells (not `hierPath`'s own boundary pins, and
  not inferred pins),
- nets whose scope is `hierPath` or a descendant scope.

For the root (`""`) it additionally counts ports, address assignments and
design-level property changes. Cell property changes are not counted on their
own; the owning cell's `modified` entry already represents them.

## Output ordering

Every list is sorted by `path` (properties by `path`, then `key`; for equal
paths `removed` precedes `added` precedes `modified`), so the output does not
depend on source order and the change list is stable.

## Adding a new compared attribute

1. If it is a new field on the model, decide which object owns it.
2. Add the comparison in the matching function in `index.ts`:
   - cell-level: `diffCells` (push a reason string into `reasons`);
   - pin/port-level: `pinAttrDiffs` (return a description string);
   - net-level: `diffNets`;
   - address assignments: `diffAddressAssignments`;
   - design-level metadata: `toolProps` (or a similar `Record<string,string>`
     fed to `diffProperties` with path `""`).
3. Use `sameValue` for free-form strings that may carry TCL braces.
4. If the attribute is presentation-only (like `loc`), do not compare it.
5. Add a case in `test/diff-engine.test.ts` and a line to this README.
