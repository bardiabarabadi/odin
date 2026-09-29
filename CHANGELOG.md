# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-29

### Added

- Interactive diagram of Vivado block designs exported with `write_bd_tcl`,
  opened beside the source file (`Odin: Visualize Block Design`,
  `Ctrl+Alt+O` / `Cmd+Alt+O`) or via *Open With… > Odin Block Design*.
- Navigation into hierarchical cells, and jump from any cell, pin or net to the
  TCL line that created it.
- Comparison against any git revision (`Odin: Compare Block Design With Git
  Revision…`): HEAD, HEAD~1, the upstream branch, recent commits touching the
  file, branches, tags or a typed revision. Added, removed and modified cells,
  pins, nets and properties are highlighted.
- Automatic refresh on save, including recomputing an active comparison.
- Export of the current diagram as SVG.
- Pins whose direction the export leaves out (typical for packaged IP) are
  placed using their name and their connections; the Properties panel marks
  such values as guessed, e.g. `I (guessed)`.
- A file that cannot be parsed at all shows the first error instead of an
  empty diagram; partial problems are listed in the diagram's warning
  indicator.
- Settings: `odin.autoRefreshOnSave`, `odin.hideClockResetNetsByDefault`,
  `odin.hideUnconnectedPinsByDefault`, `odin.compare.defaultRef`,
  `odin.git.path`.

[Unreleased]: https://github.com/bardiabarabadi/odin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bardiabarabadi/odin/releases/tag/v0.1.0
