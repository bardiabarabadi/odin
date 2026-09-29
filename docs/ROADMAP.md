# Roadmap

Odin's long-term goal is to visualize FPGA sources of all kinds (block-design
exports, HDL, constraints, build scripts) inside the editor, and to make
changes between revisions understandable at a glance.

## Done

* Vivado block-design TCL export (`write_bd_tcl`) adapter.
* Interactive schematic: drill-in hierarchy, pins, interface nets, search,
  clock/reset and unconnected-pin filters, properties panel, click-to-source,
  SVG export.
* Compare against any git revision with an in-diagram overlay and a change
  list.

## Next

* **Vivado `.bd` JSON adapter.** Richer than the TCL export (full IP pin lists,
  layout hints). Merge with the TCL model when both are present.
* **XDC constraints view.** Pin-planner style table and a physical/IO bank
  view; cross-link constraint ports to block-design ports.
* **HDL structure.** Module hierarchy and instance graph for VHDL /
  Verilog / SystemVerilog, reusing the same design model with `module` cells.
* **Address map panel.** Render `AddressAssignment` entries as a memory map.
* **Layout persistence.** Remember manual node positions per design.
* **Web extension build.** Run in vscode.dev / github.dev (the parser and
  renderer are already Node-free; only git access needs a fallback).
* **Marketplace and Open VSX publishing.**

## Ideas

* Highlight timing or utilization data on top of the schematic.
* Export to Mermaid / draw.io for documentation pipelines.
* "Explain this change" summaries for pull requests, generated from the diff
  engine's structured output.
