# The common design model

Every source format Odin understands is converted into one in-memory model,
defined in [`src/model/types.ts`](../src/model/types.ts). The renderer, the
diff engine and the extension host consume only this model. That is the
contract that lets new formats (Vivado `.bd` JSON, XDC constraints, HDL
netlists) plug in without touching the UI.

## Objects

| Object | Meaning | Identified by |
| --- | --- | --- |
| `Design` | One block design: name, tool metadata, and flat lists of everything below | `name`, `sourceFile` |
| `Cell` | An instance: packaged IP (`ip`), RTL module reference (`module`), or hierarchical container (`hier`) | `path` |
| `Pin` / `IntfPin` | A signal pin or a bundled interface pin (AXI, clocks, GT, …) on a cell | `path` |
| `Port` / `IntfPort` | The design's external boundary; same shape as pins | `path` (just the name) |
| `Net` | A signal (`connect_bd_net`) or interface (`connect_bd_intf_net`) connection | `scope` + `name` |
| `AddressAssignment` | Memory-map entry from a master address space to a slave segment | master + segment |
| `Diagnostic` | Parser warnings/errors with an optional source location | — |

## Path conventions

Paths use `/` separators and **no leading slash**. The root scope is `""`.

```
""                                  root (design)
io_subsystem                        hier cell at root
io_subsystem/axi_gpio_0             IP cell inside the hier
io_subsystem/axi_gpio_0/s_axi_aclk  pin on that IP
io_subsystem/s_axi_aclk             boundary pin of the hier cell
sys_clock                           top-level port
```

A boundary pin has the same path whether it is referenced from inside or
outside its hierarchical cell. That single identity is what makes drill-in
navigation and the diff engine simple.

## Net scoping

A net belongs to exactly one hierarchy scope (`Net.scope`). It may only touch:

* pins of cells that are **direct children** of the scope, and
* the scope's own boundary pins (or top-level ports when the scope is the root).

Connectivity across hierarchy levels is therefore expressed as two nets: one
inside the hier cell ending at a boundary pin, one outside starting at that
same boundary pin. This mirrors how block-design tools store connectivity and
lets the renderer draw one scope at a time without tracing through hierarchy.

## Inferred pins

Exported scripts usually declare pins only for hierarchical cells and ports.
Pins of packaged IP are known to the tool but not written out. Adapters
therefore create pins the first time a net mentions them and mark them
`inferred: true`. Inferred pins carry no direction unless it can be deduced;
the renderer places undirected pins on the left of a block and the diff engine
does not treat inferred-pin churn as a change to the cell itself.

## Source locations

Every object carries `loc` (file, 1-based `line`, optional `endLine`) pointing
at the statement that created it. Click-to-source in the diagram, diagnostics
navigation, and future "edit in place" features all rely on it.

## Extending the model

* Prefer **optional** fields so existing adapters and fixtures keep working.
* Keep the model free of tool-specific vocabulary; put raw tool values into
  `properties` (a string map) rather than adding typed fields per tool.
* If you add a field the diff engine should compare, update
  [`src/diff`](../src/diff/README.md) and its tests in the same change.
